import assert from "node:assert/strict"
import test from "node:test"

import { utf8ToBytes } from "../../src/lib/bytes"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { openV4NewMobilePluginWalWriter } from "../../src/lib/v4/reencryption-mobile-plugin-wal-writer"
import { openV4MobilePluginWalForRecovery } from "../../src/lib/v4/reencryption-mobile-wal-recovery"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { armV4ReencryptionSyncFence } from "../../src/lib/v4/reencryption-sync-fence"

const configDir = ".obsidian"
const pluginId = "mobile-rekey-test"
const runId = "d245-mobile-wal-run-123"
const sourceRepoId = "owner/repo#main"
const destinationRepoId = "owner/repo#rekey/mobile"
const sourceCommitSha = "a".repeat(40)
const journalKey = new Uint8Array(32).fill(0x65)

async function fixture() {
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const directories = new Set<string>([
    configDir, configDir + "/plugins", layout.pluginStorageRoot,
  ])
  const files = new Map<string, { text: string; mtime: number }>()
  let stamp = 10
  let ownerLive = true
  let leaseLive = true
  let fenceLive = true
  let writes = 0
  let readCount = 0
  let interceptWrite: ((path: string, text: string) => Promise<void>) | undefined

  const adapter = {
    async stat(name: string) {
      if (directories.has(name)) return { type: "folder" as const, size: 0, mtime: 1 }
      const info = files.get(name)
      return info ? { type: "file" as const,
        size: utf8ToBytes(info.text).length, mtime: info.mtime } : null
    },
    async list(name: string) {
      if (!directories.has(name)) throw Error("missing directory")
      const prefix = name + "/"
      const foundFiles = [...files.keys()].filter(f => f.startsWith(prefix)
        && !f.slice(prefix.length).includes("/"))
      const foundFolders = [...directories].filter(d => d.startsWith(prefix)
        && !d.slice(prefix.length).includes("/"))
      return { files: foundFiles, folders: foundFolders }
    },
    async read(name: string) {
      readCount++
      const info = files.get(name)
      if (!info) throw Error("missing file")
      return info.text
    },
    async write(name: string, text: string) {
      writes++
      if (interceptWrite) await interceptWrite(name, text)
      else files.set(name, { text, mtime: ++stamp })
    },
    async mkdir(name: string) {
      if (directories.has(name)) throw Error("already exists")
      directories.add(name)
    },
  }
  const native = (name: string) => layout.pluginStorageRoot + "/" + name
  const index: V4LocalIndexAdapter = {
    read: name => adapter.read(native(name)),
    exists: async name => (await adapter.stat(native(name))) !== null,
    write: (name, text) => adapter.write(native(name), text),
    mkdir: name => adapter.mkdir(native(name)),
  }
  await armV4ReencryptionSyncFence({
    adapter: index, runId, sourceRepoId, destinationRepoId,
    assertExclusiveInitiatorLease: async () => {},
  })
  // The initial D173 Fence itself is not WAL data.
  writes = 0
  const input = {
    adapter, fenceAdapter: index, configDir, pluginId, runId, sourceRepoId, destinationRepoId,
    assertLiveOwner() { if (!ownerLive) throw Error("lost mobile owner") },
    async assertExclusiveInitiatorLease() {
      if (!leaseLive) throw Error("lost initiating lease")
    },
    async assertSyncFenceArmed() { if (!fenceLive) throw Error("lost Sync Fence guard") },
  }
  return {
    input, adapter, files, directories, layout, index,
    setWriteFault(fn: (path: string, text: string) => Promise<void>) { interceptWrite = fn },
    inject(name: string, text: string, mtime = 7) { files.set(name, { text, mtime }) },
    loseLease() { leaseLive = false },
    loseOwner() { ownerLive = false },
    loseFence() { fenceLive = false },
    getWrites() { return writes },
    getReads() { return readCount },
  }
}

