import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { stageV4BestEffortPreparedSelectorEvidence, inspectV4BestEffortPreparedSelectorAfterRestart } from "../../src/lib/v4/reencryption-prepared-selector-stage"
import {
  authenticateV4ReencryptionPreparedSelectorEvidence,
  authenticateV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal, type V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d172_prepared_run", walGeneration: 8,
  indexRoot: "private/v4-index", deviceId: "device172",
  sourceRepoId: "owner/vault#main", backupRepoId: "owner/vault#backup/rekey",
  destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64),
  sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
}
const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
const preparedPath = roots.selectorPath.replace(/selector\.json$/u, "prepared.json")
const intentPath = identity.indexRoot + "-rekey-intent-" + identity.runId + "/intent.json"
const consent = "accept-best-effort-power-loss-recovery-risk" as const

function fixture() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  const key = new Uint8Array(32).fill(0x72)
  let held = false
  let checks = 0
  let snapshot: V4ReencryptionJournalSnapshot = {
    generation: 8, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha },
      { role: "destination", repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256 },
    ],
    preparedCandidateReceipt: {
      commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
      manifestSha256: identity.manifestSha256,
    },
    candidatePreparationSha256: "f".repeat(64),
    stageHandoffStarted: true, requiresRemoteRevalidation: true,
    permissionToPublish: false, cutoverAuthorized: false,
  }
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const value = files.get(path)
      if (value === undefined) throw Error("missing " + path)
      return value
    },
    async write(path, value) { writes.push(path); files.set(path, value) },
    async mkdir(path) { dirs.add(path) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async stat(path) {
      const value = files.get(path)
      return value === undefined ? null : { size: Buffer.byteLength(value) }
    },
  }
  const journal = {
    sourceCommitSha: identity.sourceCommitSha,
    destinationRepoId: identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, 8)
      return structuredClone(snapshot)
    },
  }
  const wal = {
    async assertExclusiveStageLease() { assert.equal(held, true) },
    async assertBestEffortCheckpoint() {
      checks++
      assert.equal(held, true)
      return "best-effort-readback-only" as const
    },
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "old-secret", vault: identity.deviceId,
  }
  const secrets = new Map([["old-secret", "old-value"], ["new-secret", "new-value"]])
  const lease = async () => { assert.equal(held, true) }
  const owner = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.equal(held, false)
    held = true
    try { return await body() } finally { held = false }
  }
  const input = () => ({
    restart: {
      runId: identity.runId, indexRoot: identity.indexRoot,
      sourceCommitSha: identity.sourceCommitSha, backupRepoId: identity.backupRepoId,
      expectedWalGeneration: identity.walGeneration,
      expected: {
        sourceRepoId: identity.sourceRepoId, destinationRepoId: identity.destinationRepoId,
        destinationCommitSha: identity.destinationCommitSha,
        sourcePassphraseSecretId: identity.sourcePassphraseSecretId,
        destinationPassphraseSecretId: identity.destinationPassphraseSecretId,
        deviceId: identity.deviceId,
      },
      settings, indexAdapter: adapter, journal, wal,
      acknowledgement: consent,
      getSecret: (id: string) => secrets.get(id) ?? null,
      assertExclusiveInitiatorLease: lease,
    },
    identity: { ...identity }, journalKey: key, withExclusiveInitiatorLease: owner,
  })
  const seed = async () => {
    const source = createEmptyV4LocalIndex({
      repoId: identity.sourceRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    source.remoteCommitSha = identity.sourceCommitSha
    const shadow = createEmptyV4LocalIndex({
      repoId: identity.destinationRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    shadow.remoteCommitSha = identity.destinationCommitSha
    await saveV4LocalIndex(adapter, roots.sourceIndexRoot, source)
    await saveV4LocalIndex(adapter, roots.shadowIndexRoot, shadow)
    await owner(async () => prepareV4ReencryptionLocalCutoverIntent({
      adapter, activeIndexRoot: identity.indexRoot, runId: identity.runId,
      sourceRepoId: identity.sourceRepoId, backupRepoId: identity.backupRepoId,
      destinationRepoId: identity.destinationRepoId,
      sourceCommitSha: identity.sourceCommitSha, destinationCommitSha: identity.destinationCommitSha,
      sourcePassphraseSecretId: identity.sourcePassphraseSecretId,
      destinationPassphraseSecretId: identity.destinationPassphraseSecretId,
      deviceId: identity.deviceId, walGeneration: identity.walGeneration,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: lease,
    }))
  }
  return {
    files, dirs, writes, key, adapter, settings, secrets, wal, journal, seed, input,
    setWal(next: V4ReencryptionJournalSnapshot) { snapshot = next },
    walSnapshot: () => snapshot,
    get checks() { return checks },
  }
}

test("D172 reopened prepared evidence remains uncommitted and read-only", async () => {
  const s = fixture()
  await s.seed()
  await stageV4BestEffortPreparedSelectorEvidence(s.input())
  const files = new Map(s.files)
  const before = s.writes.length
  const report = await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-prepared-selector-and-authenticated-wal",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    observation: "authenticated-prepared-selector-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(Object.isFrozen(report), true)
  assert.deepEqual(s.files, files)
  assert.equal(s.writes.length, before)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
})

test("D172 restored encrypted evidence rejects tampering, replayed identity and stale WAL without writing", async () => {
  const s = fixture()
  await s.seed()
  await stageV4BestEffortPreparedSelectorEvidence(s.input())
  const bytes = s.files.get(preparedPath)!
  const before = s.writes.length
  for (const broken of [bytes.slice(0, -5), bytes + "\n", "A".repeat(8195)]) {
    s.files.set(preparedPath, broken)
    assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
      "manual-recovery-required")
  }
  s.files.set(preparedPath, bytes)
  const wrongKey = s.input()
  wrongKey.journalKey[0] ^= 1
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(wrongKey)).observation,
    "manual-recovery-required")
  const original = s.walSnapshot()
  s.setWal({ ...original, pendingRefIntents: [original.verifiedRefObservations[1]!] })
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
    "manual-recovery-required")
  s.setWal(original)
  s.files.set(roots.selectorPath, "incomplete active selector")
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
    "manual-recovery-required")
  assert.equal(s.writes.length, before)
})

