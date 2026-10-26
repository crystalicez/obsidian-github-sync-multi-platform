import type { GitHubClient } from "../github-api"
import { classifyV4MutationFailure } from "./git-mutation-policy"
import { throwIfV4Aborted } from "./cancellation"
import type { V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"
import {
  createV4FrozenSameRepositoryBackupRef,
  type V4FrozenBackupRefCreationInput,
} from "./reencryption-frozen-backup-ref"
import {
  inspectV4FrozenBackupAfterAmbiguousCreate,
  type V4FrozenBackupRecoveryInput,
} from "./reencryption-backup-reconcile"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"

/** Scoped only to the old-key Backup branch; never the live Source or destination. */
type BackupReaderWriter = V4FrozenBackupRecoveryInput["backup"] & Pick<GitHubClient, "createGitRef">

export interface V4CreateAndVerifyBackupInput {
  readonly plan: V4SameRepoReencryptionBackupBranchProposal
  readonly verifiedSource: V4ReencryptionVerifiedSource
  readonly source: V4FrozenBackupRefCreationInput["source"]
  readonly backup: BackupReaderWriter
  readonly expectedSourceTreeSha: string
  readonly originalPassphrase: string
  /** Caller-owned crash-DURABLE backup mutation intent, not an ordinary async save. */
  readonly assertDurableBackupIntent: () => Promise<void>
  readonly assertExclusiveMigrationLease: () => Promise<void>
  readonly signal?: AbortSignal | undefined
}

export interface V4CreatedAndVerifiedBackupReport {
  readonly integrityScope: "backup-ref-create-only-and-full-authenticated-content"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly pinnedSourceTreeSha: string
  readonly publicationOutcome:
    | "response-confirmed"
    | "lost-create-response-reconciled"
    | "post-create-readback-reconciled"
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly backupContentsReadbackVerified: true
  readonly backupRefCreateAttemptedByThisRun: true
  readonly independentlyProvenCreationProvenance: false
  readonly independentlyAuditedDurableIntent: false
  readonly installedObsidianRestoreVerified: false
  readonly independentStorageVerified: false
  readonly destinationPublicationAuthorized: false
  readonly initiatingDeviceCutoverAuthorized: false
  readonly oldSourceBranchMayKeepSyncing: true
}

/**
 * D99: closes the create/readback gap for a separately named old-key backup.
 * An existing branch, even one already pointing to the identical immutable
 * source SHA, cannot be adopted as a successful creation if OUR request was
 * never sent. That prevents pre-create collision/adversarial provenance spoofing.
 *
 * The live old branch keeps syncing; verify pinned Git commit, not mutable
 * old-source HEAD. A lost create response is reconciled with D95's READ-ONLY
 * full Git/AES-GCM/SHA-256 backup verifier. All outcomes forbid blind retry.
 *
 * No user-facing entrypoint. A caller has to supply an independently proven
 * power-loss-safe WAL and lease. A promise callback alone is NOT such proof.
 */
export async function createAndVerifyV4FrozenBackupRef(
  input: V4CreateAndVerifyBackupInput,
): Promise<V4CreatedAndVerifiedBackupReport> {
  throwIfV4Aborted(input.signal)
  const { plan, verifiedSource, backup, source } = input
  if (!plan || !verifiedSource
    || verifiedSource.integrityScope !== "all-live-objects"
    || verifiedSource.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || !Number.isSafeInteger(verifiedSource.verifiedFileCount)
    || verifiedSource.verifiedFileCount < 0
    || !/^(0|[1-9][0-9]*)$/u.test(verifiedSource.totalVerifiedPlaintextBytes)
    || typeof input.originalPassphrase !== "string"
    || !input.originalPassphrase) {
    throw new Error("Frozen backup requires a complete pinned original-source verification.")
  }
  await input.assertExclusiveMigrationLease()
  throwIfV4Aborted(input.signal)

  let createAttempted = false
  let createResponseReceived = false
  let originalError: unknown

  // Explicit delegation (not a spread of GitHubClient: methods live on its
  // prototype). Tracks the actual irreversible mutation boundary precisely.
  const scopedBackup = {
    branchName: backup.branchName,
    getRepositoryIdentity: () => backup.getRepositoryIdentity(),
    getRepositoryDefaultBranch: () => backup.getRepositoryDefaultBranch(),
    getGitRefOrNull: () => backup.getGitRefOrNull(),
    getGitCommit: (sha: string) => backup.getGitCommit(sha),
    async createGitRef(sha: string) {
      // The backup authorizer can lose the initiating-device lease while
      // remote preflight is running. Recheck at the mutation boundary.
      throwIfV4Aborted(input.signal)
      await input.assertExclusiveMigrationLease()
      throwIfV4Aborted(input.signal)
      createAttempted = true
      await backup.createGitRef(sha)
      createResponseReceived = true
    },
  }
  try {
    // Intent is stored before D93 can send its create-only GitHub request.
    // Preflight failures may leave a harmless intent, never a false mutation.
    await input.assertDurableBackupIntent()
    throwIfV4Aborted(input.signal)
    await createV4FrozenSameRepositoryBackupRef({
      plan, verifiedSource, source, backup: scopedBackup,
      expectedSourceTreeSha: input.expectedSourceTreeSha,
      signal: input.signal,
    })
  } catch (error) {
    throwIfV4Aborted(input.signal)
    if (!createAttempted
      || (!createResponseReceived && classifyV4MutationFailure(error) === "definitive")) throw error
    originalError = error
  }
  let recovery
  try {
    recovery = await inspectV4FrozenBackupAfterAmbiguousCreate({
      plan, backup,
      expectedSourceTreeSha: input.expectedSourceTreeSha,
      originalPassphrase: input.originalPassphrase,
      signal: input.signal,
    })
  } catch (error) {
    throwIfV4Aborted(input.signal)
    if (originalError !== undefined) {
      throw new Error("Frozen backup creation remains ambiguous; independent encrypted recovery failed.", {
        cause: error,
      })
    }
    throw error
  }
  if (recovery.outcome !== "matching-backup-full-readback"
    || recovery.backupContentsReadbackVerified !== true
    || recovery.verifiedFileCount !== verifiedSource.verifiedFileCount
    || recovery.verifiedPlaintextBytes !== verifiedSource.totalVerifiedPlaintextBytes
    || recovery.automaticallyRetryCreateAuthorized !== false
    || recovery.overwriteAuthorized !== false
    || recovery.cutoverAuthorized !== false) {
    throw new Error("Frozen backup is absent, conflicting, or not identical to the pinned original content.")
  }
  throwIfV4Aborted(input.signal)
  await input.assertExclusiveMigrationLease()
  throwIfV4Aborted(input.signal)
  if (!createAttempted) {
    throw new Error("Frozen backup cannot claim creation without sending an authenticated ref request.")
  }
  return Object.freeze({
    integrityScope: "backup-ref-create-only-and-full-authenticated-content",
    backupRepoId: plan.backupRepoId,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    pinnedSourceTreeSha: input.expectedSourceTreeSha,
    publicationOutcome: originalError === undefined ? "response-confirmed"
      : createResponseReceived ? "post-create-readback-reconciled" : "lost-create-response-reconciled",
    verifiedFileCount: recovery.verifiedFileCount,
    verifiedPlaintextBytes: recovery.verifiedPlaintextBytes,
    backupContentsReadbackVerified: true,
    backupRefCreateAttemptedByThisRun: true,
    independentlyProvenCreationProvenance: false,
    independentlyAuditedDurableIntent: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    initiatingDeviceCutoverAuthorized: false,
    oldSourceBranchMayKeepSyncing: true,
  })
}
