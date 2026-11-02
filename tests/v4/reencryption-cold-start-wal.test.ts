import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { inspectV4ColdStartWalSnapshot } from "../../src/lib/v4/reencryption-cold-start-wal-snapshot"
import type { V4ReencryptionCutoverSnapshotContract } from "../../src/lib/v4/reencryption-cutover-snapshot-contract"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"

const sourceCommitSha = "a".repeat(40)
const sourceTreeSha = "b".repeat(40)
const destinationCommitSha = "c".repeat(40)
const destinationTreeSha = "d".repeat(40)
const manifestSha256 = "e".repeat(64)
const sourceRepoId = "owner/repo#main"
const backupRepoId = "owner/repo#rekey/backup"
const destinationRepoId = "owner/repo#rekey/destination"
const runId = "d237-cold-start"
const walRoot = "reencryption/cold-wal"
const journalKey = new Uint8Array(32).fill(0x47)

class WalMemory implements V4LocalIndexAdapter {
  readonly files = new Map<string, string>()
  writes = 0
  async read(path: string) {
    const value = this.files.get(path)
    if (value === undefined) throw Error("Missing WAL file")
    return value
  }
  async exists(path: string) { return this.files.has(path) }
  async write(path: string, data: string) { this.writes++; this.files.set(path, data) }
  async mkdir(_path: string) {}
}

async function scenario() {
  const storage = new WalMemory()
  const journal = createV4ReencryptionRecoveryJournal({
    adapter: storage, root: walRoot, sourceCommitSha,
    destinationRepoId, runId, journalKey,
  })
  const backup = {
    role: "backup" as const, repoId: backupRepoId,
    commitSha: sourceCommitSha, treeSha: sourceTreeSha,
  }
  const destination = {
    role: "destination" as const, repoId: destinationRepoId,
    commitSha: destinationCommitSha, treeSha: destinationTreeSha,
    manifestSha256,
  }
  const receipt = {
    path: ".obsidian-github-sync-v4/data/aa/" + "b".repeat(64) + ".enc",
    sha: "b".repeat(40), byteLength: 512,
  }
  let state = await journal.begin()
  state = await journal.recordRefIntent(backup, state.generation)
  state = await journal.markRefReadbackObserved(backup, state.generation)
  state = await journal.recordStagingHandoff(backup, state.generation)
  state = await journal.recordUploadIntent(receipt, state.generation)
  state = await journal.appendReceipt(receipt, state.generation)
  state = await journal.recordCandidatePreparationIntent("f".repeat(64), state.generation)
  state = await journal.recordPreparedCandidateReceipt({
    commitSha: destinationCommitSha, treeSha: destinationTreeSha, manifestSha256,
  }, state.generation)
  state = await journal.recordRefIntent(destination, state.generation)
  state = await journal.markRefReadbackObserved(destination, state.generation)

  const contract: V4ReencryptionCutoverSnapshotContract = {
    transactionId: "a".repeat(32),
    identity: {
      runId, walGeneration: state.generation,
      indexRoot: "github-sync-v4-index", deviceId: "device_d237",
      sourceRepoId, backupRepoId, destinationRepoId,
      sourceCommitSha, sourceTreeSha, destinationCommitSha,
      destinationTreeSha, manifestSha256,
      sourcePassphraseSecretId: "old-key", destinationPassphraseSecretId: "new-key",
    },
    walSnapshotSha256: await sha256Hex(utf8ToBytes(JSON.stringify(state))),
    sourceIndexSha256: "1".repeat(64),
    destinationShadowSha256: "2".repeat(64),
    preparedEvidenceSha256: "3".repeat(64),
    sourceSettingsSha256: "4".repeat(64),
    destinationSettingsSha256: "5".repeat(64),
  }
  let live = true
  const reader: Pick<V4LocalIndexAdapter, "exists" | "read"> = {
    exists: (path: string) => storage.exists(path),
    read: (path: string) => storage.read(path),
  }
  const input = {
    adapter: reader, root: walRoot, contract,
    originalJournalKey: Uint8Array.from(journalKey),
    assertLiveOwner: () => { if (!live) throw Error("Owner lost") },
  }
  return { storage, input, receipt, invalidOwner: () => { live = false } }
}

test("D239 binds exact ciphertext receipt identity to authenticated old-key WAL", async () => {
  const s = await scenario()
  const expectedReceipts = [{ ...s.receipt }]
  const matching = await inspectV4ColdStartWalSnapshot({
    ...s.input, expectedReceipts,
  })
  assert.equal(matching.observation, "authenticated-current-wal-still-fenced")
  for (const receipts of [
    [], [{ ...s.receipt, sha: "9".repeat(40) }],
    [{ ...s.receipt, byteLength: s.receipt.byteLength + 1 }],
    [{ ...s.receipt }, { ...s.receipt }],
  ]) {
    const denied = await inspectV4ColdStartWalSnapshot({
      ...s.input, expectedReceipts: receipts,
    })
    assert.equal(denied.observation, "manual-recovery-required")
    assert.equal(denied.resumeSyncAuthorized, false)
  }
})

