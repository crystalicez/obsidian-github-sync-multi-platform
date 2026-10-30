import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent, prepareV4BestEffortReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal, type V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"

const source = "owner/repo#main"
const backup = "owner/repo#backup/run12345"
const destination = "owner/repo#rekey/run12345"
const oldSha = "a".repeat(40)
const newSha = "b".repeat(40)
const root = "private/v4-index"
const runId = "run12345"
const shadow = root + "-rekey-" + runId
const intentRoot = root + "-rekey-intent-" + runId

function store() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  const adapter: V4LocalIndexAdapter = {
    async read(path) { const text = files.get(path); if (text === undefined) throw Error("file not found"); return text },
    async write(path, value) { writes.push(path); files.set(path, value) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
  }
  const makeIndex = (repoId: string, sha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    index.remoteCommitSha = sha
    return index
  }
  const seed = async () => {
    await saveV4LocalIndex(adapter, root, makeIndex(source, oldSha))
    await saveV4LocalIndex(adapter, shadow, makeIndex(destination, newSha))
  }
  const input = () => ({
    adapter, activeIndexRoot: root, runId,
    sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
    sourceCommitSha: oldSha, destinationCommitSha: newSha,
    sourcePassphraseSecretId: "old-secret-id", destinationPassphraseSecretId: "new-secret-id",
    deviceId: "device1", walGeneration: 7,
    assertExclusiveInitiatorLease: async () => {},
    assertCrashDurable: async () => {},
  })
  return { files, dirs, writes, adapter, seed, input }
}

const d170Consent = "accept-best-effort-power-loss-recovery-risk" as const
const candidateTree = "c".repeat(40)
const candidateManifest = "d".repeat(64)

function bestEffortFixture(s: ReturnType<typeof store>) {
  const snapshot: V4ReencryptionJournalSnapshot = {
    generation: 7,
    receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: oldSha, treeSha: "e".repeat(40) },
      { role: "destination", repoId: destination, commitSha: newSha,
        treeSha: candidateTree, manifestSha256: candidateManifest },
    ],
    stageHandoffStarted: true,
    candidatePreparationSha256: "f".repeat(64),
    preparedCandidateReceipt: {
      commitSha: newSha, treeSha: candidateTree, manifestSha256: candidateManifest,
    },
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  let checks = 0
  const journal = {
    sourceCommitSha: oldSha, destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      if (generation !== snapshot.generation) throw Error("bad generation")
      return snapshot
    },
  }
  const wal = {
    async assertExclusiveStageLease() {},
    async assertBestEffortCheckpoint() { checks++; return "best-effort-readback-only" as const },
  }
  return {
    snapshot, journal, wal,
    input: () => {
      const { assertCrashDurable: _strict, ...core } = s.input()
      return { ...core, journal, wal, acknowledgement: d170Consent }
    },
    get checks() { return checks },
  }
}

test("D170 best-effort writes only uncommitted intent after exact completed Backup/Destination WAL evidence", async () => {
  const s = store()
  await s.seed()
  const f = bestEffortFixture(s)
  const originals = new Map(s.files)
  const before = s.writes.length
  const result = await prepareV4BestEffortReencryptionLocalCutoverIntent(f.input())
  assert.equal(result.status, "local-cutover-intent-prepared-uncommitted")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.writes.slice(before), [intentRoot + "/intent.json"])
  for (const [path, bytes] of originals) assert.equal(s.files.get(path), bytes)
  const saved = JSON.parse(s.files.get(result.intentPath)!) as Record<string, unknown>
  assert.equal(saved.phase, "prepared-uncommitted")
  assert.equal(saved.walGeneration, 7)
  assert.equal(saved.sourcePassphraseSecretId, "old-secret-id")
  assert.equal(saved.destinationPassphraseSecretId, "new-secret-id")
  assert.equal(f.checks, 9)
  await assert.rejects(() => prepareV4BestEffortReencryptionLocalCutoverIntent(f.input()), /existing|manual recovery/i)
  assert.equal(s.writes.length, before + 1)
})

