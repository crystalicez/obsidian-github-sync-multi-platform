import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { createV4ReencryptionRecoveryJournal, type V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { inspectV4BestEffortReencryptionRestartEvidence } from "../../src/lib/v4/reencryption-best-effort-local-restart"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { inspectV4ReencryptionRestartEvidence } from "../../src/lib/v4/reencryption-local-cutover-restart"

const source = "owner/vault#main"
const backup = "owner/vault#backup/rekey-2026-10-28"
const destination = "owner/vault#rekey/2026-10-28"
const oldSha = "a".repeat(40)
const newSha = "b".repeat(40)
const oldSecret = "old-secret-id"
const newSecret = "new-secret-id"
const root = "private/v4-index"
const runId = "run_12345678"
const shadow = root + "-rekey-" + runId
const intentPath = root + "-rekey-intent-" + runId + "/intent.json"
const pathId = "aa" + "0".repeat(62)

function fixture(activeRoot = root) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  let writes = 0
  let walReads = 0
  let leases = 0
  let barriers = 0
  let readIntentCount = 0
  const adapter: V4LocalIndexAdapter = {
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
    async write(path, value) { writes++; files.set(path, value) },
    async read(path) {
      if (path === intentPath) readIntentCount++
      const text = files.get(path)
      if (text === undefined) throw Error("missing fixture file")
      return text
    },
  }
  const makeIndex = (repoId: string, commitSha: string, path = "Note.md") => {
    const idx = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    idx.remoteCommitSha = commitSha
    idx.shards.aa = {
      bucket: "aa", hash: "remote-" + commitSha.substring(0, 12),
      records: { [pathId]: {
        path, pathId, fileId: "file-1", plaintextSha256: "f".repeat(64),
        size: 5, mtime: 15, remoteVersion: commitSha,
        remotePath: ".obsidian-github-sync-v4/data/aa/" + pathId + ".enc", storage: "single",
      } },
    }
    idx.shardHashes.aa = idx.shards.aa.hash
    return idx
  }
  let wal: V4ReencryptionJournalSnapshot = {
    generation: 12, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: oldSha, treeSha: "c".repeat(40) },
      { role: "destination", repoId: destination, commitSha: newSha,
        treeSha: "d".repeat(40), manifestSha256: "e".repeat(64) },
    ],
    stageHandoffStarted: true,
    candidatePreparationSha256: "f".repeat(64),
    preparedCandidateReceipt: {
      commitSha: newSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
    },
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const journal = {
    sourceCommitSha: oldSha, destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      assert.equal(generation, 12)
      walReads++
      return wal
    },
  }
  const secrets = new Map([[oldSecret, "old-plaintext-must-not-leak"], [newSecret, "new-plaintext-must-not-leak"]])
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: oldSecret, vault: "device1",
  }
  const expected = {
    sourceRepoId: source, destinationRepoId: destination, destinationCommitSha: newSha,
    sourcePassphraseSecretId: oldSecret, destinationPassphraseSecretId: newSecret, deviceId: "device1",
  }
  const lease = async () => { leases++ }
  const durable = async () => { barriers++ }
  const input = (expectedWalGeneration = 12) => ({
    runId, expected, settings, indexAdapter: adapter, indexRoot: activeRoot,
    sourceCommitSha: oldSha, backupRepoId: backup, expectedWalGeneration,
    journal, getSecret: (id: string) => secrets.get(id) ?? null,
    assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
  })
  const seed = async (walGeneration = 12) => {
    await saveV4LocalIndex(adapter, activeRoot, makeIndex(source, oldSha))
    await saveV4LocalIndex(adapter, activeRoot + "-rekey-" + runId, makeIndex(destination, newSha))
    await prepareV4ReencryptionLocalCutoverIntent({
      adapter, activeIndexRoot: activeRoot, runId,
      sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
      sourceCommitSha: oldSha, destinationCommitSha: newSha,
      sourcePassphraseSecretId: oldSecret, destinationPassphraseSecretId: newSecret,
      deviceId: "device1", walGeneration,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
    })
  }
  return {
    files, adapter, seed, input, settings, expected, secrets, journal,
    makeIndex, changeWal: (next: V4ReencryptionJournalSnapshot) => { wal = next },
    currentWal: () => wal,
    counts: () => ({ writes, walReads, leases, barriers, readIntentCount }),
  }
}

