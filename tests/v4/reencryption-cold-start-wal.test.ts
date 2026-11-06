import assert from "node:assert/strict"
import test from "node:test"
import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { inspectV4ColdStartWalSnapshot } from "../../src/lib/v4/reencryption-cold-start-wal-snapshot"
import type { V4ReencryptionCutoverSnapshotContract } from "../../src/lib/v4/reencryption-cutover-snapshot-contract"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage, V4DesktopRekeyWalLockError, V4DesktopRekeyWalRecoveryRequiredError } from "../../src/lib/v4/reencryption-desktop-wal"
import { openV4ExistingDesktopWalForRecovery } from "../../src/lib/v4/reencryption-desktop-wal-recovery"

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
  let second: Awaited<ReturnType<typeof openV4ExistingDesktopWalForRecovery>> | undefined
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
    second = await openV4ExistingDesktopWalForRecovery({ rootAbsolute: root, journalRoot: walRoot })
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

test("D241 existing-only Windows recovery opener never creates a missing WAL directory", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d241-wal-absent-"))
  try {
    const directory = path.join(root, ...walRoot.split("/"))
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }))
    await assert.rejects(stat(directory), { code: "ENOENT" })
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D241 existing-only recovery accepts both original encrypted slots after release and exposes no writer", async () => {
  const s = await scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d241-wal-valid-"))
  let created: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let reader: Awaited<ReturnType<typeof openV4ExistingDesktopWalForRecovery>> | undefined
  try {
    created = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: root, journalRoot: walRoot })
    for (const [name, content] of s.storage.files) await created.adapter.write(name, content)
    await created.release()
    created = undefined
    reader = await openV4ExistingDesktopWalForRecovery({ rootAbsolute: root, journalRoot: walRoot })
    assert.equal(Object.hasOwn(reader.adapter, "write"), false)
    assert.equal(Object.hasOwn(reader.adapter, "mkdir"), false)
    assert.equal(Object.isFrozen(reader.adapter), true)
    assert.equal(await reader.assertBestEffortCheckpoint(), "best-effort-readback-only")
    assert.equal((await inspectV4ColdStartWalSnapshot({
      ...s.input, adapter: reader.adapter,
    })).observation, "authenticated-current-wal-still-fenced")
    for (const [name, content] of s.storage.files) {
      assert.equal(await reader.adapter.read(name), content)
    }
    await reader.release()
    reader = undefined
    const directory = path.join(root, ...walRoot.split("/"))
    assert.deepEqual((await readdir(directory)).sort(), ["slot-0.json", "slot-1.json"])
  } finally {
    await reader?.release()
    await created?.release()
    await rm(root, { recursive: true, force: true })
  }
})

test("D241 rejects incomplete, foreign-temp and already-locked WAL without changing recovery evidence", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d241-wal-invalid-"))
  const dir = path.join(root, ...walRoot.split("/"))
  try {
    await mkdir(dir, { recursive: true })
    const slot0 = path.join(dir, "slot-0.json")
    const slot1 = path.join(dir, "slot-1.json")
    await writeFile(slot0, "encrypted-slot-evidence")
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError)
    assert.deepEqual(await readdir(dir), ["slot-0.json"])
    await writeFile(slot1, "encrypted-slot-evidence")
    await writeFile(path.join(dir, ".slot-interrupted.tmp"), "newer-recovery-evidence")
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError)
    assert.deepEqual((await readdir(dir)).sort(),
      [".slot-interrupted.tmp", "slot-0.json", "slot-1.json"].sort())
    await rm(path.join(dir, ".slot-interrupted.tmp"))
    await writeFile(path.join(dir, ".exclusive.lock"), "another process owns this")
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalLockError,
    "exact two-slot WAL with an existing owner lock is BUSY, not corrupted")
    assert.equal(await stat(path.join(dir, ".exclusive.lock")).then(s => s.isFile()), true)
    assert.equal(await readdir(dir).then(items => items.includes(".exclusive.lock")), true)
    // Even if another holder's lock is present, an interrupted temporary
    // writer file is not a harmless "busy" directory: preserve evidence and
    // demand Manual Recovery instead of guessing the third-party state.
    await writeFile(path.join(dir, ".slot-interrupted.tmp"), "torn-staging-evidence")
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError,
    "OS lock plus unknown WAL residue must not be downgraded to busy")
    assert.equal(await stat(path.join(dir, ".slot-interrupted.tmp")).then(s => s.isFile()), true)
    await rm(path.join(dir, ".slot-interrupted.tmp"))
    assert.equal(await stat(slot0).then(s => s.size), "encrypted-slot-evidence".length)
    assert.equal(await stat(slot1).then(s => s.size), "encrypted-slot-evidence".length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D289 existing-only recovery treats nonfile or hardlinked lock as forensic evidence, never busy", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d289-wal-lock-type-"))
  const dir = path.join(root, ...walRoot.split("/"))
  const lock = path.join(dir, ".exclusive.lock")
  const slot0 = path.join(dir, "slot-0.json")
  const slot1 = path.join(dir, "slot-1.json")
  const alias = path.join(root, "lock-hardlink-alias")
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(slot0, "encrypted-slot-0")
    await writeFile(slot1, "encrypted-slot-1")

    // A real holder never creates a DIRECTORY at the lock pathname.
    await mkdir(lock)
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError,
    "a directory posing as the WAL OS lock is not a legitimate busy reader")
    assert.deepEqual((await readdir(dir)).sort(),
      [".exclusive.lock", "slot-0.json", "slot-1.json"])
    await rm(lock, { recursive: true })

    // Even a normal-looking file is untrusted if another path aliases its inode.
    await writeFile(lock, "test-stale-lock")
    await link(lock, alias)
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError,
    "a hardlinked lock cannot be accepted as a well-formed exclusive lease")
    assert.equal(await stat(lock).then(s => s.nlink), 2)
    assert.equal(await stat(slot0).then(s => s.size), "encrypted-slot-0".length)
    assert.equal(await stat(slot1).then(s => s.size), "encrypted-slot-1".length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D290 existing-only recovery never reports busy when lock is valid but WAL slots are unsafe", async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d290-wal-locked-slots-"))
  const dir = path.join(root, ...walRoot.split("/"))
  const slot0 = path.join(dir, "slot-0.json")
  const slot1 = path.join(dir, "slot-1.json")
  const lock = path.join(dir, ".exclusive.lock")
  const alias = path.join(root, "slot-hardlink-alias")
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(slot0, "encrypted-slot-0")
    await writeFile(slot1, "encrypted-slot-1")
    await writeFile(lock, "another holder's well-formed lock")

    // The lock alone is not proof that the WAL slots are safe to recover.
    await rm(slot0)
    await mkdir(slot0)
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError,
    "a directory posing as a slot is recovery evidence even when another lock exists")
    await rm(slot0, { recursive: true })
    await writeFile(slot0, "encrypted-slot-0")

    await link(slot1, alias)
    await assert.rejects(openV4ExistingDesktopWalForRecovery({
      rootAbsolute: root, journalRoot: walRoot,
    }), V4DesktopRekeyWalRecoveryRequiredError,
    "a hardlinked WAL slot must not be concealed by the busy lock classification")
    assert.equal(await stat(slot1).then(info => info.nlink), 2)
    assert.equal(await stat(lock).then(info => info.isFile()), true)
    assert.equal(await stat(slot0).then(info => info.size), "encrypted-slot-0".length)
    assert.equal(await stat(slot1).then(info => info.size), "encrypted-slot-1".length)
  } finally {
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