test("D245 mobile adapter writes two real encrypted WAL generations and reopens diagnostic readback", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    assert.equal(writer.cooperativeOsLeaseProven, false)
    assert.equal(writer.atomicSlotWritesProven, false)
    assert.equal(writer.powerLossDurabilityProven, false)
    assert.equal(writer.resumeSyncAuthorized, false)
    assert.equal(writer.cutoverAuthorized, false)
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writer.adapter, root: writer.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey,
    })
    const begun = await journal.begin()
    const latest = await journal.recordRefIntent({
      role: "backup", repoId: "owner/repo#rekey/backup",
      commitSha: sourceCommitSha, treeSha: "b".repeat(40),
    }, begun.generation)
    assert.equal(latest.generation, begun.generation + 1)
    assert.equal(await writer.assertBestEffortCheckpoint(), "best-effort-double-read-only")
    assert.equal(f.getWrites(), 2)
    writer.release()

    const reader = await openV4MobilePluginWalForRecovery({
      adapter: f.adapter, configDir, pluginId, runId, assertLiveOwner: () => {},
    })
    const recoveryAdapter: V4LocalIndexAdapter = {
      read: reader.adapter.read, exists: reader.adapter.exists,
      async write() { throw Error("recovery is read-only") },
      async mkdir() { throw Error("recovery is read-only") },
    }
    const recovery = createV4ReencryptionRecoveryJournal({
      adapter: recoveryAdapter, root: reader.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey: Uint8Array.from(journalKey),
    })
    assert.deepEqual(await recovery.assertHealthySnapshot(latest.generation), latest)
    assert.ok(f.getReads() >= 12)
  } finally { writer.release() }
})

test("D245 never reuses an existing empty, partially written or foreign WAL directory", async () => {
  for (const variant of ["empty", "one-slot", "unknown"] as const) {
    const f = await fixture()
    const wal = f.layout.vaultLogicalWalRoot
    f.directories.add(f.layout.pluginStorageRoot + "/reencryption-wal")
    f.directories.add(wal)
    if (variant === "one-slot") f.inject(wal + "/slot-0.json", "{torn")
    if (variant === "unknown") f.inject(wal + "/recovery.tmp", "preserve")
    const snapshot = new Map(f.files)
    await assert.rejects(openV4NewMobilePluginWalWriter(f.input))
    assert.deepEqual(f.files, snapshot)
    assert.equal(f.getWrites(), 0)
  }
})

test("D245 missing plugin storage and a wrong-run or missing persisted Fence prevent WAL directory creation", async () => {
  for (const variant of ["missing-root", "wrong-run", "missing-fence"] as const) {
    const f = await fixture()
    if (variant === "missing-root") f.directories.delete(f.layout.pluginStorageRoot)
    const marker = f.layout.pluginStorageRoot + "/github-sync-v4-rekey-sync-fence/active.json"
    if (variant === "wrong-run") {
      const existing = JSON.parse(f.files.get(marker)!.text) as { runId: string }
      existing.runId = "different-mobile-run-id"
      f.inject(marker, JSON.stringify(existing))
    }
    if (variant === "missing-fence") f.files.delete(marker)
    await assert.rejects(openV4NewMobilePluginWalWriter(f.input))
    assert.equal(f.directories.has(f.layout.vaultLogicalWalRoot), false)
    assert.equal(f.getWrites(), 0)
  }
})

test("D245 Mobile WAL freezes permanently after a truncated slot write and retains all interrupted bytes", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    f.setWriteFault(async (name, value) => {
      f.inject(name, value.slice(0, 19))
      throw Error("simulated interrupted Mobile write")
    })
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writer.adapter, root: writer.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey,
    })
    await assert.rejects(journal.begin(), /interrupted Mobile write/u)
    assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-1.json")?.text.length, 19)
    await assert.rejects(journal.begin(), /Manual Recovery/u)
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-0.json", "retry"),
      /Manual Recovery/u)
    assert.equal(f.getWrites(), 1)
    const preflight = openV4MobilePluginWalForRecovery({
      adapter: f.adapter, configDir, pluginId, runId, assertLiveOwner: () => {},
    })
    await assert.rejects(preflight)
    assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-1.json")?.text.length, 19)
  } finally { writer.release() }
})

test("D245 lost write acknowledgement after persisting full bytes never triggers an automatic retry", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    f.setWriteFault(async (name, value) => {
      f.inject(name, value)
      throw Error("simulated lost write acknowledgement")
    })
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "opaque WAL"),
      /lost write acknowledgement/u)
    assert.equal(f.getWrites(), 1)
    assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-1.json")?.text, "opaque WAL")
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-0.json", "another"),
      /Manual Recovery/u)
    assert.equal(f.getWrites(), 1)
  } finally { writer.release() }
})

