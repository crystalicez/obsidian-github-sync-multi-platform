import assert from "node:assert/strict"
import test from "node:test"
import { computeV4ReencryptionCandidateManifestDigest } from "../../src/lib/v4/reencryption-candidate-manifest-digest"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import { auditV4ReencryptionCrossPhaseContinuity, type V4ReencryptionPhaseContinuityInput } from "../../src/lib/v4/reencryption-phase-continuity"
import type { V4PreparedOrphanCommit } from "../../src/lib/v4/reencryption-orphan-publication"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"

const src = "owner/vault#main"
const backup = "owner/vault#backup/rekey"
const dst = "owner/vault#rekey/2026"
const oldSha = "a".repeat(40)
const newSha = "b".repeat(40)
const sourceTreeSha = "c".repeat(40)
const destTreeSha = "d".repeat(40)
const root = "private/v4-index"
const runId = "run_d144_123"
const config = (repoId: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
  algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
  kdfParams: { iterations: 600000, salt: "c2FsdA" },
})

const BASE = Object.freeze({
  integrityScope: "pure-cross-phase-identity-audit-uncommitted",
  singleAtomicSnapshotProofPossible: false,
  persistentTransitionAuthenticated: false,
  localCutoverAuthorized: false, resumeSyncAuthorized: false,
  rollbackAuthorized: false, remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const sequential = Object.freeze({ ...BASE, observation: "identities-consistent-but-phases-sequential" })
const incompatible = Object.freeze({ ...BASE, observation: "incompatible-or-unverifiable-context" })

function fixture() {
  const sourceConfig = config(src)
  const destinationConfig = config(dst)
  const plan = planV4OrphanReencryptionDestination({
    sourceRepoId: src, destinationRepoId: dst, sourceCommitSha: oldSha,
    sourcePhysicalRepositoryId: 123, destinationPhysicalRepositoryId: 123,
    expectedPhysicalRepositoryId: 123, defaultBranch: "main",
  })
  const prepared: V4PreparedOrphanCommit = {
    integrityScope: "unreferenced-encrypted-orphan-commit",
    destinationRepoId: dst, pinnedSourceCommitSha: oldSha, physicalRepositoryId: 123,
    sourceTreeSha, treeSha: destTreeSha, commitSha: newSha,
    verifiedFileCount: 0, stagedCiphertextObjectCount: 0,
    encryptedMetadataObjectCount: 0, deviceId: "device144",
    journalId: "journal144", createdAt: 1,
    sourceAndBackupPreserved: true, rootHasZeroParents: true,
    backupProvenanceVerified: false, installedRestoreVerified: false,
    refPublished: false, cutoverAuthorized: false,
  }
  const digest = computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha, destinationConfig, expectedRecords: [], expectedReceipts: [],
  })
  let called = 0
  const forbidden = async () => { called++; throw new Error("pure preflight attempted IO") }
  const adapter = {
    read: forbidden, exists: forbidden, write: forbidden, mkdir: forbidden,
  }
  const getSecret = () => { called++; throw new Error("pure preflight touched SecretStorage") }
  const lease = forbidden
  const durable = forbidden
  const journal = {
    sourceCommitSha: oldSha, destinationRepoId: dst, assertHealthySnapshot: forbidden,
  }
  const restartSettings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main", vault: "device144",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "old-id",
  }
  const destinationSettings = {
    ...restartSettings, githubBranch: "rekey/2026",
    encryptionPassphraseSecretId: "new-id",
  }
  const input = {
    sourcePhase: {
      restart: {
        runId, indexRoot: root, sourceCommitSha: oldSha, backupRepoId: backup,
        expectedWalGeneration: 12,
        expected: {
          sourceRepoId: src, destinationRepoId: dst,
          destinationCommitSha: newSha,
          sourcePassphraseSecretId: "old-id", destinationPassphraseSecretId: "new-id",
          deviceId: "device144",
        },
        settings: restartSettings,
        indexAdapter: adapter, journal, getSecret,
        assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
      },
      shadow: {
        adapter, activeIndexRoot: root, runId, expectedDeviceId: "device144",
        assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
        remote: {
          github: {
            getRepositoryIdentity: forbidden, getGitRef: forbidden, getGitCommit: forbidden,
            getTreeAt: forbidden, getBlob: forbidden,
          },
          plan, sourceTreeSha, sourceConfig, expectedDestinationConfig: destinationConfig,
          expectedReceipts: [], destinationCommitSha: newSha,
          destinationPassphrase: "new-passphrase",
        },
      },
      preparedCandidate: prepared,
      backupReader: { branchName: "backup/rekey",
        getRepositoryIdentity: forbidden, getRepositoryDefaultBranch: forbidden,
        getGitRefOrNull: forbidden, getGitCommit: forbidden },
      withExclusiveInitiatorLease: forbidden,
    },
    destinationPhase: {
      identity: {
        runId, walGeneration: 12, indexRoot: root, deviceId: "device144",
        sourceRepoId: src, backupRepoId: backup, destinationRepoId: dst,
        sourceCommitSha: oldSha, sourceTreeSha,
        destinationCommitSha: newSha, destinationTreeSha: destTreeSha,
        manifestSha256: digest, sourcePassphraseSecretId: "old-id",
        destinationPassphraseSecretId: "new-id",
      },
      journalKey: new Uint8Array(32).fill(18),
      adapter, settings: destinationSettings, journal, getSecret,
      withExclusiveInitiatorLease: forbidden,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
    },
    shadowRecords: [],
  } as unknown as V4ReencryptionPhaseContinuityInput
  return { input, count: () => called }
}