test("D170 no consent and incomplete or foreign destination WAL refuse all intent writes", async () => {
  const s = store()
  await s.seed()
  const f = bestEffortFixture(s)
  const before = s.writes.length
  await assert.rejects(() => prepareV4BestEffortReencryptionLocalCutoverIntent({
    ...f.input(), acknowledgement: "declined" as typeof d170Consent,
  }), /acknowledgement/i)
  assert.equal(f.checks, 0)
  const incomplete = bestEffortFixture(s)
  for (const change of [
    { pendingRefIntents: [{ role: "destination" as const, repoId: destination, commitSha: newSha, treeSha: candidateTree }] },
    { verifiedRefObservations: [incomplete.snapshot.verifiedRefObservations[0]!] },
    { preparedCandidateReceipt: null },
    { stageHandoffStarted: false },
  ]) {
    const corrupted = { ...incomplete.snapshot, ...change }
    const input = incomplete.input()
    await assert.rejects(() => prepareV4BestEffortReencryptionLocalCutoverIntent({
      ...input,
      journal: { ...input.journal, async assertHealthySnapshot() { return corrupted as V4ReencryptionJournalSnapshot } },
    }), /Manual Recovery/i)
  }
  assert.equal(s.writes.length, before)
  assert.equal(s.dirs.has(intentRoot), false)
})

test("D170 interrupted best-effort checkpoint after writing intent preserves ambiguity, never retries", async () => {
  const s = store()
  await s.seed()
  const f = bestEffortFixture(s)
  const input = f.input()
  let interrupted = false
  const wal = {
    ...input.wal,
    async assertBestEffortCheckpoint() {
      if (s.files.has(intentRoot + "/intent.json")) {
        interrupted = true
        throw Error("simulated WAL readback interruption")
      }
      return "best-effort-readback-only" as const
    },
  }
  await assert.rejects(() => prepareV4BestEffortReencryptionLocalCutoverIntent({ ...input, wal }), /Manual Recovery/i)
  assert.equal(interrupted, true)
  assert.equal(s.files.has(intentRoot + "/intent.json"), true)
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
  assert.equal((await loadV4LocalIndex(s.adapter, shadow)).repoId, destination)
  await assert.rejects(() => prepareV4BestEffortReencryptionLocalCutoverIntent(f.input()), /existing|manual recovery/i)
})

