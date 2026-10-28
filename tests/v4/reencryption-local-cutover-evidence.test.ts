import assert from "node:assert/strict"
import test from "node:test"
import {
  createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import { inspectV4ReencryptionCutoverEvidence } from "../../src/lib/v4/reencryption-local-cutover-evidence"

const source = "owner/vault#main"
const backup = "owner/vault#backup/rekey-2026-10-28"
const destination = "owner/vault#rekey/2026-10-28"
const sourceCommit = "a".repeat(40)
const destinationCommit = "b".repeat(40)
const destinationTree = "c".repeat(40)
const backupTree = "d".repeat(40)
const manifest = "e".repeat(64)
const oldSecret = "old-encrypted-secret-id"
const newSecret = "new-encrypted-secret-id"

const expected = Object.freeze({
  sourceRepoId: source, destinationRepoId: destination, destinationCommitSha: destinationCommit,
  sourcePassphraseSecretId: oldSecret, destinationPassphraseSecretId: newSecret, deviceId: "device1",
})

function scenario() {
  const data = new Map<string, string>()
  const secret = new Map([[oldSecret, "do-not-expose-old"], [newSecret, "do-not-expose-new"]])
  let writes = 0
  const indexAdapter: V4LocalIndexAdapter = {
    async read(p) { const value = data.get(p); if (value === undefined) throw Error("missing"); return value },
    async write(p, v) { writes++; data.set(p, v) },
    async mkdir() {},
    async exists(p) { return data.has(p) },
  }
  const persist = async (repoId: string, sha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    index.remoteCommitSha = sha
    await saveV4LocalIndex(indexAdapter, ".cutover-index", index)
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: oldSecret, vault: "device1",
  }
  const current: V4ReencryptionJournalSnapshot = {
    generation: 12,
    receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: sourceCommit, treeSha: backupTree },
      { role: "destination", repoId: destination, commitSha: destinationCommit,
        treeSha: destinationTree, manifestSha256: manifest },
    ],
    stageHandoffStarted: true, candidatePreparationSha256: "f".repeat(64),
    preparedCandidateReceipt: { commitSha: destinationCommit, treeSha: destinationTree, manifestSha256: manifest },
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  let observed = current
  let durableCalls = 0
  let leaseCalls = 0
  let walCalls = 0
  const journal = {
    sourceCommitSha: sourceCommit,
    destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      walCalls++
      assert.equal(generation, 12)
      return observed
    },
  }
  const calls = () => ({ durableCalls, leaseCalls, walCalls, writes })
  const input = () => ({
    expected, sourceCommitSha: sourceCommit, backupRepoId: backup, expectedWalGeneration: 12,
    settings, indexAdapter, indexRoot: ".cutover-index",
    getSecret: (id: string) => secret.get(id) ?? null,
    journal,
    assertExclusiveInitiatorLease: async () => { leaseCalls++ },
    assertCrashDurable: async () => { durableCalls++ },
  })
  return { input, persist, settings, secret, journal, calls, changeWal: (v: V4ReencryptionJournalSnapshot) => { observed = v } }
}

test("D132 verified two-ref WAL with old local state is uncommitted, read-only and never permission to cutover or Sync", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const initial = s.calls().writes
  const result = await inspectV4ReencryptionCutoverEvidence(s.input())
  assert.equal(result.observation, "source-with-verified-remote-fork-uncommitted")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.rollbackAuthorized, false)
  assert.equal(result.remoteWritesAuthorized, false)
  assert.equal(result.credentialCleanupAuthorized, false)
  assert.equal(s.calls().writes, initial)
  assert.equal(s.calls().walCalls, 2)
  assert.equal(s.calls().durableCalls, 2)
  assert.equal(s.calls().leaseCalls, 2)
  assert.doesNotMatch(JSON.stringify(result), /do-not-expose-old|do-not-expose-new/)
})

test("D132 matching destination settings and local index still require a separately durable local commit receipt", async () => {
  const s = scenario()
  await s.persist(destination, destinationCommit)
  const settings = s.settings
  settings.githubBranch = "rekey/2026-10-28"
  settings.encryptionPassphraseSecretId = newSecret
  const result = await inspectV4ReencryptionCutoverEvidence(s.input())
  assert.equal(result.observation, "destination-observed-without-local-commit")
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.localCutoverAuthorized, false)
})

