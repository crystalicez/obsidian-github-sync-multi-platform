import { throwIfV4Aborted } from "./cancellation"
import { computeV4GitBlobSha1 } from "./git-blob-identity"
import { inspectV4ReencryptionInventory } from "./reencryption-inventory"
import type { V4ReencryptionObjectReceipt, V4ReencryptionStageInput, V4ReencryptionStagingResult } from "./reencryption-staging-receipts"
import { stageV4ReencryptionVaultObjects } from "./reencryption-staging-receipts"
import type { V4ReencryptionRecoveryJournal, V4ReencryptionJournalSnapshot, V4ReencryptionRefIntent } from "./reencryption-recovery-journal"

/**
 * Binds D79's staged Git immutable objects to D80's encrypted intent WAL.
 * This is a testable *pre-publication* helper; it does not create Git refs,
 * resume an interrupted run, authenticate remotely stored Git objects,
 * verify a separate backup, or authorize cutover.
 */
export interface V4JournaledReencryptionStageInput extends V4ReencryptionStageInput {
  readonly journal: V4ReencryptionRecoveryJournal
  /** Must be a trusted platform-held exclusive lease, across processes. */
  readonly assertExclusiveStageLease: () => Promise<void>
  /** Mandatory for approved 3-branch staging. D86 Windows Node directory fsync
   * failures MUST abort before any remote Git Blob mutation. Optional only
   * for legacy isolated D81 staging experiments, which cannot publish. */
  readonly assertCrashDurable?: (() => Promise<void>) | undefined
  /** D102 explicit same-run transition AFTER full Backup readback. No
   * automatic resume of an existing WAL after a restart/crash. */
  readonly beginAfterVerifiedBackup?: {
    readonly expectedJournalGeneration: number
    readonly backupRef: V4ReencryptionRefIntent
  } | undefined
}

export interface V4JournaledReencryptionStagingResult extends V4ReencryptionStagingResult {
  readonly journalSnapshot: V4ReencryptionJournalSnapshot
}

function sameReceipt(a: V4ReencryptionObjectReceipt, b: V4ReencryptionObjectReceipt): boolean {
  return a.path === b.path && a.sha === b.sha && a.byteLength === b.byteLength
}

/**
 * New-run ONLY. Any previous journal (including a clean empty run) is a
 * recovery state requiring explicit inspection; NEVER silently reuse it.
 * A remote timeout or process loss after intent persists leaves it pending.
 */