test("D170 real Windows encrypted WAL authenticates a complete remote fork before preparing only a local intent", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "d170-local-intent-"))
  try {
    const wal = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: directory, journalRoot: "rekey/wal",
    })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: wal.adapter, root: "rekey/wal",
        sourceCommitSha: oldSha, destinationRepoId: destination,
        runId: "d170-local-intent", journalKey: new Uint8Array(32).fill(0x52),
      })
      let state = await journal.begin()
      const frozen = { role: "backup" as const, repoId: backup,
        commitSha: oldSha, treeSha: "e".repeat(40) }
      state = await journal.recordRefIntent(frozen, state.generation)
      state = await journal.markRefReadbackObserved(frozen, state.generation)
      state = await journal.recordStagingHandoff(frozen, state.generation)
      state = await journal.recordCandidatePreparationIntent("f".repeat(64), state.generation)
      state = await journal.recordPreparedCandidateReceipt({
        commitSha: newSha, treeSha: candidateTree, manifestSha256: candidateManifest,
      }, state.generation)
      const intended = {
        role: "destination" as const, repoId: destination,
        commitSha: newSha, treeSha: candidateTree, manifestSha256: candidateManifest,
      }
      state = await journal.recordRefIntent(intended, state.generation)
      state = await journal.markRefReadbackObserved(intended, state.generation)
      const s = store()
      await s.seed()
      const { assertCrashDurable: _unused, ...core } = s.input()
      const report = await prepareV4BestEffortReencryptionLocalCutoverIntent({
        ...core, walGeneration: state.generation,
        wal, journal, acknowledgement: d170Consent,
      })
      assert.equal(report.localCutoverAuthorized, false)
      assert.equal(report.resumeSyncAuthorized, false)
      assert.equal((await journal.assertHealthySnapshot(state.generation)).verifiedRefObservations.length, 2)
      assert.equal((await loadV4LocalIndex(s.adapter, root)).remoteCommitSha, oldSha)
      assert.equal((await loadV4LocalIndex(s.adapter, shadow)).remoteCommitSha, newSha)
      assert.equal(s.files.has(intentRoot + "/intent.json"), true)
    } finally { await wal.release() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("D135 prepares nonsecret intent independently, retaining both local indices and denying cutover", async () => {
  const s = store()
  await s.seed()
  const originals = new Map(s.files)
  const start = s.writes.length
  const result = await prepareV4ReencryptionLocalCutoverIntent(s.input())
  assert.deepEqual(result, {
    status: "local-cutover-intent-prepared-uncommitted",
    intentPath: intentRoot + "/intent.json",
    recordSha256: result.recordSha256,
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.writes.slice(start), [intentRoot + "/intent.json"])
  for (const [path, text] of originals) assert.equal(s.files.get(path), text, path)
  const stored = JSON.parse(s.files.get(result.intentPath)!) as Record<string, unknown>
  assert.equal(stored.phase, "prepared-uncommitted")
  assert.equal(stored.sourceRepoId, source)
  assert.equal(stored.backupRepoId, backup)
  assert.equal(stored.destinationRepoId, destination)
  assert.equal(stored.sourceIndexRoot, root)
  assert.equal(stored.destinationIndexRoot, shadow)
  assert.equal(stored.sourceCommitSha, oldSha)
  assert.equal(stored.destinationCommitSha, newSha)
  assert.equal(stored.sourcePassphraseSecretId, "old-secret-id")
  assert.equal(stored.destinationPassphraseSecretId, "new-secret-id")
  assert.equal(stored.walGeneration, 7)
  assert.equal(stored.recordSha256, result.recordSha256)
  const { recordSha256: _digest, ...payload } = stored
  assert.equal(result.recordSha256, createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
  assert.equal((await loadV4LocalIndex(s.adapter, shadow)).repoId, destination)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /existing|manual recovery/i)
})

test("D135 lost write acknowledgement makes intent ambiguous and never reusable", async () => {
  const s = store()
  await s.seed()
  const base = s.adapter
  const adapter: V4LocalIndexAdapter = {
    ...base,
    async write(path, value) {
      await base.write(path, value)
      if (path === intentRoot + "/intent.json") throw Error("lost acknowledgement")
    },
  }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...s.input(), adapter }), /lost acknowledgement/)
  assert.equal(await s.adapter.exists(intentRoot), true)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /existing|manual recovery/i)
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
})

test("D135 forged readback with a recomputed SHA256 cannot change intended Secret ID", async () => {
  const s = store()
  await s.seed()
  const base = s.adapter
  const adapter: V4LocalIndexAdapter = {
    ...base,
    async read(path) {
      const raw = await base.read(path)
      if (path !== intentRoot + "/intent.json") return raw
      const forged = JSON.parse(raw) as Record<string, unknown>
      forged.destinationPassphraseSecretId = "forged-secret"
      delete forged.recordSha256
      forged.recordSha256 = createHash("sha256").update(JSON.stringify(forged)).digest("hex")
      return JSON.stringify(forged)
    },
  }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...s.input(), adapter }), /readback|mismatch|changed/i)
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
})

test("D135 refuses wrong branches, wrong commits, missing indices and invalid intent scope before writes", async () => {
  const s = store()
  await s.seed()
  const base = s.input()
  for (const override of [
    { backupRepoId: source }, { destinationRepoId: backup },
    { destinationCommitSha: oldSha }, { sourceCommitSha: newSha },
    { walGeneration: 0 }, { walGeneration: 1.5 },
    { sourcePassphraseSecretId: "same", destinationPassphraseSecretId: "same" },
    { activeIndexRoot: "../escape" }, { runId: "bad/../run" }, { runId: undefined as never },
    { assertCrashDurable: undefined as never }, { assertExclusiveInitiatorLease: undefined as never },
  ]) {
    const start = s.writes.length
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...base, ...override }))
    assert.equal(s.writes.length, start)
  }
  const missing = store()
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(missing.input()), /index|incomplete|missing/i)
  assert.equal(missing.writes.length, 0)
})

