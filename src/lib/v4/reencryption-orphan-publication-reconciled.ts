import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import type { V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import {
  publishV4ReencryptionOrphanRef,
  type V4PreparedOrphanCommit,
} from "./reencryption-orphan-publication"
import {
  inspectV4ReencryptionOrphanAfterAmbiguousPublication,
  type V4OrphanPublicationRecoveryInput,
} from "./reencryption-orphan-recovery"

export interface V4ReencryptionVerifiedOrphanPublishInput extends Omit<V4OrphanPublicationRecoveryInput,
  "github" | "plan" | "prepared"> {
  readonly github: V4OrphanPublicationRecoveryInput["github"] & Pick<GitHubClient, "createGitRef">
  readonly plan: V4OrphanReencryptionPlan
  readonly prepared: V4PreparedOrphanCommit
  /** A caller MUST persist a crash-DURABLE ref intent before returning. */
  readonly assertDurablePublicationIntent: () => Promise<void>
  readonly assertExclusiveMigrationLease: () => Promise<void>
}

export interface V4ReencryptionVerifiedOrphanPublishReport {
  readonly integrityScope: "create-only-orphan-ref-plus-complete-remote-readback"
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  readonly publicationOutcome: "response-confirmed" | "lost-response-reconciled"
  readonly destinationContentsReadbackVerified: true
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly otherDeviceMovementRequired: false
  readonly oldBranchUnchangedByThisOperation: true
  readonly backupRestoreVerified: false
  readonly durableJournalIndependentlyAudited: false
  readonly initiatingDeviceCutoverAuthorized: false
}

/**
 * D98 combines D96's create-only ref primitive with D97's independent,
 * exhaustive GitHub ciphertext and metadata readback.
 *
 * If the GitHub create response is lost AFTER the caller confirms it has
 * durably persisted the intent, read the actual destination and verify every
 * byte with the new passphrase. Do not retry the ref mutation or claim a
 * success if the ref is absent/conflicted, changes, or fails verification.
 *
 * The caller is responsible for a real platform durable intent journal and
 * exclusive lease. Fake callbacks MUST NOT be used by production. This
 * internal helper never switches local settings, modifies old/backup refs,
 * or enables the end-user Wizard before independent restore/WAL gates pass.
 */
export async function publishAndVerifyV4ReencryptionOrphanRef(
  input: V4ReencryptionVerifiedOrphanPublishInput,
): Promise<V4ReencryptionVerifiedOrphanPublishReport> {
  throwIfV4Aborted(input.signal)
  let journalIntentCompleted = false
  let createResponseConfirmed = false
  let originalError: unknown
  try {
    await publishV4ReencryptionOrphanRef({
      github: input.github,
      plan: input.plan,
      prepared: input.prepared,
      assertExclusiveMigrationLease: input.assertExclusiveMigrationLease,
      assertDurablePublicationIntent: async () => {
        await input.assertDurablePublicationIntent()
        throwIfV4Aborted(input.signal)
        journalIntentCompleted = true
      },
      signal: input.signal,
    })
    createResponseConfirmed = true
  } catch (error) {
    throwIfV4Aborted(input.signal)
    if (!journalIntentCompleted) throw error
    originalError = error
  }
  // Verify independently even when createGitRef returned HTTP 201. A
  // ref-pointer-only "success" is never enough to finish migration.
  let proof
  try {
    proof = await inspectV4ReencryptionOrphanAfterAmbiguousPublication(input)
  } catch (error) {
    throwIfV4Aborted(input.signal)
    if (originalError !== undefined) {
      throw new Error("Destination ref create outcome remains ambiguous; independent remote content recovery failed.", {
        cause: error,
      })
    }
    throw error
  }
  if (proof.outcome !== "destination-pinned-and-fully-verified"
    || proof.destinationContentsVerified !== true
    || proof.automaticallyRetryCreateAuthorized !== false
    || proof.overwriteAuthorized !== false
    || proof.localCutoverAuthorized !== false) {
    throw new Error("Destination publication is missing, conflicting, or not fully verified. Never retry create automatically.")
  }
  throwIfV4Aborted(input.signal)
  await input.assertExclusiveMigrationLease()
  throwIfV4Aborted(input.signal)
  return Object.freeze({
    integrityScope: "create-only-orphan-ref-plus-complete-remote-readback",
    destinationRepoId: input.plan.destinationRepoId,
    destinationCommitSha: input.prepared.commitSha,
    publicationOutcome: createResponseConfirmed ? "response-confirmed" : "lost-response-reconciled",
    destinationContentsReadbackVerified: true,
    verifiedFileCount: proof.verifiedFileCount,
    verifiedPlaintextBytes: proof.verifiedPlaintextBytes,
    otherDeviceMovementRequired: false,
    oldBranchUnchangedByThisOperation: true,
    backupRestoreVerified: false,
    durableJournalIndependentlyAudited: false,
    initiatingDeviceCutoverAuthorized: false,
  })
}
