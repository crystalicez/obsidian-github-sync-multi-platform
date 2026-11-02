import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { openV4DesktopPluginWalForRecovery } from "../../src/lib/v4/reencryption-desktop-plugin-wal-recovery"
import { openV4NewDesktopPluginWalWriter } from "../../src/lib/v4/reencryption-desktop-plugin-wal-writer"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

const runId = "d243-new-wal-123456"
const configDir = ".obsidian"
const pluginId = "obsidian-encrypted-github-sync"
const sourceCommitSha = "a".repeat(40)
const destinationRepoId = "owner/repo#rekey/destination"
const key = new Uint8Array(32).fill(0x71)

async function fixture() {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const vault = await mkdtemp(path.join(process.cwd(), ".tmp", "d243-desktop-wal-"))
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const privateRoot = path.join(vault, ...layout.pluginStorageRoot.split("/"))
  const leaf = path.join(privateRoot, ...layout.journalRoot.split("/"))
  await mkdir(privateRoot, { recursive: true })
  let ownerLive = true
  let leaseLive = true
  let fenceArmed = true
  const adapter = {
    getFullPath(logical: string) { return path.join(vault, ...logical.split("/").filter(Boolean)) },
  }
  const input = {
    adapter, configDir, pluginId, runId,
    assertLiveOwner: () => { if (!ownerLive) throw Error("owner lost") },
    assertExclusiveInitiatorLease: async () => { if (!leaseLive) throw Error("lease lost") },
    assertSyncFenceArmed: async () => { if (!fenceArmed) throw Error("Sync Fence missing") },
  }
  return {
    vault, privateRoot, leaf, layout, input,
    loseOwner() { ownerLive = false },
    loseLease() { leaseLive = false },
    loseFence() { fenceArmed = false },
    restoreLease() { leaseLive = true },
  }
}

test("D243 creates encrypted WAL in owner-approved Desktop private root and independently recovers it", async () => {
  const f = await fixture()
  let writer: Awaited<ReturnType<typeof openV4NewDesktopPluginWalWriter>> | undefined
  let recovered: Awaited<ReturnType<typeof openV4DesktopPluginWalForRecovery>> | undefined
  try {
    writer = await openV4NewDesktopPluginWalWriter(f.input)
    assert.equal(writer.journalRoot, f.layout.journalRoot)
    assert.equal(writer.crashDurabilityProven, false)
    assert.equal(writer.resumeSyncAuthorized, false)
    assert.equal(writer.cutoverAuthorized, false)
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writer.adapter, root: writer.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey: key,
    })
    let state = await journal.begin()
    const initialGeneration = state.generation
    state = await journal.recordRefIntent({
      role: "backup", repoId: "owner/repo#rekey/backup",
      commitSha: sourceCommitSha, treeSha: "b".repeat(40),
    }, state.generation)
    assert.equal(state.generation, initialGeneration + 1)
    await writer.assertExclusiveStageLease()
    assert.equal(await writer.assertBestEffortCheckpoint(), "best-effort-readback-only")
    await writer.release()
    writer = undefined
    recovered = await openV4DesktopPluginWalForRecovery(f.input)
    const readonlyAdapter: V4LocalIndexAdapter = {
      read: name => recovered!.adapter.read(name),
      exists: name => recovered!.adapter.exists(name),
      async mkdir() { throw Error("recovery cannot mkdir") },
      async write() { throw Error("recovery cannot write") },
    }
    const after = createV4ReencryptionRecoveryJournal({
      adapter: readonlyAdapter, root: f.layout.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey: Uint8Array.from(key),
    })
    assert.deepEqual(await after.assertHealthySnapshot(state.generation), state)
    assert.equal(await recovered.assertBestEffortCheckpoint(), "best-effort-readback-only")
    assert.deepEqual((await readdir(f.leaf)).sort(),
      [".exclusive.lock", "slot-0.json", "slot-1.json"])
    await recovered.release()
    recovered = undefined
    assert.deepEqual((await readdir(f.leaf)).sort(), ["slot-0.json", "slot-1.json"])
  } finally {
    await recovered?.release()
    await writer?.release()
    await rm(f.vault, { recursive: true, force: true })
  }
})

test("D243 never reopens an existing empty or interrupted WAL directory for authoring", async () => {
  for (const existing of ["empty", "one-slot", "torn-temp"] as const) {
    const f = await fixture()
    try {
      await mkdir(f.leaf, { recursive: true })
      if (existing === "one-slot") await writeFile(path.join(f.leaf, "slot-0.json"), "previous")
      if (existing === "torn-temp") await writeFile(path.join(f.leaf, ".slot-torn.tmp"), "keep")
      const before = await readdir(f.leaf)
      await assert.rejects(openV4NewDesktopPluginWalWriter(f.input))
      assert.deepEqual(await readdir(f.leaf), before, existing)
      if (existing === "one-slot") {
        assert.equal(await readFile(path.join(f.leaf, "slot-0.json"), "utf8"), "previous")
      }
    } finally {
      await rm(f.vault, { recursive: true, force: true })
    }
  }
})

