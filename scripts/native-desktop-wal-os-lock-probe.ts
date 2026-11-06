/**
 * Test-only Node bundle for a genuine Obsidian-created encrypted WAL.
 * Opens the already-existing WAL through the production Desktop recovery
 * owner boundary; never imports the writer or calls GitHub or Cutover.
 *
 * "parent" starts two separate child Node processes: the first holds the
 * OS-exclusive recovery lock, the second must reject the competing open.
 * Releases the lock, reopens the original WAL and checks encrypted slot bytes.
 */
import * as assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import * as path from "node:path"
import { openV4DesktopPluginWalForRecovery } from "../src/lib/v4/reencryption-desktop-plugin-wal-recovery"
import { planV4PluginPrivateWalLocation } from "../src/lib/v4/reencryption-plugin-wal-location"

const RUN_ID = "D287NativeWalEvidence"
const PLUGIN_ID = "encrypted-github-sync-multi-platform"
const CONFIG_DIR = ".obsidian"
const HASH = /^[0-9a-f]{64}$/u
const mode = process.argv[2] ?? ""
let phase = "initial"
const vault = process.argv[3] ?? ""
const expected = [process.argv[4] ?? "", process.argv[5] ?? ""]

async function ownerContext() {
  phase = "physical-owner-context"
  assert.ok(path.isAbsolute(vault) && path.resolve(vault) === vault,
    "WAL probe requires a canonical isolated Vault path")
  assert.deepEqual(await realpath(vault), vault,
    "WAL probe refuses a redirected physical Vault")
  const info = await lstat(vault)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(),
    "WAL probe requires a real Vault directory")
  assert.ok(expected.every(digest => HASH.test(digest)),
    "WAL probe requires pinned original encrypted-slot checksums")
  const layout = await planV4PluginPrivateWalLocation({
    configDir: CONFIG_DIR, pluginId: PLUGIN_ID, runId: RUN_ID,
  })
  const root = path.join(vault, ...layout.vaultLogicalWalRoot.split("/"))
  const walRoot = layout.journalRoot
  return { root, walRoot, files: [path.join(root, "slot-0.json"), path.join(root, "slot-1.json")] }
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function verifyPhysicalFiles(files: readonly string[]) {
  const bytes = await Promise.all(files.map(file => readFile(file)))
  for (const [i, data] of bytes.entries()) {
    assert.equal(sha(data), expected[i], "Recovery changed an original encrypted WAL slot")
  }
}

async function openExisting() {
  const context = await ownerContext()
  phase = "open-existing-only-recovery"
  let ownerLive = true
  const adapter = {
    getFullPath(relative: string): string {
      return relative ? path.join(vault, ...relative.split("/")) : vault
    },
  }
  const reader = await openV4DesktopPluginWalForRecovery({
    adapter, configDir: CONFIG_DIR, pluginId: PLUGIN_ID, runId: RUN_ID,
    assertLiveOwner() {
      if (!ownerLive) throw Error("Test-only WAL owner lost")
    },
  })
  return {
    ...context,
    reader,
    abandonOwner() { ownerLive = false },
  }
}

async function verifyReader(opened: Awaited<ReturnType<typeof openExisting>>) {
  phase = "read-encrypted-slots-under-lock"
  await opened.reader.assertExclusiveStageLease()
  const logical = opened.walRoot
  for (let i = 0; i < 2; i++) {
    const file = logical + "/slot-" + i + ".json"
    assert.equal(await opened.reader.adapter.exists(file), true)
    const text = await opened.reader.adapter.read(file)
    assert.equal(sha(new TextEncoder().encode(text)), expected[i],
      "Desktop OS-lock reader did not return the original encrypted WAL")
  }
  assert.equal(await opened.reader.assertBestEffortCheckpoint(),
    "best-effort-readback-only", "Reader must not claim power-loss durability")
}

async function runHolder() {
  const opened = await openExisting()
  try {
    await verifyReader(opened)
    process.stdout.write(JSON.stringify({ phase: "held" }) + "\n")
    process.stdin.resume()
    // Fail safe if the parent dies; lock cleanup is tied to this process.
    await Promise.race([
      once(process.stdin, "data"),
      new Promise((_, reject) => setTimeout(
        () => reject(Error("OS-lock probe holder release timed out")), 16_000)),
    ])
    await verifyReader(opened)
  } finally {
    await opened.reader.release()
  }
}