test("D144 exact pinned D143 and D142 identities are sequential, never one atomic snapshot or permission", () => {
  const { input, count } = fixture()
  const result = auditV4ReencryptionCrossPhaseContinuity(input)
  assert.deepEqual(result, sequential)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(count(), 0, "audit must never read Git, WAL, Settings persistence, Index or secrets")
  assert.notEqual(input.sourcePhase.restart.settings.githubBranch, input.destinationPhase.settings.githubBranch)
  assert.notEqual(input.sourcePhase.restart.settings.encryptionPassphraseSecretId,
    input.destinationPhase.settings.encryptionPassphraseSecretId)
})

test("D144 a single shared live Settings snapshot can never satisfy both Source and Destination phases", () => {
  const { input } = fixture()
  input.destinationPhase.settings = input.sourcePhase.restart.settings
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
  input.sourcePhase.restart.settings = {
    ...input.sourcePhase.restart.settings,
    githubBranch: "rekey/2026", encryptionPassphraseSecretId: "new-id",
  }
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
})

test("D144 independent pinning rejects wrong run/ref/SHA/tree/manifest/key identity across phase boundary", () => {
  const mutate: Array<(f: ReturnType<typeof fixture>["input"]) => void> = [
    f => { f.destinationPhase.identity.runId = "another_run" },
    f => { f.destinationPhase.identity.walGeneration++ },
    f => { f.destinationPhase.identity.sourceCommitSha = "8".repeat(40) },
    f => { f.destinationPhase.identity.sourceTreeSha = "9".repeat(40) },
    f => { f.destinationPhase.identity.destinationCommitSha = "4".repeat(40) },
    f => { f.destinationPhase.identity.destinationTreeSha = "5".repeat(40) },
    f => { f.destinationPhase.identity.manifestSha256 = "6".repeat(64) },
    f => { f.destinationPhase.identity.backupRepoId = "owner/vault#backup/another" },
    f => { f.destinationPhase.identity.destinationPassphraseSecretId = "old-id" },
    f => { f.destinationPhase.identity.deviceId = "other-device" },
    f => { f.destinationPhase.identity.indexRoot = "other/index" },
    f => { f.sourcePhase.backupReader.branchName = "not-the-branch" },
    f => { f.sourcePhase.shadow.remote.destinationCommitSha = "7".repeat(40) },
    f => { f.sourcePhase.restart.journal.sourceCommitSha = "8".repeat(40) },
    f => { f.sourcePhase.restart.journal.destinationRepoId = "owner/vault#wrong" },
    f => { f.sourcePhase.preparedCandidate.treeSha = "5".repeat(40) },
    f => { f.sourcePhase.shadow.remote.expectedDestinationConfig = config("owner/vault#wrong") },
    f => { f.sourcePhase.shadow.remote.plan = { ...f.sourcePhase.shadow.remote.plan, physicalRepositoryId: 987 } },
    f => { f.sourcePhase.shadow.adapter = { ...f.sourcePhase.shadow.adapter } },
    f => { f.sourcePhase.shadow.runId = "another_run" },
    f => { f.sourcePhase.shadow.expectedDeviceId = "different" },
    f => { f.sourcePhase.preparedCandidate.rootHasZeroParents = false },
    f => { f.destinationPhase.settings.githubBranch = "main" },
    f => { f.sourcePhase.restart.settings.encryptionPassphraseSecretId = "new-id" },
  ]
  for (const [caseIndex, breakIt] of mutate.entries()) {
    const { input, count } = fixture()
    breakIt(input)
    assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible, "mutation case " + caseIndex)
    assert.equal(count(), 0)
  }
})

