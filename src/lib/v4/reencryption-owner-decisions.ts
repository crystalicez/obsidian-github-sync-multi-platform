import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"

/**
 * Explicit owner answers on 2026-10-26. These are policy choices, NOT
 * evidence of a completed backup/restore or control over other clients.
 * Independent old-branch Sync remains allowed by explicit owner decision.
 *
 * Do not release a Wizard or invoke GitHub mutations from this module.
 */
export const V4_OWNER_REENCRYPTION_DECISIONS = Object.freeze({
  // D90 FINAL: branch FORK rather than fleet-wide cutover. Old branch stays writable.
  migrationTopology: "independent-orphan-branch-fork",
  oldBranchSync: "continue-independently-no-migration-block",
  otherDeviceCutover: "optional-manual-switch-branch-and-encryption",
  initiatorCutover: "switch-only-after-verified-new-branch-and-recovery",
  requireAllDevicesOnlineForMigration: false,
  oldBranchSyncBlockedByMigration: false,
  migrationSpecificPreSyncGuardRequired: false,
  vaultEditing: "pause-during-migration",
  backup: "separate-branch-in-original-github-repository",
  backupArchivePassword: "not-applicable",
  desktopWal: "nodejs-only-no-native-helper",
  powerLossTestAcceptance: "simulation-only-best-effort",
  physicalPowerLossGuaranteeClaimed: false,
  unverifiedDurabilityMayAuthorizeCutover: false,
  unsupportedDirectorySyncPolicy: "best-effort-with-explicit-warning-and-manual-recovery",
  bestEffortWalReadbackRequired: true,
  uncertainRestartRequiresManualRecovery: true,
  oldBranchRetention: "delete-only-after-explicit-user-action",
  // A separate branch in the SAME repository shares the same failure domain.
  independentBackupProvidedByChoiceC: false,
  // Owner explicitly accepted shared-repository loss risk for the release gate.
  // A fully verified backup branch is STILL required before the gate may pass.
  releaseBackupAcceptance: "verified-same-repository-branch",
  sharedRepositoryFailureDomainAccepted: true,
  independentBackupMandatoryForRelease: false,
  automaticCutoverAuthorized: false,
} as const)

const SHA = /^[0-9a-f]{40}$/u

function splitRepoId(value: string): { fullName: string; branch: string } {
  if (typeof value !== "string") throw new Error("Invalid backup repository identity.")
  const match = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(value)
  if (!match) throw new Error("Invalid backup repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { fullName: owner + "/" + repo, branch }
}

function positivePhysicalId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export interface V4SameRepoReencryptionBackupBranchProposalInput {
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly sourcePhysicalRepositoryId: number
  readonly destinationPhysicalRepositoryId: number
  readonly backupPhysicalRepositoryId: number
  readonly expectedPhysicalRepositoryId: number
  readonly defaultBranch: string
}

export interface V4SameRepoReencryptionBackupBranchProposal {
  readonly proof: "owner-approved-same-repo-backup-topology-only"
  readonly status: "blocked-pending-safe-backup-ref-implementation"
  readonly backupRepoId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly physicalRepositoryId: number
  readonly backupBranch: string
  readonly independentStorageVerified: false
  readonly actualBackupCreated: false
  readonly backupReadbackVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
  readonly oldBranchDeletionAuthorized: false
}

/**
 * Pure preflight for owner choice #3 C. No Git ref is created or copied.
 * Its proposed backup ref must remain distinct from source, destination
 * and default refs in the SAME physical repository. Only an authenticated
 * pinned source commit can later be pointed to by an explicitly built
 * backup writer with independent revalidation and recovery.
 */
export function proposeV4SameRepositoryReencryptionBackupBranch(
  input: V4SameRepoReencryptionBackupBranchProposalInput,
): V4SameRepoReencryptionBackupBranchProposal {
  const source = splitRepoId(input.sourceRepoId)
  const destination = splitRepoId(input.destinationRepoId)
  const backup = splitRepoId(input.backupRepoId)
  assertSafeGitHubBranch(input.defaultBranch)
  if (!SHA.test(input.pinnedSourceCommitSha)) {
    throw new Error("Re-encryption backup requires an exact pinned source commit SHA.")
  }
  if (!positivePhysicalId(input.expectedPhysicalRepositoryId)
    || input.sourcePhysicalRepositoryId !== input.expectedPhysicalRepositoryId
    || input.destinationPhysicalRepositoryId !== input.expectedPhysicalRepositoryId
    || input.backupPhysicalRepositoryId !== input.expectedPhysicalRepositoryId
    || source.fullName.toLowerCase() !== destination.fullName.toLowerCase()
    || source.fullName.toLowerCase() !== backup.fullName.toLowerCase()) {
    throw new Error("Re-encryption backup must use the exact same physical GitHub repository identity.")
  }
  if (source.branch === destination.branch
    || destination.branch === input.defaultBranch
    || backup.branch === source.branch
    || backup.branch === destination.branch
    || backup.branch === input.defaultBranch) {
    throw new Error("Re-encryption backup branch must be distinct from source, destination and default branches.")
  }

  return Object.freeze({
    proof: "owner-approved-same-repo-backup-topology-only",
    status: "blocked-pending-safe-backup-ref-implementation",
    sourceRepoId: input.sourceRepoId,
    destinationRepoId: input.destinationRepoId,
    backupRepoId: input.backupRepoId,
    pinnedSourceCommitSha: input.pinnedSourceCommitSha,
    physicalRepositoryId: input.expectedPhysicalRepositoryId,
    backupBranch: backup.branch,
    independentStorageVerified: false,
    actualBackupCreated: false,
    backupReadbackVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    oldBranchDeletionAuthorized: false,
  })
}
