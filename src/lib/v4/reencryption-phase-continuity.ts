import { computeV4ReencryptionCandidateManifestDigest } from "./reencryption-candidate-manifest-digest"
import type { V4IndexFileRecord } from "./local-index"
import type { V4ReencryptionLiveBackupCrossSurfaceInput } from "./reencryption-live-backup-cross-surface"
import type { V4ReencryptionProposedCommitInspectionInput } from "./reencryption-proposed-commit-receipt"

/**
 * D144: pure cross-PHASE compatibility review, not a cross-snapshot proof.
 * D143 requires the active Source Settings/Index, while D142 requires
 * Destination Settings/Index. They CANNOT both succeed on the same stable
 * active root. A successful static identity comparison does not bridge the
 * unproved physical persistence transition between those phases.
 */
export interface V4ReencryptionPhaseContinuityInput {
  readonly sourcePhase: V4ReencryptionLiveBackupCrossSurfaceInput
  readonly destinationPhase: V4ReencryptionProposedCommitInspectionInput
  /** Caller-supplied snapshot of Shadow records; not authenticated by this pure audit. */
  readonly shadowRecords: readonly V4IndexFileRecord[]
}

export interface V4ReencryptionPhaseContinuityReport {
  readonly integrityScope: "pure-cross-phase-identity-audit-uncommitted"
  readonly observation: "identities-consistent-but-phases-sequential" | "incompatible-or-unverifiable-context"
  readonly singleAtomicSnapshotProofPossible: false
  readonly persistentTransitionAuthenticated: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "pure-cross-phase-identity-audit-uncommitted" as const,
  singleAtomicSnapshotProofPossible: false as const,
  persistentTransitionAuthenticated: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const INCOMPATIBLE: V4ReencryptionPhaseContinuityReport = Object.freeze({
  ...BASE, observation: "incompatible-or-unverifiable-context",
})
const SEQUENTIAL: V4ReencryptionPhaseContinuityReport = Object.freeze({
  ...BASE, observation: "identities-consistent-but-phases-sequential",
})

const SHA = /^[0-9a-f]{40}$/u
const DIGEST = /^[0-9a-f]{64}$/u

function settingsRepo(settings: V4ReencryptionProposedCommitInspectionInput["settings"]): string {
  return settings.githubOwner + "/" + settings.githubRepo + "#" + settings.githubBranch
}

/**
 * This method reads already-supplied nonsecret snapshots only; it deliberately
 * DOES NOT call D143, D142, any adapter, WAL reader, GitHub or SecretStorage.
 * On a mismatch it reports only incompatible, never selects a recovery path.
 */
export function auditV4ReencryptionCrossPhaseContinuity(
  input: V4ReencryptionPhaseContinuityInput,
): V4ReencryptionPhaseContinuityReport {
  const source = input?.sourcePhase
  const destination = input?.destinationPhase
  const restart = source?.restart
  const shadow = source?.shadow
  const remote = shadow?.remote
  const plan = remote?.plan
  const prepared = source?.preparedCandidate
  const marker = destination?.identity
  if (!restart || !shadow || !remote || !plan || !prepared || !marker
    || !remote.sourceConfig || !remote.expectedDestinationConfig || !source.backupReader
    || !destination.settings || !restart.settings || !restart.expected
    || !restart.journal || !destination.journal || !restart.indexAdapter
    || !destination.adapter || !Array.isArray(input.shadowRecords)
    || typeof source.withExclusiveInitiatorLease !== "function"
    || typeof destination.withExclusiveInitiatorLease !== "function"
    || typeof restart.assertExclusiveInitiatorLease !== "function"
    || typeof restart.assertCrashDurable !== "function"
    || typeof restart.getSecret !== "function"
    || typeof restart.journal.assertHealthySnapshot !== "function"
    || typeof destination.journal.assertHealthySnapshot !== "function"
    || !SHA.test(restart.sourceCommitSha)
    || !SHA.test(prepared.commitSha)
    || !SHA.test(prepared.treeSha)
    || !SHA.test(remote.sourceTreeSha)
    || !DIGEST.test(marker.manifestSha256)
    || !Number.isSafeInteger(marker.walGeneration) || marker.walGeneration <= 0) {
    return INCOMPATIBLE
  }
  let digest: string
  try {
    digest = computeV4ReencryptionCandidateManifestDigest({
      prepared, sourceTreeSha: remote.sourceTreeSha,
      destinationConfig: remote.expectedDestinationConfig,
      expectedRecords: input.shadowRecords,
      expectedReceipts: remote.expectedReceipts,
    })
  } catch { return INCOMPATIBLE }
  const same = restart.indexAdapter === shadow.adapter
    && restart.indexRoot === shadow.activeIndexRoot
    && restart.runId === shadow.runId
    && restart.expected.deviceId === shadow.expectedDeviceId
    && restart.assertExclusiveInitiatorLease === shadow.assertExclusiveInitiatorLease
    && restart.assertCrashDurable === shadow.assertCrashDurable
    && source.withExclusiveInitiatorLease === destination.withExclusiveInitiatorLease
    && marker.runId === restart.runId
    && marker.indexRoot === restart.indexRoot
    && marker.walGeneration === restart.expectedWalGeneration
    && marker.deviceId === restart.expected.deviceId
    && marker.sourceRepoId === restart.expected.sourceRepoId
    && marker.backupRepoId === restart.backupRepoId
    && marker.destinationRepoId === restart.expected.destinationRepoId
    && marker.sourceCommitSha === restart.sourceCommitSha
    && marker.sourceTreeSha === remote.sourceTreeSha
    && marker.destinationCommitSha === restart.expected.destinationCommitSha
    && marker.destinationCommitSha === remote.destinationCommitSha
    && marker.destinationTreeSha === prepared.treeSha
    && marker.destinationCommitSha === prepared.commitSha
    && marker.manifestSha256 === digest
    && marker.sourcePassphraseSecretId === restart.expected.sourcePassphraseSecretId
    && marker.destinationPassphraseSecretId === restart.expected.destinationPassphraseSecretId
    && plan.sourceRepoId === marker.sourceRepoId
    && plan.destinationRepoId === marker.destinationRepoId
    && plan.pinnedSourceCommitSha === marker.sourceCommitSha
    && prepared.physicalRepositoryId === plan.physicalRepositoryId
    && prepared.sourceTreeSha === marker.sourceTreeSha
    && prepared.pinnedSourceCommitSha === marker.sourceCommitSha
    && prepared.destinationRepoId === marker.destinationRepoId
    && prepared.deviceId === marker.deviceId
    && prepared.rootHasZeroParents === true
    && prepared.cutoverAuthorized === false
    && prepared.refPublished === false
    && remote.sourceConfig.repoId === marker.sourceRepoId
    && remote.expectedDestinationConfig.repoId === marker.destinationRepoId
    && source.backupReader.branchName === marker.backupRepoId.split("#")[1]
    && restart.indexAdapter === destination.adapter
    && restart.journal === destination.journal
    && restart.journal.sourceCommitSha === marker.sourceCommitSha
    && restart.journal.destinationRepoId === marker.destinationRepoId
    && restart.getSecret === destination.getSecret
    && restart.assertExclusiveInitiatorLease === destination.assertExclusiveInitiatorLease
    && restart.assertCrashDurable === destination.assertCrashDurable
    && settingsRepo(restart.settings) === marker.sourceRepoId
    && restart.settings.encryptionMode === "encrypted"
    && restart.settings.encryptionPassphraseSecretId === marker.sourcePassphraseSecretId
    && restart.settings.vault === marker.deviceId
    && settingsRepo(destination.settings) === marker.destinationRepoId
    && destination.settings.encryptionMode === "encrypted"
    && destination.settings.encryptionPassphraseSecretId === marker.destinationPassphraseSecretId
    && destination.settings.vault === marker.deviceId
  return same ? SEQUENTIAL : INCOMPATIBLE
}
