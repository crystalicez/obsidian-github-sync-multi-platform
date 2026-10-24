import { throwIfV4Aborted } from "./cancellation"
import { computeV4GitBlobSha1 } from "./git-blob-identity"
import { inspectV4ReencryptionInventory } from "./reencryption-inventory"
import type { V4ReencryptionObjectReceipt, V4ReencryptionStageInput, V4ReencryptionStagingResult } from "./reencryption-staging-receipts"
import { stageV4ReencryptionVaultObjects } from "./reencryption-staging-receipts"
import type { V4ReencryptionRecoveryJournal, V4ReencryptionJournalSnapshot } from "./reencryption-recovery-journal"

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
  if (previous) {
    throw new Error("Re-encryption WAL previous run requires manual recovery; automatic reuse is forbidden.")
  }
  let progress = await input.journal.begin()
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
      throwIfV4Aborted(input.signal)
      await input.assertExclusiveStageLease()
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
      stagedObjects++
      return returnedSha
    },
  })
  await input.assertExclusiveStageLease()
  throwIfV4Aborted(input.signal)
  const verifiedJournal = await input.journal.load()
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