export async function stageV4ReencryptionVaultObjectsWithJournal(
  input: V4JournaledReencryptionStageInput,
): Promise<V4JournaledReencryptionStagingResult> {
  throwIfV4Aborted(input.signal)
  if (input.journal.sourceCommitSha !== input.plan.pinnedSourceCommitSha
    || input.journal.destinationRepoId !== input.plan.destinationRepoId) {
    throw new Error("Re-encryption WAL source/destination binding mismatch.")
  }
  await input.assertExclusiveStageLease()
  throwIfV4Aborted(input.signal)
  if (input.beginAfterVerifiedBackup && typeof input.assertCrashDurable !== "function") {
    throw new Error("Re-encryption three-branch Staging requires a real crash-durable WAL barrier.")
  }
  const assertThreeBranchWalDurable = async () => {
    throwIfV4Aborted(input.signal)
    await input.assertExclusiveStageLease()
    throwIfV4Aborted(input.signal)
    if (input.beginAfterVerifiedBackup) {
      await input.assertCrashDurable!()
      throwIfV4Aborted(input.signal)
    }
  }
  await assertThreeBranchWalDurable()
  // Preflight before even touching a local journal, let alone GitHub.
  await inspectV4ReencryptionInventory({
    config: input.sourceConfig,
    head: input.sourceHead,
    shards: input.sourceShards,
    keyring: input.sourceKeyring,
    pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
  })
  await input.verifySourceStillPinned()
  await input.assertExclusiveStageLease()
  throwIfV4Aborted(input.signal)
  const previous = await input.journal.load()
  let progress: V4ReencryptionJournalSnapshot
  if (previous) {
    const handoff = input.beginAfterVerifiedBackup
    const approved = previous.verifiedRefObservations.length === 1
      ? previous.verifiedRefObservations[0] : undefined
    if (!handoff || !approved
      || !Number.isSafeInteger(handoff.expectedJournalGeneration)
      || previous.generation !== handoff.expectedJournalGeneration
      || approved.role !== "backup"
      || approved.repoId !== handoff.backupRef.repoId
      || approved.commitSha !== input.plan.pinnedSourceCommitSha
      || approved.commitSha !== handoff.backupRef.commitSha
      || approved.treeSha !== handoff.backupRef.treeSha
      || previous.stageHandoffStarted
      || previous.pendingRefIntents.length !== 0
      || previous.pendingIntents.length !== 0
      || previous.receipts.length !== 0) {
      throw new Error("Re-encryption WAL previous run requires manual recovery; automatic reuse is forbidden.")
    }
    // Explicit first-stage-only handoff, NOT replay/resume. All subsequent
    // runs will have receipts/intent and will be rejected.
    // Persist the one-time phase boundary BEFORE the first possible remote
    // blob upload, even for an empty vault. A restart must never replay it.
    progress = await input.journal.recordStagingHandoff(handoff.backupRef, previous.generation)
    await assertThreeBranchWalDurable()
    await input.journal.assertHealthySnapshot(progress.generation)
  } else {
    if (input.beginAfterVerifiedBackup) {
      throw new Error("Re-encryption WAL verified Backup handoff has no source journal.")
    }
    progress = await input.journal.begin()
  }
  let stagedObjects = 0
  const result = await stageV4ReencryptionVaultObjects({
    ...input,
    async stageImmutableObject(path, ciphertext) {
      await input.assertExclusiveStageLease()
      throwIfV4Aborted(input.signal)
      const planned: V4ReencryptionObjectReceipt = Object.freeze({
        path, sha: computeV4GitBlobSha1(ciphertext), byteLength: ciphertext.byteLength,
      })
      // WAL intent MUST complete before any network-side blob stage begins.
      progress = await input.journal.recordUploadIntent(planned, progress.generation)
      // The encrypted intent must be power-loss durable BEFORE GitHub can
      // persist an unreachable blob; confirmed write/readback is not enough.
      await assertThreeBranchWalDurable()
      await input.journal.assertHealthySnapshot(progress.generation)
      throwIfV4Aborted(input.signal)
      const returnedSha = await input.stageImmutableObject(path, ciphertext)
      // The remote may have written a blob even when this throws. Never retry
      // automatically or turn an unmatched reply into a confirmed receipt.
      throwIfV4Aborted(input.signal)
      await input.assertExclusiveStageLease()
      throwIfV4Aborted(input.signal)
      if (returnedSha !== planned.sha || computeV4GitBlobSha1(ciphertext) !== planned.sha) {
        throw new Error("Re-encryption WAL staged immutable blob SHA mismatch; intent remains unresolved.")
      }
      progress = await input.journal.appendReceipt(planned, progress.generation)
      await assertThreeBranchWalDurable()
      stagedObjects++
      return returnedSha
    },
  })
  await input.assertExclusiveStageLease()
  throwIfV4Aborted(input.signal)
  const verifiedJournal = await input.journal.load()
  await assertThreeBranchWalDurable()
  if (!verifiedJournal || verifiedJournal.generation !== progress.generation
    || verifiedJournal.pendingIntents.length !== 0
    || verifiedJournal.receipts.length !== result.receipts.length
    || stagedObjects !== result.receipts.length
    || !verifiedJournal.receipts.every((receipt, i) => sameReceipt(receipt, result.receipts[i]!))) {
    throw new Error("Re-encryption WAL staged receipts disagree with the completed vault manifest.")
  }
  await input.verifySourceStillPinned()
  throwIfV4Aborted(input.signal)
  return Object.freeze({
    ...result,
    journalSnapshot: verifiedJournal,
  })
}