async function runCompeting() {
  let blocked = false
  let opened: Awaited<ReturnType<typeof openExisting>> | undefined
  try {
    opened = await openExisting()
  } catch (error) {
    blocked = error instanceof Error && error.name === "V4DesktopRekeyWalLockError"
  } finally {
    await opened?.reader.release()
  }
  assert.equal(blocked, true,
    "A second Node process must not open the WAL while another holds its OS lock")
  console.log(JSON.stringify({ competingProcessBlocked: true }))
}

function readFirstJson(line: string) {
  return JSON.parse(line.trim()) as Record<string, unknown>
}

async function waitForHolderReady(holder: ReturnType<typeof spawn>): Promise<void> {
  let output = ""
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Desktop WAL holder did not become ready")), 13_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      const end = output.indexOf("\n")
      if (end < 0) return
      clearTimeout(timeout)
      holder.stdout?.off("data", onData)
      try {
        assert.equal(readFirstJson(output.slice(0, end)).phase, "held")
        resolve()
      } catch (error) { reject(error) }
    }
    holder.stdout?.on("data", onData)
    holder.once("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
    holder.once("exit", code => {
      if (code !== null) {
        clearTimeout(timeout)
        reject(Error("Desktop WAL holder exited before acquiring the lock"))
      }
    })
  })
}

async function runParent() {
  phase = "parent-start"
  const physical = await ownerContext()
  const initialFiles = (await readdir(path.dirname(physical.files[0]!))).sort()
  assert.deepEqual(initialFiles, ["slot-0.json", "slot-1.json"],
    "Recovery probe requires exactly the two existing encrypted slots")
  await verifyPhysicalFiles(physical.files)
  phase = "spawn-holder"
  const args = [__filename, "holder", vault, ...expected]
  const holder = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  })
  let released = false
  try {
    await waitForHolderReady(holder)
    phase = "second-process-contention"
    const contention = spawnSync(process.execPath,
      [__filename, "competing", vault, ...expected],
      { encoding: "utf8", timeout: 13_000, windowsHide: true })
    assert.equal(contention.status, 0, "Competing WAL reader did not refuse OS-lock contention")
    assert.equal(readFirstJson(contention.stdout).competingProcessBlocked, true)
    await verifyPhysicalFiles(physical.files)
    phase = "release-held-lock"
    holder.stdin?.end("release\n")
    if (holder.exitCode === null) {
      const [code] = await once(holder, "exit")
      assert.equal(code, 0, "Desktop WAL holder did not release its lock cleanly")
    } else {
      assert.equal(holder.exitCode, 0)
    }
    released = true
    phase = "reopen-after-release"
    const reopened = await openExisting()
    try {
      await verifyReader(reopened)
      await verifyPhysicalFiles(physical.files)
    } finally {
      await reopened.reader.release()
    }
    assert.deepEqual((await readdir(path.dirname(physical.files[0]!))).sort(),
      ["slot-0.json", "slot-1.json"],
      "Recovery must release the temporary lock and leave only original WAL slots")
    console.log(JSON.stringify({
      status: "PASS",
      firstProcessHeldOSLock: true,
      secondProcessBlocked: true,
      releasedAndReopened: true,
      encryptedSlotsPreserved: true,
      nativeObsidianPhysicalWal: true,
      remoteGitHubUsed: false,
      cutoverAuthorized: false,
      powerLossDurabilityProven: false,
    }))
  } finally {
    if (!released && holder.exitCode === null) {
      try { holder.stdin?.end("release\n") } catch {}
      holder.kill()
    }
  }
}

async function main(): Promise<void> {
  if (mode === "holder") await runHolder()
  else if (mode === "competing") await runCompeting()
  else if (mode === "parent") await runParent()
  else throw Error("Invalid isolated WAL OS-lock test operation")
}

void main().catch(() => {
  // Do not print physical file contents, secret bytes or error objects.
  process.stderr.write("Native Desktop WAL OS-lock probe failed at " + mode + ":" + phase + "\n")
  process.exitCode = 1
})
