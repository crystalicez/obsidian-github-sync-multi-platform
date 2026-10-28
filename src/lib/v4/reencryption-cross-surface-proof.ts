import { loadV4LocalIndex } from "./local-index"
import { computeV4ReencryptionCandidateManifestDigest } from "./reencryption-candidate-manifest-digest"
import {
  inspectV4ReencryptionRestartEvidence,
  type V4ReencryptionRestartInspectionInput,
} from "./reencryption-local-cutover-restart"
import type { V4PreparedOrphanCommit } from "./reencryption-orphan-publication"
import type { V4ReencryptionJournalSnapshot } from "./reencryption-recovery-journal"
import {
  verifyV4ReencryptionShadowAgainstDestination,
  type V4ReencryptionShadowRemoteBindingInput,
} from "./reencryption-shadow-remote-binding"

export interface V4ReencryptionCrossSurfaceProofInput {
  readonly restart: V4ReencryptionRestartInspectionInput
  readonly shadow: V4ReencryptionShadowRemoteBindingInput
  /** Uncommitted candidate metadata used to recreate the digest sealed in the encrypted WAL. */
  readonly preparedCandidate: V4PreparedOrphanCommit
  /** Must retain a real exclusive initiator lease until its asynchronous body settles. */
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
}

export interface V4ReencryptionCrossSurfaceProofReport {
  readonly integrityScope: "read-only-wal-intent-local-shadow-and-verified-git"
  readonly observation: "all-surfaces-coherent-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4ReencryptionCrossSurfaceProofReport = Object.freeze({
  integrityScope: "read-only-wal-intent-local-shadow-and-verified-git",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const COHERENT: V4ReencryptionCrossSurfaceProofReport = Object.freeze({
  ...MANUAL, observation: "all-surfaces-coherent-uncommitted",
})

function coherentWal(
  wal: V4ReencryptionJournalSnapshot,
  input: V4ReencryptionCrossSurfaceProofInput,
  shadowDigest: string,
): boolean {
  const { restart, shadow, preparedCandidate: prepared } = input
  const remote = shadow.remote
  const candidate = wal.preparedCandidateReceipt
  const backup = wal.verifiedRefObservations.find(ref => ref.role === "backup")
  const destination = wal.verifiedRefObservations.find(ref => ref.role === "destination")
  return wal.generation === restart.expectedWalGeneration
    && wal.pendingIntents.length === 0 && wal.pendingRefIntents.length === 0
    && wal.verifiedRefObservations.length === 2 && wal.stageHandoffStarted === true
    && wal.requiresRemoteRevalidation === true
    && wal.cutoverAuthorized === false && wal.permissionToPublish === false
    && !!candidate && !!backup && !!destination
    && candidate.commitSha === restart.expected.destinationCommitSha
    && candidate.commitSha === prepared.commitSha
    && candidate.treeSha === prepared.treeSha
    && candidate.manifestSha256 === shadowDigest
    && destination.repoId === restart.expected.destinationRepoId
    && destination.commitSha === candidate.commitSha
    && destination.treeSha === candidate.treeSha
    && destination.manifestSha256 === shadowDigest
    && backup.repoId === restart.backupRepoId
    && backup.commitSha === restart.sourceCommitSha
    && backup.treeSha === remote.sourceTreeSha
    && backup.manifestSha256 === undefined
    && prepared.sourceTreeSha === backup.treeSha
    && prepared.pinnedSourceCommitSha === backup.commitSha
    && prepared.destinationRepoId === destination.repoId
    && prepared.physicalRepositoryId === remote.plan.physicalRepositoryId
    && prepared.verifiedFileCount >= 0
    && prepared.rootHasZeroParents === true
    && prepared.cutoverAuthorized === false
    && prepared.refPublished === false
}

function identitiesAgree(input: V4ReencryptionCrossSurfaceProofInput): boolean {
  const { restart, shadow, preparedCandidate: candidate } = input
  const remote = shadow.remote
  return restart.indexAdapter === shadow.adapter
    && restart.indexRoot === shadow.activeIndexRoot
    && restart.runId === shadow.runId
    && restart.expected.deviceId === shadow.expectedDeviceId
    && restart.assertExclusiveInitiatorLease === shadow.assertExclusiveInitiatorLease
    && restart.assertCrashDurable === shadow.assertCrashDurable
    && restart.expected.sourceRepoId === remote.plan.sourceRepoId
    && restart.expected.destinationRepoId === remote.plan.destinationRepoId
    && restart.expected.destinationRepoId === remote.expectedDestinationConfig.repoId
    && restart.sourceCommitSha === remote.plan.pinnedSourceCommitSha
    && restart.expected.destinationCommitSha === remote.destinationCommitSha
    && restart.sourceCommitSha === candidate.pinnedSourceCommitSha
    && candidate.destinationRepoId === remote.plan.destinationRepoId
    && candidate.commitSha === remote.destinationCommitSha
    && candidate.sourceTreeSha === remote.sourceTreeSha
    && candidate.deviceId === restart.expected.deviceId
    && remote.sourceConfig.repoId === restart.expected.sourceRepoId
    && restart.settings.encryptionPassphraseSecretId === restart.expected.sourcePassphraseSecretId
}

function identityFingerprint(input: V4ReencryptionCrossSurfaceProofInput): string {
  const { restart, shadow } = input
  return JSON.stringify({
    runId: restart.runId, indexRoot: restart.indexRoot,
    sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
    expectedWalGeneration: restart.expectedWalGeneration,
    expected: restart.expected, settings: restart.settings,
    shadowRoot: shadow.activeIndexRoot, shadowRun: shadow.runId, device: shadow.expectedDeviceId,
    remoteCommitSha: shadow.remote.destinationCommitSha,
    remoteSourceTreeSha: shadow.remote.sourceTreeSha,
    remotePlan: shadow.remote.plan, remoteSourceConfig: shadow.remote.sourceConfig,
    remoteDestinationConfig: shadow.remote.expectedDestinationConfig,
    remoteReceipts: shadow.remote.expectedReceipts, prepared: input.preparedCandidate,
  })
}

/**
 * D138: independently authenticated cross-surface READBACK in one caller-held
 * lease. Even complete matching observations are not an atomic durable commit.
 */
export async function inspectV4ReencryptionCrossSurfaceProof(
  input: V4ReencryptionCrossSurfaceProofInput,
): Promise<V4ReencryptionCrossSurfaceProofReport> {
  if (!input?.restart || !input.shadow?.remote || !input.preparedCandidate
    || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof input.restart.getSecret !== "function"
    || typeof input.restart.journal?.assertHealthySnapshot !== "function"
    || !identitiesAgree(input)) {
    throw new Error("Re-encryption cross-surface proof requires one pinned candidate, storage and exclusive lease.")
  }
  const { restart, shadow } = input
  const expected = identityFingerprint(input)
  const captured = {
    restart, shadow, prepared: input.preparedCandidate,
    holder: input.withExclusiveInitiatorLease,
    adapter: restart.indexAdapter, journal: restart.journal,
    walReader: restart.journal.assertHealthySnapshot,
    getSecret: restart.getSecret,
    lease: restart.assertExclusiveInitiatorLease,
    durable: restart.assertCrashDurable,
    remote: shadow.remote, github: shadow.remote.github,
    githubReader: {
      getRepositoryIdentity: shadow.remote.github.getRepositoryIdentity,
      getGitRef: shadow.remote.github.getGitRef,
      getGitCommit: shadow.remote.github.getGitCommit,
      getTreeAt: shadow.remote.github.getTreeAt,
      getBlob: shadow.remote.github.getBlob,
    },
    passphrase: shadow.remote.destinationPassphrase,
  }
  const unchanged = (): boolean =>
    input.restart === captured.restart && input.shadow === captured.shadow
    && input.preparedCandidate === captured.prepared
    && input.withExclusiveInitiatorLease === captured.holder
    && restart.indexAdapter === captured.adapter && restart.journal === captured.journal
    && restart.journal.assertHealthySnapshot === captured.walReader
    && restart.getSecret === captured.getSecret
    && restart.assertExclusiveInitiatorLease === captured.lease
    && restart.assertCrashDurable === captured.durable
    && shadow.remote === captured.remote && shadow.remote.github === captured.github
    && captured.github.getRepositoryIdentity === captured.githubReader.getRepositoryIdentity
    && captured.github.getGitRef === captured.githubReader.getGitRef
    && captured.github.getGitCommit === captured.githubReader.getGitCommit
    && captured.github.getTreeAt === captured.githubReader.getTreeAt
    && captured.github.getBlob === captured.githubReader.getBlob
    && shadow.remote.destinationPassphrase === captured.passphrase
    && identitiesAgree(input) && identityFingerprint(input) === expected

  let invoked = false
  const report = await captured.holder(async () => {
    if (invoked) throw new Error("Re-encryption cross-surface holder invoked inspection more than once.")
    invoked = true
    await captured.lease()
    await captured.durable()
    if (!unchanged()) return MANUAL
    if (captured.getSecret(restart.expected.destinationPassphraseSecretId) !== captured.passphrase
      || !captured.getSecret(restart.expected.sourcePassphraseSecretId)) return MANUAL
    const firstWal = await captured.walReader.call(captured.journal, restart.expectedWalGeneration)
    const firstWalBytes = JSON.stringify(firstWal)
    const firstLocal = await inspectV4ReencryptionRestartEvidence(restart)
    if (!unchanged() || firstLocal.observation !== "source-with-prepared-intent-uncommitted") return MANUAL

    const firstSource = JSON.stringify(await loadV4LocalIndex(captured.adapter, restart.indexRoot))
    const shadowRoot = restart.indexRoot + "-rekey-" + restart.runId
    const initialShadow = await loadV4LocalIndex(captured.adapter, shadowRoot)
    const shadowBytes = JSON.stringify(initialShadow)
    const records = Object.values(initialShadow.shards).flatMap(shard => Object.values(shard.records))
    const digest = computeV4ReencryptionCandidateManifestDigest({
      prepared: captured.prepared, sourceTreeSha: shadow.remote.sourceTreeSha,
      destinationConfig: shadow.remote.expectedDestinationConfig,
      expectedRecords: records, expectedReceipts: shadow.remote.expectedReceipts,
    })
    if (!coherentWal(firstWal, input, digest) || !unchanged()) return MANUAL

    const verified = await verifyV4ReencryptionShadowAgainstDestination(shadow)
    if (verified.observation !== "shadow-matches-verified-destination-uncommitted"
      || verified.destinationRepoId !== restart.expected.destinationRepoId
      || verified.destinationCommitSha !== restart.expected.destinationCommitSha
      || verified.verifiedFileCount !== records.length || !unchanged()) return MANUAL

    const secondLocal = await inspectV4ReencryptionRestartEvidence(restart)
    await captured.lease()
    await captured.durable()
    const secondSource = await loadV4LocalIndex(captured.adapter, restart.indexRoot)
    const secondShadow = await loadV4LocalIndex(captured.adapter, shadowRoot)
    const secondWal = await captured.walReader.call(captured.journal, restart.expectedWalGeneration)
    if (!unchanged() || secondLocal.observation !== "source-with-prepared-intent-uncommitted"
      || JSON.stringify(secondSource) !== firstSource
      || JSON.stringify(secondShadow) !== shadowBytes || JSON.stringify(secondWal) !== firstWalBytes
      || !coherentWal(secondWal, input, digest)
      || captured.getSecret(restart.expected.destinationPassphraseSecretId) !== captured.passphrase
      || !captured.getSecret(restart.expected.sourcePassphraseSecretId)
      || !unchanged()) return MANUAL
    return COHERENT
  })
  if (!invoked || !unchanged()) return MANUAL
  return report === COHERENT ? COHERENT : MANUAL
}