test("D237 fresh WAL reader authenticates exact encrypted two-slot state with no writes or cutover authority", async () => {
  const s = await scenario()
  const before = new Map(s.storage.files)
  const writes = s.storage.writes
  const key = Uint8Array.from(s.input.originalJournalKey)
  const observed = await inspectV4ColdStartWalSnapshot(s.input)
  assert.equal(observed.observation, "authenticated-current-wal-still-fenced")
  assert.equal(observed.walSnapshotAuthenticated, true)
  assert.equal(observed.walMatchesCutoverContract, true)
  assert.equal(observed.bestEffortReadbackOnly, true)
  assert.equal(observed.resumeSyncAuthorized, false)
  assert.equal(observed.localCutoverAuthorized, false)
  assert.equal(observed.commitDecisionAuthorized, false)
  assert.equal(observed.rollbackAuthorized, false)
  assert.equal(observed.remoteWritesAuthorized, false)
  assert.equal(observed.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.storage.files, before)
  assert.equal(s.storage.writes, writes)
  assert.deepEqual(s.input.originalJournalKey, key, "inspect must not zero the caller's key")
})

test("D237 rejects wrong key, foreign run, stale generation and mismatched immutable WAL digest", async () => {
  const s = await scenario()
  const original = s.input
  const attempts = [
    { ...original, originalJournalKey: new Uint8Array(32).fill(0x24) },
    { ...original, contract: { ...original.contract,
      identity: { ...original.contract.identity, runId: "other-cold-start" } } },
    { ...original, contract: { ...original.contract,
      identity: { ...original.contract.identity, walGeneration: original.contract.identity.walGeneration - 1 } } },
    { ...original, contract: { ...original.contract, walSnapshotSha256: "0".repeat(64) } },
    { ...original, root: "wrong/journal" },
  ]
  for (const attempt of attempts) {
    const observed = await inspectV4ColdStartWalSnapshot(attempt)
    assert.equal(observed.observation, "manual-recovery-required")
    assert.equal(observed.resumeSyncAuthorized, false)
  }
})

test("D237 denies torn or missing WAL predecessor even when the newest slot decrypts", async () => {
  const s = await scenario()
  const slot = walRoot + "/slot-1.json"
  const original = s.storage.files.get(slot)!
  s.storage.files.set(slot, "{torn")
  assert.equal((await inspectV4ColdStartWalSnapshot(s.input)).observation, "manual-recovery-required")
  s.storage.files.delete(slot)
  assert.equal((await inspectV4ColdStartWalSnapshot(s.input)).observation, "manual-recovery-required")
  s.storage.files.set(slot, original)
  assert.equal((await inspectV4ColdStartWalSnapshot(s.input)).observation,
    "authenticated-current-wal-still-fenced")
})

test("D237 denies a WAL slot that changes between authenticated reads", async () => {
  const s = await scenario()
  const adapter = s.input.adapter
  let calls = 0
  const volatileReader: Pick<V4LocalIndexAdapter, "exists" | "read"> = {
    exists: path => adapter.exists(path),
    read: async path => {
      const value = await adapter.read(path)
      calls++
      return calls >= 5 ? value + " " : value
    },
  }
  const result = await inspectV4ColdStartWalSnapshot({ ...s.input, adapter: volatileReader })
  assert.equal(result.observation, "manual-recovery-required")
  assert.ok(calls >= 5)
  assert.equal(result.walMatchesCutoverContract, false)
  assert.equal(s.storage.writes, 10)
})


test("D237 real Windows Node WAL readback remains authenticated after release and reopen", async () => {
  const s = await scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d237-wal-"))
  let first: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let second: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    first = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: root, journalRoot: walRoot })
    for (const [file, data] of s.storage.files) {
      if (file.endsWith("/slot-0.json") || file.endsWith("/slot-1.json")) {
        await first.adapter.write(file, data)
      }
    }
    assert.equal(await first.assertBestEffortCheckpoint(), "best-effort-readback-only")
    await first.release()
    first = undefined
    second = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: root, journalRoot: walRoot })
    assert.equal(await second.assertBestEffortCheckpoint(), "best-effort-readback-only")
    const before = await second.adapter.read(walRoot + "/slot-0.json")
    const after = await second.adapter.read(walRoot + "/slot-1.json")
    const result = await inspectV4ColdStartWalSnapshot({
      ...s.input,
      adapter: {
        read: path => second!.adapter.read(path),
        exists: path => second!.adapter.exists(path),
      },
    })
    assert.equal(result.observation, "authenticated-current-wal-still-fenced")
    assert.equal(result.resumeSyncAuthorized, false)
    assert.equal(await second.adapter.read(walRoot + "/slot-0.json"), before)
    assert.equal(await second.adapter.read(walRoot + "/slot-1.json"), after)
  } finally {
    await second?.release()
    await first?.release()
    await rm(root, { recursive: true, force: true })
  }
})

test("D237 rejects lost owner or swapped adapter method without mutating WAL", async () => {
  const s = await scenario()
  const existingRead = s.input.adapter.read
  let ownerChecks = 0
  const guard = () => {
    ownerChecks++
    if (ownerChecks === 4) s.input.adapter.read = async path => existingRead(path)
  }
  assert.equal((await inspectV4ColdStartWalSnapshot({
    ...s.input, assertLiveOwner: guard,
  })).observation, "manual-recovery-required")

  const next = await scenario()
  next.invalidOwner()
  assert.equal((await inspectV4ColdStartWalSnapshot(next.input)).observation, "manual-recovery-required")
})