test("D245 successful acknowledgement with truncated ciphertext still permanently poisons the Mobile writer", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    f.setWriteFault(async (name, value) => {
      f.inject(name, value.slice(0, Math.floor(value.length / 2)))
      // Mobile adapter returns success even though its stored file is torn.
    })
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "encrypted WAL data"),
      /Manual Recovery/u)
    assert.equal(f.getWrites(), 1)
    assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-1.json")?.text,
      "encrypted")
    await assert.rejects(writer.assertBestEffortCheckpoint(), /Manual Recovery/u)
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-0.json", "retry"),
      /Manual Recovery/u)
    assert.equal(f.getWrites(), 1)
  } finally { writer.release() }
})

test("D245 loss of initiating owner DURING an awaited Mobile write preserves bytes and stops the writer", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    f.setWriteFault(async (name, value) => {
      f.inject(name, value)
      f.loseOwner()
    })
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "ciphertext"),
      /lost mobile owner/u)
    assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-1.json")?.text,
      "ciphertext")
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-0.json", "retry"),
      /Manual Recovery/u)
    assert.equal(f.getWrites(), 1)
  } finally { writer.release() }
})

test("D245 altered same-size slot or foreign temporary artifact blocks the next WAL mutation", async () => {
  for (const variant of ["changed-same-size", "foreign-temp"] as const) {
    const f = await fixture()
    const writer = await openV4NewMobilePluginWalWriter(f.input)
    try {
      const slot = f.layout.vaultLogicalWalRoot + "/slot-0.json"
      await writer.adapter.write(writer.journalRoot + "/slot-0.json", "encrypted-data")
      if (variant === "changed-same-size") f.inject(slot, "EnCRypted-data", 7)
      if (variant === "foreign-temp") f.inject(f.layout.vaultLogicalWalRoot + "/.interrupted.tmp", "manual")
      const before = new Map(f.files)
      await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "next"))
      assert.deepEqual(f.files, before)
      assert.equal(f.getWrites(), 1)
    } finally { writer.release() }
  }
})

test("D245 owner, lease, Fence and reader mutation each block WAL writes without deleting the first slot", async () => {
  for (const variant of ["owner", "lease", "fence", "read-method", "run-id"] as const) {
    const f = await fixture()
    const writer = await openV4NewMobilePluginWalWriter(f.input)
    try {
      await writer.adapter.write(writer.journalRoot + "/slot-0.json", "first")
      if (variant === "owner") f.loseOwner()
      if (variant === "lease") f.loseLease()
      if (variant === "fence") f.loseFence()
      if (variant === "read-method") {
        const original = f.adapter.read
        f.adapter.read = name => original(name)
      }
      if (variant === "run-id") f.input.runId = "changed-while-writing"
      await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "second"))
      assert.equal(f.getWrites(), 1)
      assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-0.json")?.text, "first")
    } finally { writer.release() }
  }
})

test("D245 second in-process writer is refused while first still owns the same mobile adapter", async () => {
  const f = await fixture()
  const first = await openV4NewMobilePluginWalWriter(f.input)
  try {
    await assert.rejects(openV4NewMobilePluginWalWriter(f.input))
    assert.deepEqual(await f.adapter.list(f.layout.vaultLogicalWalRoot),
      { files: [], folders: [] })
  } finally { first.release() }
  await assert.rejects(openV4NewMobilePluginWalWriter(f.input),
    /Manual Recovery/u)
})

test("D245 rejects out-of-root paths, never creates arbitrary Mobile files and permanently poisons the writer", async () => {
  const f = await fixture()
  const writer = await openV4NewMobilePluginWalWriter(f.input)
  try {
    await assert.rejects(writer.adapter.mkdir("../outside"), /Manual Recovery/u)
    await assert.rejects(writer.adapter.write(writer.journalRoot + "/slot-1.json", "retry"),
      /Manual Recovery/u)
    assert.equal(f.files.has(f.layout.pluginStorageRoot + "/outside"), false)
    assert.equal(f.getWrites(), 0)
  } finally { writer.release() }
})