test("D172 cooperative overlapping preparation allows no second encrypted write", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const holder = input.withExclusiveInitiatorLease
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  input.withExclusiveInitiatorLease = async body => {
    if (first) { first = false; entered(); await held }
    return holder(body)
  }
  const running = stageV4BestEffortPreparedSelectorEvidence(input)
  await started
  try {
    const before = s.writes.length
    await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()),
      /Concurrent.*Manual Recovery/)
    assert.equal(s.writes.length, before)
  } finally { release() }
  assert.equal((await running).status, "authenticated-prepared-selector-uncommitted")
  assert.equal(s.files.has(preparedPath), true)
})

test("D172 writes a distinct encrypted prepared selector once and preserves source/settings/indices", async () => {
  const s = fixture()
  await s.seed()
  const before = new Map(s.files)
  const writes = s.writes.length
  const report = await stageV4BestEffortPreparedSelectorEvidence(s.input())
  assert.deepEqual(report, {
    status: "authenticated-prepared-selector-uncommitted",
    evidencePath: preparedPath,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.writes.slice(writes), [preparedPath])
  for (const [path, value] of before) assert.equal(s.files.get(path), value, path)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
  assert.equal(s.settings.githubBranch, "main")
  assert.equal(s.settings.encryptionPassphraseSecretId, "old-secret")
  const sealed = s.files.get(preparedPath)!
  assert.equal(await authenticateV4ReencryptionPreparedSelectorEvidence(sealed, identity, s.key), true)
  assert.equal(await authenticateV4ReencryptionSeparatedSelectorTestVector(sealed, identity, s.key), false)
  assert.equal(s.checks >= 18, true)
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()), /Existing.*Manual Recovery/)
  assert.equal(s.writes.length, writes + 1)
  assert.doesNotMatch(sealed, /old-secret|new-secret|old-value|new-value/)
})

test("D172 wrong acknowledgement, identity, missing D170 intent and incomplete WAL all deny writes", async () => {
  for (const cause of ["consent", "identity", "intent", "wal", "selector"] as const) {
    const s = fixture()
    await s.seed()
    const input = s.input()
    if (cause === "consent") input.restart.acknowledgement = "no" as typeof consent
    if (cause === "identity") input.identity.destinationTreeSha = "f".repeat(40)
    if (cause === "intent") s.files.delete(intentPath)
    if (cause === "wal") s.setWal({
      ...s.walSnapshot(), pendingRefIntents: [s.walSnapshot().verifiedRefObservations[1]!],
    })
    if (cause === "selector") s.files.set(roots.selectorPath, "occupied")
    const writes = s.writes.length
    await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input))
    assert.equal(s.writes.length, writes, cause)
    assert.equal(s.files.has(preparedPath), false, cause)
  }
})

