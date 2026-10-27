import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { build } from "esbuild"

const root = process.cwd()
const outputRoot = path.join(root, ".tmp")

function run(worker, args) {
  const result = spawnSync(process.execPath, [worker, ...args], {
    cwd: root, encoding: "utf8", timeout: 20000, windowsHide: true,
  })
  if (result.error) throw result.error
  return result
}

test("D117 real independent process SIGKILL retains encrypted two-slot WAL and non-reclaimable lock across phases", { timeout: 120000 }, async () => {
  await mkdir(outputRoot, { recursive: true })
  const isolated = await mkdtemp(path.join(outputRoot, "d117-killed-rekey-wal-"))
  const killedWorker = path.join(isolated, "kill-worker.mjs")
  const readerWorker = path.join(isolated, "forensic-reader.mjs")
  try {
    await build({
      entryPoints: [path.join(root, "tests/recovery/support/reencryption-wal-process-kill-child.ts")],
      outfile: killedWorker, bundle: true, platform: "node", format: "esm",
      target: "node22", logLevel: "silent",
    })
    await build({
      entryPoints: [path.join(root, "tests/recovery/support/reencryption-wal-forensic-reader.ts")],
      outfile: readerWorker, bundle: true, platform: "node", format: "esm",
      target: "node22", logLevel: "silent",
    })
    for (const [phase, generation] of [
      ["backup-intent", 2],
      ["blob-intent", 5],
      ["prepared-candidate", 8],
      ["destination-intent", 9],
      ["destination-readback", 10],
    ]) {
      const directory = path.join(isolated, "case-" + phase)
      await mkdir(directory)
      const killed = run(killedWorker, [directory, phase])
      assert.notEqual(killed.status, 0,
        `${phase}: SIGKILL unexpectedly exited successfully; ${killed.stderr}`)
      assert.equal(killed.stderr, "",
        `${phase}: child may have thrown rather than being terminated by SIGKILL`)
      const checkpoint = await readFile(path.join(directory, "d117-child-checkpoint.txt"), "utf8")
      assert.equal(checkpoint, String(generation), `${phase}: worker never reached its durable WAL checkpoint`)
      const wal = path.join(directory, "rekey", "wal")
      const lock = path.join(wal, ".exclusive.lock")
      assert.ok((await stat(lock)).isFile(), `${phase}: process exit must NOT clean up stale lock`)
      const files = (await readdir(wal)).sort()
      assert.deepEqual(files, [".exclusive.lock", "slot-0.json", "slot-1.json"])
      const storedBefore = await Promise.all(["slot-0.json", "slot-1.json"].map(async filename =>
        readFile(path.join(wal, filename), "utf8")))
      assert.ok(storedBefore.every(bytes => !bytes.includes("owner/repo#backup/d117")))
      assert.ok(storedBefore.every(bytes => !bytes.includes(".obsidian-github-sync-v4/data/aa/")))
      assert.ok(storedBefore.every(bytes => !bytes.includes("c".repeat(40))))
      // A DIFFERENT real Node process must refuse to acquire the stale
      // lease, not silently reclaim or overwrite it.
      const retry = run(killedWorker, [directory, "backup-intent"])
      assert.notEqual(retry.status, 0, `${phase}: stale lock was incorrectly reclaimed`)
      assert.match(retry.stderr, /V4DesktopRekeyWalLockError|exclusive lock/i)
      // A separate process may inspect authenticated WAL evidence READ-ONLY
      // for human recovery. This does not remove the stale lock or authorize
      // any GitHub network write, replay, or branch/key/index cutover.
      const inspect = run(readerWorker, [directory, String(generation)])
      assert.equal(inspect.status, 0, `${phase}: ${inspect.stderr}`)
      assert.match(inspect.stdout, new RegExp(`forensic-read-only-ok:${generation}`))
      const storedAfter = await Promise.all(["slot-0.json", "slot-1.json"].map(async filename =>
        readFile(path.join(wal, filename), "utf8")))
      assert.deepEqual(storedAfter, storedBefore, `${phase}: forensic inspection mutated durable evidence`)
      assert.deepEqual((await readdir(wal)).sort(), files)
    }
  } finally {
    // Only the test's own disposable .tmp tree; never reclaim production WAL.
    await rm(isolated, { recursive: true, force: true })
  }
})