test("D135 missing lease, durability failure, and mutated input fail closed", async () => {
  const s = store()
  await s.seed()
  const before = new Map(s.files)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({
    ...s.input(), assertExclusiveInitiatorLease: async () => { throw Error("lease unavailable") },
  }), /lease unavailable/)
  assert.deepEqual(s.files, before)
  const broken = store()
  await broken.seed()
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({
    ...broken.input(), assertCrashDurable: async () => { throw Error("fsync EPERM") },
  }), /EPERM/)
  assert.equal((await loadV4LocalIndex(broken.adapter, root)).repoId, source)
  const mutated = store()
  await mutated.seed()
  const input = mutated.input()
  input.assertExclusiveInitiatorLease = async () => { input.destinationPassphraseSecretId = "mutated-secret" }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(input), /changed|mutation/i)
  assert.equal(mutated.writes.length, 2)
})

test("D135 cannot switch persistence adapter or durability callback while an initial lease is awaited", async () => {
  const original = store()
  const redirect = store()
  await original.seed()
  await redirect.seed()
  const changedAdapter = original.input()
  let swapped = false
  changedAdapter.assertExclusiveInitiatorLease = async () => {
    if (!swapped) { swapped = true; changedAdapter.adapter = redirect.adapter }
  }
  await assert.rejects(
    () => prepareV4ReencryptionLocalCutoverIntent(changedAdapter),
    /changed|identity|contract/i,
  )
  assert.equal(original.files.has(intentRoot + "/intent.json"), false)
  assert.equal(redirect.files.has(intentRoot + "/intent.json"), false)

  const s = store()
  await s.seed()
  const changedDurability = s.input()
  let replaced = false
  changedDurability.assertExclusiveInitiatorLease = async () => {
    if (!replaced) {
      replaced = true
      changedDurability.assertCrashDurable = async () => {}
    }
  }
  await assert.rejects(
    () => prepareV4ReencryptionLocalCutoverIntent(changedDurability),
    /changed|identity|contract/i,
  )
  assert.equal(s.files.has(intentRoot + "/intent.json"), false)
})

test("D136 bounds D135 Intent writer to the same 8 KiB ceiling enforced after restart", async () => {
  const s = store()
  const largeDestination = "owner/repo#rekey/" + "x".repeat(9_000)
  const src = createEmptyV4LocalIndex({ repoId: source, deviceId: "device1", mode: "encrypted" })
  src.remoteCommitSha = oldSha
  const dst = createEmptyV4LocalIndex({ repoId: largeDestination, deviceId: "device1", mode: "encrypted" })
  dst.remoteCommitSha = newSha
  await saveV4LocalIndex(s.adapter, root, src)
  await saveV4LocalIndex(s.adapter, shadow, dst)
  const writes = s.writes.length
  await assert.rejects(
    () => prepareV4ReencryptionLocalCutoverIntent({ ...s.input(), destinationRepoId: largeDestination }),
    /bounded|size limit/i,
  )
  assert.equal(s.writes.length, writes)
  assert.equal(s.dirs.has(intentRoot), false)
})

test("D135 same-adapter overlapping intent attempts cannot both write", async () => {
  const s = store()
  await s.seed()
  let started!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  const running = prepareV4ReencryptionLocalCutoverIntent({
    ...s.input(),
    assertExclusiveInitiatorLease: async () => {
      if (first) { first = false; started(); await held }
    },
  })
  await entered
  try {
    const written = s.writes.length
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /concurrent|active/i)
    assert.equal(s.writes.length, written)
  } finally { release() }
  const result = await running
  assert.equal(result.localCutoverAuthorized, false)
})