test("D144 rejects distinct adapter, SecretStorage callback, lease/durability functions and journal", () => {
  const faults: Array<(f: ReturnType<typeof fixture>["input"]) => void> = [
    f => { f.destinationPhase.adapter = { ...f.destinationPhase.adapter } },
    f => { f.destinationPhase.journal = { ...f.destinationPhase.journal } },
    f => { f.destinationPhase.getSecret = () => null },
    f => { f.destinationPhase.assertExclusiveInitiatorLease = async () => {} },
    f => { f.destinationPhase.assertCrashDurable = async () => {} },
    f => { f.destinationPhase.withExclusiveInitiatorLease = async body => body() },
    f => { f.sourcePhase.withExclusiveInitiatorLease = async body => body() },
  ]
  for (const [caseIndex, fault] of faults.entries()) {
    const { input } = fixture()
    fault(input)
    assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible, "interface case " + caseIndex)
  }
})

test("D144 a reconstructed manifest cannot be trusted with missing, extra or different Shadow records", () => {
  const { input } = fixture()
  input.shadowRecords = [{
    path: "test.md", pathId: "0".repeat(64), fileId: "f",
    rev: "r", size: 12, contentSha256: "e".repeat(64),
  }] as unknown as V4ReencryptionPhaseContinuityInput["shadowRecords"]
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
  const invalid = fixture().input
  invalid.shadowRecords = null as unknown as V4ReencryptionPhaseContinuityInput["shadowRecords"]
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(invalid), incompatible)
})

test("D144 rejects missing inputs and cannot be promoted by mutating a returned report", () => {
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(null as unknown as V4ReencryptionPhaseContinuityInput),
    incompatible)
  for (const broken of ["sourcePhase", "destinationPhase"] as const) {
    const { input } = fixture()
    input[broken] = null as never
    assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
  }
  for (const broken of ["sourceConfig", "expectedDestinationConfig"] as const) {
    const { input } = fixture()
    input.sourcePhase.shadow.remote[broken] = null as never
    assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
  }
  const missingBackup = fixture().input
  missingBackup.sourcePhase.backupReader = null as never
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(missingBackup), incompatible)
  const missingLease = fixture().input
  missingLease.sourcePhase.withExclusiveInitiatorLease = null as never
  missingLease.destinationPhase.withExclusiveInitiatorLease = null as never
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(missingLease), incompatible)
  const missingWalReader = fixture().input
  missingWalReader.sourcePhase.restart.journal.assertHealthySnapshot = null as never
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(missingWalReader), incompatible)
  const { input } = fixture()
  const result = auditV4ReencryptionCrossPhaseContinuity(input)
  input.destinationPhase.settings.githubBranch = "main"
  assert.deepEqual(result, sequential)
  assert.deepEqual(auditV4ReencryptionCrossPhaseContinuity(input), incompatible)
})