test("D132 mismatched/missing Backup or Destination receipt, candidate or pending intent never certifies cutover", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const good = await s.journal.assertHealthySnapshot(12)
  for (const changed of [
    { verifiedRefObservations: good.verifiedRefObservations.slice(0, 1) },
    { verifiedRefObservations: good.verifiedRefObservations.slice(1) },
    { verifiedRefObservations: [{ ...good.verifiedRefObservations[0]!, commitSha: "9".repeat(40) }, good.verifiedRefObservations[1]!] },
    { verifiedRefObservations: [good.verifiedRefObservations[0]!, { ...good.verifiedRefObservations[1]!, manifestSha256: "8".repeat(64) }] },
    { pendingRefIntents: [good.verifiedRefObservations[1]!] },
    { pendingIntents: [{ path: ".obsidian-github-sync-v4/data/aa/" + "a".repeat(64) + ".enc", sha: sourceCommit, byteLength: 4 }] },
    { stageHandoffStarted: false },
    { candidatePreparationSha256: null },
    { preparedCandidateReceipt: null },
    { preparedCandidateReceipt: { ...good.preparedCandidateReceipt!, treeSha: "7".repeat(40) } },
    { generation: 11 },
    { permissionToPublish: true as false },
    { cutoverAuthorized: true as false },
  ]) {
    s.changeWal({ ...good, ...changed })
    const report = await inspectV4ReencryptionCutoverEvidence(s.input())
    assert.equal(report.observation, "manual-recovery-required")
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.localCutoverAuthorized, false)
  }
})

test("D132 WAL changed after local read is detected by second WAL confirmation", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const good = await s.journal.assertHealthySnapshot(12)
  const original = s.input()
  let calls = 0
  const report = await inspectV4ReencryptionCutoverEvidence({
    ...original,
    getSecret(id) {
      if (++calls === 1) s.changeWal({ ...good, preparedCandidateReceipt: null })
      return original.getSecret(id)
    },
  })
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.resumeSyncAuthorized, false)
})

test("D132 storage durability, lease and WAL read failures propagate closed without further operations", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const original = s.input()
  const callsBefore = s.calls()
  await assert.rejects(() => inspectV4ReencryptionCutoverEvidence({
    ...original, assertCrashDurable: async () => { throw Error("EPERM unsupported directory fsync") },
  }), /EPERM/)
  assert.equal(s.calls().walCalls, callsBefore.walCalls)
  await assert.rejects(() => inspectV4ReencryptionCutoverEvidence({
    ...original, assertExclusiveInitiatorLease: async () => { throw Error("exclusive lease lost") },
  }), /exclusive lease lost/)
  await assert.rejects(() => inspectV4ReencryptionCutoverEvidence({
    ...original, journal: { ...original.journal, async assertHealthySnapshot() { throw Error("WAL corruption") } },
  }), /WAL corruption/)
})

test("D132 mutating pinned Secret ID and live settings during first durability await cannot relabel source evidence", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const original = s.input()
  const mutable = { ...expected }
  const settings = { ...s.settings }
  let checked = false
  const result = await inspectV4ReencryptionCutoverEvidence({
    ...original, expected: mutable, settings,
    getSecret: id => id === "untrusted-rotation" ? "fake-extra-secret" : original.getSecret(id),
    assertCrashDurable: async () => {
      if (!checked) {
        checked = true
        mutable.sourcePassphraseSecretId = "untrusted-rotation"
        settings.encryptionPassphraseSecretId = "untrusted-rotation"
      }
    },
  })
  assert.equal(checked, true)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.resumeSyncAuthorized, false)
})

test("D132 malformed pinned source SHA, different physical repo, absent durability gate rejected before storage access", async () => {
  const s = scenario()
  for (const bad of [
    { sourceCommitSha: "HEAD" },
    { expected: { ...expected, destinationCommitSha: "HEAD" } },
    { expected: { ...expected, sourcePassphraseSecretId: newSecret } },
    { indexRoot: "../escaped" },
    { getSecret: undefined as never },
    { backupRepoId: "elsewhere/vault#backup/foreign" },
    { backupRepoId: destination },
    { expectedWalGeneration: 0 },
    { assertCrashDurable: undefined as never },
  ]) {
    const calls = s.calls()
    await assert.rejects(() => inspectV4ReencryptionCutoverEvidence({ ...s.input(), ...bad }))
    assert.deepEqual(s.calls(), calls)
  }
})

test("D132 corrupted local index makes otherwise healthy remote WAL manual-only", async () => {
  const s = scenario()
  await s.persist(source, sourceCommit)
  const original = s.input()
  const observed = await inspectV4ReencryptionCutoverEvidence({
    ...original,
    indexAdapter: { ...original.indexAdapter, async read() { return "{bad" } },
  })
  assert.equal(observed.observation, "manual-recovery-required")
  assert.equal(observed.resumeSyncAuthorized, false)
})
