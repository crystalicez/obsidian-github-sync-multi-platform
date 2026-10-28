import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import { planV4OrphanReencryptionDestination } from "./reencryption-orphan-branch"
import { proposeV4SameRepositoryReencryptionBackupBranch } from "./reencryption-owner-decisions"

/**
 * D91: a sanitized THREE-BRANCH proposal for a read-only Wizard.
 * A proposal is never permission to create refs or change local configuration.
 * Secrets are validated but NEVER included in the returned object.
 */
export interface V4ReencryptionWizardDraft {
  readonly owner: string
  readonly repo: string
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly backupBranch: string
  readonly defaultBranch: string
  readonly sourceCommitSha: string
  readonly sourcePhysicalRepositoryId: number
  readonly requestedIterations: number
  readonly oldPassphrase: string
  readonly newPassphrase: string
  readonly confirmation: string
}

export interface V4ReencryptionWizardProposal {
  readonly status: "blocked-pending-production-migration"
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly physicalRepositoryId: number
  readonly requestedIterations: number
  readonly destinationOrphan: true
  readonly sourceRemainsSyncable: true
  readonly otherDeviceCutover: "optional-manual"
  /** Observes changes; never claims to prevent other programs from writing. */
  readonly initiatorVaultChangeDetection: "cross-platform-best-effort"
  readonly externalWritesPrevented: false
  /** One intentional review/confirmation before any real execution. */
  readonly userConfirmation: "once-before-execution"
  /** Desired finish behavior only; this proposal grants NO cutover authority. */
  readonly initiatorCutover: "automatic-after-verified-crash-safe-completion"
  /** Owner D133: do not retain obsolete local passphrase after a proven commit. */
  readonly oldPassphraseLocalRetention: "clear-after-proven-durable-cutover"
  /** Source/Backup/history still require the old passphrase to decrypt. */
  readonly oldPassphraseRequiredForOldBranches: true
  /** Proposal and read-only Wizard can NEVER clear SecretStorage. */
  readonly oldPassphraseCleanupAuthorized: false
  readonly sourceAndBackupRetained: true
  readonly actualBackupCreated: false
  readonly actualDestinationCreated: false
  readonly publicationAuthorized: false
  readonly localCutoverAuthorized: false
}

export function suggestV4ReencryptionBranchNames(date: Date, sourceCommitSha: string): Readonly<{
  destinationBranch: string
  backupBranch: string
}> {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Invalid re-encryption date.")
  if (!/^[a-f0-9]{40}$/u.test(sourceCommitSha)) throw new Error("Invalid pinned source commit SHA.")
  const dateLabel = date.toISOString().slice(0, 10)
  const suffix = sourceCommitSha.slice(0, 8)
  return Object.freeze({
    destinationBranch: `rekey/${dateLabel}-${suffix}`,
    backupBranch: `backup/rekey-${dateLabel}-${suffix}`,
  })
}

export function proposeV4ReencryptionWizardDraft(input: V4ReencryptionWizardDraft): V4ReencryptionWizardProposal {
  assertSafeGitHubRepositoryCoordinates(input.owner, input.repo)
  for (const branch of [input.sourceBranch, input.destinationBranch, input.backupBranch, input.defaultBranch]) {
    assertSafeGitHubBranch(branch)
  }
  assertV4Pbkdf2Iterations(input.requestedIterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
  if (!input.oldPassphrase || !input.newPassphrase || input.newPassphrase !== input.confirmation) {
    throw new Error("Enter and confirm a nonempty new encryption passphrase.")
  }
  if (input.oldPassphrase === input.newPassphrase) {
    throw new Error("The new encryption passphrase must differ from the old passphrase.")
  }
  if (input.destinationBranch === input.backupBranch) {
    throw new Error("Destination and backup branches must be different.")
  }
  const physicalId = input.sourcePhysicalRepositoryId
  const sourceRepoId = `${input.owner}/${input.repo}#${input.sourceBranch}`
  const destinationRepoId = `${input.owner}/${input.repo}#${input.destinationBranch}`
  const backupRepoId = `${input.owner}/${input.repo}#${input.backupBranch}`
  const destination = planV4OrphanReencryptionDestination({
    sourceRepoId, destinationRepoId, sourceCommitSha: input.sourceCommitSha,
    sourcePhysicalRepositoryId: physicalId,
    destinationPhysicalRepositoryId: physicalId,
    expectedPhysicalRepositoryId: physicalId,
    defaultBranch: input.defaultBranch,
  })
  const backup = proposeV4SameRepositoryReencryptionBackupBranch({
    sourceRepoId, destinationRepoId, backupRepoId,
    pinnedSourceCommitSha: input.sourceCommitSha,
    sourcePhysicalRepositoryId: physicalId,
    destinationPhysicalRepositoryId: physicalId,
    backupPhysicalRepositoryId: physicalId,
    expectedPhysicalRepositoryId: physicalId,
    defaultBranch: input.defaultBranch,
  })
  if (destination.destinationBranch !== input.destinationBranch || backup.backupBranch !== input.backupBranch) {
    throw new Error("Re-encryption branch proposal identity mismatch.")
  }
  return Object.freeze({
    status: "blocked-pending-production-migration",
    sourceRepoId, destinationRepoId, backupRepoId,
    pinnedSourceCommitSha: input.sourceCommitSha,
    physicalRepositoryId: physicalId,
    requestedIterations: input.requestedIterations,
    destinationOrphan: true,
    sourceRemainsSyncable: true,
    otherDeviceCutover: "optional-manual",
    initiatorVaultChangeDetection: "cross-platform-best-effort",
    externalWritesPrevented: false,
    userConfirmation: "once-before-execution",
    initiatorCutover: "automatic-after-verified-crash-safe-completion",
    oldPassphraseLocalRetention: "clear-after-proven-durable-cutover",
    oldPassphraseRequiredForOldBranches: true,
    oldPassphraseCleanupAuthorized: false,
    sourceAndBackupRetained: true,
    actualBackupCreated: false,
    actualDestinationCreated: false,
    publicationAuthorized: false,
    localCutoverAuthorized: false,
  })
}