test("D175 fresh restart inspection accepts the real plugin-private runtime Index root without granting Cutover", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  const prior = new Map(s.files)
  const before = s.counts().writes
  const report = await inspectV4ReencryptionRestartEvidence(s.input())
  assert.equal(report.observation, "source-with-prepared-intent-uncommitted")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.files, prior)
  assert.equal(s.counts().writes, before)
  const bestEffort = d171Input(s)
  const afterRestart = await inspectV4BestEffortReencryptionRestartEvidence(bestEffort.input)
  assert.equal(afterRestart.observation, "source-with-prepared-intent-uncommitted")
  assert.equal(afterRestart.resumeSyncAuthorized, false)
  assert.deepEqual(s.files, prior)
})

const d171Consent = "accept-best-effort-power-loss-recovery-risk" as const

function d171Input(s: ReturnType<typeof fixture>, generation = 12) {
  const { assertCrashDurable: _strict, ...core } = s.input(generation)
  let checkpoints = 0
  const wal = {
    async assertExclusiveStageLease() {},
    async assertBestEffortCheckpoint() {
      checkpoints++
      return "best-effort-readback-only" as const
    },
  }
  return { input: { ...core, wal, acknowledgement: d171Consent }, get checkpoints() { return checkpoints } }
}

test("D171 best-effort restart classifies pinned Source and complete prepared intent without resuming Sync", async () => {
  const s = fixture()
  await s.seed()
  const copies = new Map(s.files)
  const before = s.counts()
  const run = d171Input(s)
  const report = await inspectV4BestEffortReencryptionRestartEvidence(run.input)
  assert.deepEqual(report, {
    integrityScope: "read-only-local-intent-shadow-and-encrypted-wal",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    observation: "source-with-prepared-intent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.files, copies)
  assert.equal(s.counts().writes, before.writes)
  assert.equal(s.counts().readIntentCount, before.readIntentCount + 2)
  assert.equal(s.counts().barriers, before.barriers)
  assert.ok(run.checkpoints >= 12)
  assert.doesNotMatch(JSON.stringify(report), /old-plaintext-must-not-leak|new-plaintext-must-not-leak/)
})

test("D171 best-effort restart refuses missing acknowledgement, tampered intent, changed settings and incomplete WAL", async () => {
  const s = fixture()
  await s.seed()
  const run = d171Input(s)
  const before = s.counts()
  await assert.rejects(() => inspectV4BestEffortReencryptionRestartEvidence({
    ...run.input, acknowledgement: "declined" as typeof d171Consent,
  }), /acknowledgement/i)
  assert.equal(run.checkpoints, 0)
  assert.equal(s.counts().readIntentCount, before.readIntentCount)

  const original = s.files.get(intentPath)!
  s.files.set(intentPath, original.replace(oldSecret, "forged-secret"))
  assert.equal((await inspectV4BestEffortReencryptionRestartEvidence(run.input)).observation,
    "manual-recovery-required")
  s.files.set(intentPath, original)
  s.settings.githubBranch = "rekey/2026-10-28"
  assert.equal((await inspectV4BestEffortReencryptionRestartEvidence(run.input)).observation,
    "manual-recovery-required")
  s.settings.githubBranch = "main"

  const validWal = s.currentWal()
  s.changeWal({ ...validWal, verifiedRefObservations: validWal.verifiedRefObservations.slice(0, 1) })
  assert.equal((await inspectV4BestEffortReencryptionRestartEvidence(run.input)).observation,
    "manual-recovery-required")
  s.changeWal(validWal)
  assert.equal(s.counts().writes, before.writes)
})

test("D171 best-effort restart rejects stale generation, lost WAL lease and input mutation", async () => {
  const s = fixture()
  await s.seed()
  const run = d171Input(s)
  await assert.rejects(() => inspectV4BestEffortReencryptionRestartEvidence({
    ...run.input, expectedWalGeneration: 11,
  }), /Manual Recovery/i)
  await assert.rejects(() => inspectV4BestEffortReencryptionRestartEvidence({
    ...run.input,
    wal: { ...run.input.wal, async assertExclusiveStageLease() { throw Error("lease lost") } },
  }), /lease lost/)

  const input = d171Input(s).input
  const beforeWrites = s.counts().writes
  let altered = false
  input.wal.assertBestEffortCheckpoint = async () => {
    if (!altered) { altered = true; s.settings.githubBranch = "moved" }
    return "best-effort-readback-only" as const
  }
  await assert.rejects(() => inspectV4BestEffortReencryptionRestartEvidence(input), /Manual Recovery/i)
  assert.equal(altered, true)
  assert.equal(s.counts().writes, beforeWrites)
})

test("D171 fresh Windows WAL reader reopens and authenticates a preexisting local intent without writes", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "d171-restart-"))
  const journalKey = new Uint8Array(32).fill(0x53)
  try {
    const first = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: directory, journalRoot: "rekey/wal",
    })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: first.adapter, root: "rekey/wal",
        sourceCommitSha: oldSha, destinationRepoId: destination,
        runId: "d171-restart-wal", journalKey,
      })
      let snapshot = await journal.begin()
      const frozen = { role: "backup" as const, repoId: backup,
        commitSha: oldSha, treeSha: "c".repeat(40) }
      snapshot = await journal.recordRefIntent(frozen, snapshot.generation)
      snapshot = await journal.markRefReadbackObserved(frozen, snapshot.generation)
      snapshot = await journal.recordStagingHandoff(frozen, snapshot.generation)
      snapshot = await journal.recordCandidatePreparationIntent("f".repeat(64), snapshot.generation)
      snapshot = await journal.recordPreparedCandidateReceipt({
        commitSha: newSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
      }, snapshot.generation)
      const dest = {
        role: "destination" as const, repoId: destination,
        commitSha: newSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
      }
      snapshot = await journal.recordRefIntent(dest, snapshot.generation)
      snapshot = await journal.markRefReadbackObserved(dest, snapshot.generation)
      assert.equal(snapshot.generation, 8)
    } finally { await first.release() }

    const reopened = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: directory, journalRoot: "rekey/wal",
    })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: reopened.adapter, root: "rekey/wal",
        sourceCommitSha: oldSha, destinationRepoId: destination,
        runId: "d171-restart-wal", journalKey,
      })
      const s = fixture()
      await s.seed(8)
      const originals = new Map(s.files)
      const { assertCrashDurable: _strict, ...input } = s.input(8)
      const report = await inspectV4BestEffortReencryptionRestartEvidence({
        ...input, journal, wal: reopened, acknowledgement: d171Consent,
      })
      assert.equal(report.observation, "source-with-prepared-intent-uncommitted")
      assert.equal(report.resumeSyncAuthorized, false)
      assert.equal(report.localCutoverAuthorized, false)
      assert.deepEqual(s.files, originals)
      const snap = await journal.assertHealthySnapshot(8)
      assert.equal(snap.verifiedRefObservations.length, 2)
    } finally { await reopened.release() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("D136 brackets the exact independent intent and Source/Shadow indices around two healthy WAL reads without mutations", async () => {
  const s = fixture()
  await s.seed()
  const before = s.counts()
  const originals = new Map(s.files)
  const report = await inspectV4ReencryptionRestartEvidence(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-local-intent-shadow-and-encrypted-wal",
    observation: "source-with-prepared-intent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.files, originals)
  assert.equal(s.counts().writes, before.writes)
  assert.equal(s.counts().walReads, before.walReads + 2)
  assert.equal(s.counts().readIntentCount, before.readIntentCount + 2)
  assert.doesNotMatch(JSON.stringify(report), /old-plaintext-must-not-leak|new-plaintext-must-not-leak/)
})

test("D136 tampered intent with its own recomputed SHA256 never matches independently pinned identity", async () => {
  const s = fixture()
  await s.seed()
  for (const field of ["destinationPassphraseSecretId", "backupRepoId", "walGeneration", "phase"] as const) {
    const original = s.files.get(intentPath)!
    const parsed = JSON.parse(original) as Record<string, unknown>
    parsed[field] = field === "walGeneration" ? 13 : "forged-value"
    delete parsed.recordSha256
    parsed.recordSha256 = createHash("sha256").update(JSON.stringify(parsed)).digest("hex")
    s.files.set(intentPath, JSON.stringify(parsed))
    const report = await inspectV4ReencryptionRestartEvidence(s.input())
    assert.equal(report.observation, "manual-recovery-required", field)
    s.files.set(intentPath, original)
  }
})

test("D136 missing, truncated, oversized and noncanonical intent cannot authorize anything", async () => {
  const s = fixture()
  await s.seed()
  const good = s.files.get(intentPath)!
  for (const bad of [undefined, "", "{", good + "\n", "A".repeat(9_000)]) {
    if (bad === undefined) s.files.delete(intentPath)
    else s.files.set(intentPath, bad)
    const report = await inspectV4ReencryptionRestartEvidence(s.input())
    assert.equal(report.observation, "manual-recovery-required")
    assert.equal(report.resumeSyncAuthorized, false)
  }
  s.files.set(intentPath, good)
})

test("D136 incomplete or retargeted Source and Shadow cache blocks positive observation", async () => {
  const s = fixture()
  await s.seed()
  const path = shadow + "/index.json"
  const first = s.files.get(path)!
  s.files.set(path, JSON.stringify({ ...JSON.parse(first), remoteCommitSha: "9".repeat(40) }))
  assert.equal((await inspectV4ReencryptionRestartEvidence(s.input())).observation, "manual-recovery-required")
  s.files.set(path, first)
  s.files.delete(shadow + "/shards/aa.json")
  assert.equal((await inspectV4ReencryptionRestartEvidence(s.input())).observation, "manual-recovery-required")
})

test("D136 catches intent or Shadow changing during an awaited WAL/local inspection", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const oldGetSecret = input.getSecret
  let changed = false
  input.getSecret = (id) => {
    if (!changed) {
      changed = true
      s.files.set(intentPath, "interrupted write")
    }
    return oldGetSecret(id)
  }
  const report = await inspectV4ReencryptionRestartEvidence(input)
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")

  const other = fixture()
  await other.seed()
  const swapped = other.input()
  const oldSecretRead = swapped.getSecret
  let modified = false
  swapped.getSecret = (id) => {
    if (!modified) {
      modified = true
      const path = shadow + "/shards/aa.json"
      other.files.set(path, other.files.get(path)!.replace("Note.md", "Other.md"))
    }
    return oldSecretRead(id)
  }
  assert.equal((await inspectV4ReencryptionRestartEvidence(swapped)).observation, "manual-recovery-required")
})

test("D136 healthy intent cannot bypass damaged or changed encrypted WAL receipts", async () => {
  const s = fixture()
  await s.seed()
  const good = s.currentWal()
  for (const invalid of [
    { pendingRefIntents: [good.verifiedRefObservations[1]!] },
    { verifiedRefObservations: good.verifiedRefObservations.slice(0, 1) },
    { preparedCandidateReceipt: null },
    { cutoverAuthorized: true as false },
  ]) {
    s.changeWal({ ...good, ...invalid })
    assert.equal((await inspectV4ReencryptionRestartEvidence(s.input())).observation, "manual-recovery-required")
  }
  s.changeWal(good)
})

test("D136 settings/Secret mismatch or mutated adapter during lease prevents positive reconciliation", async () => {
  const s = fixture()
  await s.seed()
  s.settings.githubBranch = "rekey/2026-10-28"
  assert.equal((await inspectV4ReencryptionRestartEvidence(s.input())).observation, "manual-recovery-required")
  s.settings.githubBranch = "main"
  s.secrets.delete(oldSecret)
  assert.equal((await inspectV4ReencryptionRestartEvidence(s.input())).observation, "manual-recovery-required")
  const other = fixture()
  await other.seed()
  const original = other.input()
  let checked = false
  original.assertExclusiveInitiatorLease = async () => {
    if (!checked) { checked = true; original.indexAdapter = s.adapter }
  }
  assert.equal((await inspectV4ReencryptionRestartEvidence(original)).observation, "manual-recovery-required")
  assert.equal(checked, true)
})

test("D136 missing new recovery passphrase cannot certify the prepared intent even while Source is readable", async () => {
  const s = fixture()
  await s.seed()
  s.secrets.delete(newSecret)
  const result = await inspectV4ReencryptionRestartEvidence(s.input())
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
})

test("D136 rejects a swapped WAL verifier method during an awaited lease", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const original = input.journal.assertHealthySnapshot
  let changed = false
  input.assertExclusiveInitiatorLease = async () => {
    if (!changed) {
      changed = true
      input.journal.assertHealthySnapshot = async () => s.currentWal()
    }
  }
  try {
    assert.equal((await inspectV4ReencryptionRestartEvidence(input)).observation, "manual-recovery-required")
    assert.equal(changed, true)
  } finally {
    input.journal.assertHealthySnapshot = original
  }
})