test("D243 cannot author WAL without both live initiating lease and persisted fence", async () => {
  for (const cause of ["lease", "fence", "owner"] as const) {
    const f = await fixture()
    try {
      if (cause === "lease") f.loseLease()
      if (cause === "fence") f.loseFence()
      if (cause === "owner") f.loseOwner()
      await assert.rejects(openV4NewDesktopPluginWalWriter(f.input))
      assert.deepEqual(await readdir(f.privateRoot), [], cause)
    } finally {
      await rm(f.vault, { recursive: true, force: true })
    }
  }
})

test("D243 lost fence or owner after the first encrypted WAL slot refuses another write", async () => {
  for (const cause of ["fence", "owner", "lease"] as const) {
    const f = await fixture()
    let writer: Awaited<ReturnType<typeof openV4NewDesktopPluginWalWriter>> | undefined
    try {
      writer = await openV4NewDesktopPluginWalWriter(f.input)
      await writer.adapter.write(f.layout.journalRoot + "/slot-0.json", "retained-evidence")
      if (cause === "fence") f.loseFence()
      if (cause === "lease") f.loseLease()
      if (cause === "owner") f.loseOwner()
      await assert.rejects(writer.adapter.write(f.layout.journalRoot + "/slot-1.json", "forbidden"))
      await assert.rejects(writer.assertBestEffortCheckpoint())
      assert.equal(await stat(path.join(f.leaf, "slot-1.json")).then(
        () => true, () => false), false)
      assert.equal(await readFile(path.join(f.leaf, "slot-0.json"), "utf8"), "retained-evidence")
      await writer.release()
      writer = undefined
      assert.deepEqual((await readdir(f.leaf)), ["slot-0.json"])
    } finally {
      await writer?.release()
      await rm(f.vault, { recursive: true, force: true })
    }
  }
})

test("D243 concurrent attempts for the same WAL have only one create-only winner", async () => {
  const f = await fixture()
  try {
    const attempts = await Promise.allSettled([
      openV4NewDesktopPluginWalWriter(f.input),
      openV4NewDesktopPluginWalWriter(f.input),
    ])
    const opened = attempts.filter(v => v.status === "fulfilled")
    const rejected = attempts.filter(v => v.status === "rejected")
    assert.equal(opened.length, 1)
    assert.equal(rejected.length, 1)
    if (opened[0]?.status === "fulfilled") await opened[0].value.release()
    assert.deepEqual(await readdir(f.leaf), [])
    await assert.rejects(openV4NewDesktopPluginWalWriter(f.input))
  } finally {
    await rm(f.vault, { recursive: true, force: true })
  }
})

test("D243 rejects mutated fence/lease callback identity and out-of-root writes", async () => {
  const f = await fixture()
  let writer: Awaited<ReturnType<typeof openV4NewDesktopPluginWalWriter>> | undefined
  try {
    writer = await openV4NewDesktopPluginWalWriter(f.input)
    await assert.rejects(writer.adapter.write("../slot-0.json", "bad"))
    await assert.rejects(writer.adapter.mkdir("../outside"))
    f.input.assertSyncFenceArmed = async () => {}
    await assert.rejects(writer.adapter.write(f.layout.journalRoot + "/slot-0.json", "bad"),
      /callback changed/u)
    await writer.release()
    writer = undefined
    assert.deepEqual(await readdir(f.leaf), [])
  } finally {
    await writer?.release()
    await rm(f.vault, { recursive: true, force: true })
  }
})

test("D243 post-create owner change leaves an empty WAL leaf for explicit Manual Recovery", async () => {
  const f = await fixture()
  let checks = 0
  const input = {
    ...f.input,
    assertSyncFenceArmed: async () => {
      checks++
      if (checks >= 2) throw Error("fence lost before first WAL write")
    },
  }
  try {
    await assert.rejects(openV4NewDesktopPluginWalWriter(input), /fence lost/u)
    assert.equal(await stat(f.leaf).then(s => s.isDirectory()), true)
    assert.deepEqual(await readdir(f.leaf), [])
    await assert.rejects(openV4NewDesktopPluginWalWriter(f.input))
  } finally {
    await rm(f.vault, { recursive: true, force: true })
  }
})