test("D172 lost prepared evidence write response preserves partial record and forbids restart/retry", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const original = input.restart.indexAdapter.write
  input.restart.indexAdapter.write = async (path, value) => {
    await original(path, value)
    if (path === preparedPath) throw Error("lost write response")
  }
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input), /lost write response/)
  assert.equal(s.files.has(preparedPath), true)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()), /Existing.*Manual Recovery/)
})

test("D172 changed Source Settings or encrypted evidence during awaited checkpoint never reports success", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const normal = input.restart.wal.assertBestEffortCheckpoint
  let changed = false
  input.restart.wal.assertBestEffortCheckpoint = async () => {
    const result = await normal()
    if (!changed && s.files.has(preparedPath)) {
      changed = true
      s.settings.githubBranch = "other"
    }
    return result
  }
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input), /Manual Recovery/)
  assert.equal(changed, true)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
})

test("D172 real Windows encrypted WAL backs staged selector while only isolated local evidence changes", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "d172-prepared-"))
  try {
    let staged: ReturnType<typeof fixture> | null = null
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: directory, journalRoot: "rekey/wal" })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: storage.adapter, root: "rekey/wal",
        runId: identity.runId, journalKey: new Uint8Array(32).fill(0x72),
        sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
      })
      let w = await journal.begin()
      const backup = { role: "backup" as const, repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha }
      w = await journal.recordRefIntent(backup, w.generation)
      w = await journal.markRefReadbackObserved(backup, w.generation)
      w = await journal.recordStagingHandoff(backup, w.generation)
      w = await journal.recordCandidatePreparationIntent("f".repeat(64), w.generation)
      w = await journal.recordPreparedCandidateReceipt({
        commitSha: identity.destinationCommitSha,
        treeSha: identity.destinationTreeSha, manifestSha256: identity.manifestSha256,
      }, w.generation)
      const dest = { role: "destination" as const, repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha,
        treeSha: identity.destinationTreeSha, manifestSha256: identity.manifestSha256 }
      w = await journal.recordRefIntent(dest, w.generation)
      w = await journal.markRefReadbackObserved(dest, w.generation)
      assert.equal(w.generation, 8)
      const s = fixture()
      staged = s
      await s.seed()
      const before = new Map(s.files)
      const input = s.input()
      input.restart.journal = journal
      input.restart.wal = {
        async assertExclusiveStageLease() { await storage.assertExclusiveStageLease() },
        async assertBestEffortCheckpoint() { return storage.assertBestEffortCheckpoint() },
      }
      const report = await stageV4BestEffortPreparedSelectorEvidence(input)
      assert.equal(report.localCutoverAuthorized, false)
      for (const [path, value] of before) assert.equal(s.files.get(path), value)
      assert.equal(await journal.assertHealthySnapshot(8).then(x => x.verifiedRefObservations.length), 2)
      assert.equal(s.files.has(preparedPath), true)
    } finally { await storage.release() }
    const reopened = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: directory, journalRoot: "rekey/wal",
    })
    try {
      assert.ok(staged)
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: reopened.adapter, root: "rekey/wal",
        runId: identity.runId, journalKey: new Uint8Array(32).fill(0x72),
        sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
      })
      const input = staged.input()
      input.restart.journal = journal
      input.restart.wal = {
        async assertExclusiveStageLease() { await reopened.assertExclusiveStageLease() },
        async assertBestEffortCheckpoint() { return reopened.assertBestEffortCheckpoint() },
      }
      const before = new Map(staged.files)
      const report = await inspectV4BestEffortPreparedSelectorAfterRestart(input)
      assert.equal(report.observation, "authenticated-prepared-selector-uncommitted")
      assert.equal(report.resumeSyncAuthorized, false)
      assert.equal(report.localCutoverAuthorized, false)
      assert.deepEqual(staged.files, before)
    } finally { await reopened.release() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