test("D136 missing real durability, lease and corrupt WAL reader fail closed without writes", async () => {
  const s = fixture()
  await s.seed()
  const before = s.counts().writes
  const inp = s.input()
  await assert.rejects(() => inspectV4ReencryptionRestartEvidence({
    ...inp, assertCrashDurable: async () => { throw Error("fsync EPERM") },
  }), /EPERM/)
  await assert.rejects(() => inspectV4ReencryptionRestartEvidence({
    ...inp, assertExclusiveInitiatorLease: async () => { throw Error("lease lost") },
  }), /lease lost/)
  await assert.rejects(() => inspectV4ReencryptionRestartEvidence({
    ...inp, journal: { ...inp.journal, async assertHealthySnapshot() { throw Error("corrupt WAL") } },
  }), /corrupt WAL/)
  assert.equal(s.counts().writes, before)
})

test("D136 rejects traversal and wrong run/branch shape before reading local files", async () => {
  const s = fixture()
  const input = s.input()
  for (const override of [
    { runId: "../escaped" }, { runId: undefined as never }, { indexRoot: "../outside" },
    { expectedWalGeneration: 0 }, { sourceCommitSha: "HEAD" },
  ]) {
    await assert.rejects(() => inspectV4ReencryptionRestartEvidence({ ...input, ...override }))
    assert.equal(s.counts().walReads, 0)
  }
})
