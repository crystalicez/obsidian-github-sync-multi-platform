import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { computeV4ReencryptionCandidateManifestDigest } from "./reencryption-candidate-manifest-digest"
import {
  captureV4ReencryptionInitiatorParityEvidence,
  verifyV4ReencryptionInitiatorLocalParity,
  type V4ReencryptionInitiatorParityInput,
} from "./reencryption-initiator-parity"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"
import type { V4CreatedAndVerifiedBackupReport } from "./reencryption-backup-create-verified"
import type { V4ReencryptionRestoreRehearsalReport } from "./reencryption-restore-rehearsal"
import {
  publishAndVerifyV4ReencryptionOrphanRef,
  type V4ReencryptionVerifiedOrphanPublishInput,
  type V4ReencryptionVerifiedOrphanPublishReport,
} from "./reencryption-orphan-publication-reconciled"

const SHA = /^[a-f0-9]{40}$/u

export interface V4ThreeBranchPublicationInput extends V4ReencryptionVerifiedOrphanPublishInput {
  readonly backupPlan: V4SameRepoReencryptionBackupBranchProposal
  /** D105: per-mutation full plaintext SHA-256 parity of initiating live Vault. */
  readonly initiatorLocalParity: V4ReencryptionInitiatorParityInput
  /** Read-only actual frozen Backup ref observer; never the live Source ref. */
  readonly backupRefReader: Pick<GitHubClient, "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" | "getGitRefOrNull" | "getGitCommit">
  readonly createdAndVerifiedBackup: V4CreatedAndVerifiedBackupReport
  /** D85 independent scratch restore report, NOT an installed Obsidian restore. */
  readonly scratchRestore: V4ReencryptionRestoreRehearsalReport
  /** Real platform WAL power-loss durability check, not just readback of a file. */
  readonly assertCrashDurable: () => Promise<void>
  /** Initiating vault must have no uncommitted local mutations at every boundary. */
  readonly assertInitiatingVaultUnchanged: () => Promise<void>
}

export interface V4ThreeBranchPublicationReport {
  readonly integrityScope: "three-branch-verified-backup-and-destination-remote-only"
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly originalSourceCommitSha: string
  readonly destinationCommitSha: string
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly backupContentsReadbackVerified: true
  readonly backupScratchRoundTripVerified: true
  readonly destinationContentsReadbackVerified: true
  readonly oldBranchSyncRemainsIndependent: true
  readonly powerLossDurabilityIndependentlyAudited: false
  readonly initiatingDeviceCutoverAuthorized: false
}

/**
 * D100: one strongly bound safety boundary for the point where an actual
 * destination branch becomes visible. Rejects cross-run/cross-repo/cross-tree
 * evidence, missing scratch restore or mismatched source/destination parity
 * BEFORE the D98 create-only GitHub ref mutation.
 *
 * Callers must provide REAL durable-WAL and local-edit guards; mocked no-op
 * guards in tests do not prove production safety. This function is not wired
 * to Settings/Sync and never changes the source or backup branch.
 */
export async function publishV4ThreeBranchDestinationAfterBackup(
  input: V4ThreeBranchPublicationInput,
): Promise<V4ThreeBranchPublicationReport> {
  return publishThreeBranchDestination(input, input.assertCrashDurable)
}

export interface V4BestEffortThreeBranchPublicationInput
  extends Omit<V4ThreeBranchPublicationInput, "assertCrashDurable"> {
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
  readonly assertBestEffortWalCheckpoint: () => Promise<void>
}

export async function publishV4ThreeBranchDestinationAfterBackupBestEffort(
  input: V4BestEffortThreeBranchPublicationInput,
): Promise<V4ThreeBranchPublicationReport> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.assertBestEffortWalCheckpoint !== "function") {
    throw new Error("Best-effort Destination publication requires explicit risk acknowledgement and authenticated WAL.")
  }
  return publishThreeBranchDestination(input, input.assertBestEffortWalCheckpoint)
}

async function publishThreeBranchDestination(
  input: Omit<V4ThreeBranchPublicationInput, "assertCrashDurable">,
  checkpoint: () => Promise<void>,
): Promise<V4ThreeBranchPublicationReport> {
  throwIfV4Aborted(input.signal)
  const { plan, backupPlan: b, prepared: p, createdAndVerifiedBackup: proof, scratchRestore: scratch } = input
  if (!plan || !b || !p || !proof || !scratch
    || plan.status !== "blocked-pending-migration-implementation"
    || b.status !== "blocked-pending-safe-backup-ref-implementation"
    || b.proof !== "owner-approved-same-repo-backup-topology-only"
    || proof.integrityScope !== "backup-ref-create-only-and-full-authenticated-content"
    || proof.backupContentsReadbackVerified !== true
    || proof.backupRefCreateAttemptedByThisRun !== true
    || proof.destinationPublicationAuthorized !== false
    || proof.initiatingDeviceCutoverAuthorized !== false
    || scratch.integrityScope !== "isolated-scratch-restore-roundtrip-only"
    || scratch.scratchReadbackMatched !== true || scratch.permissionToPublish !== false
    || scratch.cutoverAuthorized !== false
    || !SHA.test(b.pinnedSourceCommitSha) || !SHA.test(p.commitSha)
    || b.sourceRepoId !== plan.sourceRepoId
    || b.destinationRepoId !== plan.destinationRepoId
    || b.physicalRepositoryId !== plan.physicalRepositoryId
    || b.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || b.backupRepoId !== proof.backupRepoId
    || proof.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || proof.pinnedSourceTreeSha !== input.sourceTreeSha
    || scratch.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || p.destinationRepoId !== plan.destinationRepoId
    || p.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || p.sourceTreeSha !== input.sourceTreeSha
    || p.verifiedFileCount !== input.expectedRecords.length
    || p.stagedCiphertextObjectCount !== input.expectedReceipts.length
    || !Number.isSafeInteger(proof.verifiedFileCount) || proof.verifiedFileCount < 0
    || proof.verifiedFileCount !== scratch.roundTripFileCount
    || proof.verifiedFileCount !== p.verifiedFileCount
    || !/^(?:0|[1-9][0-9]*)$/u.test(proof.verifiedPlaintextBytes)
    || scratch.roundTripPlaintextBytes !== proof.verifiedPlaintextBytes
    || !input.initiatorLocalParity
    || input.initiatorLocalParity.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || input.initiatorLocalParity.verifiedSource.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || input.initiatorLocalParity.verifiedSource.verifiedFileCount !== proof.verifiedFileCount
    || input.initiatorLocalParity.verifiedSource.totalVerifiedPlaintextBytes !== proof.verifiedPlaintextBytes) {
    throw new Error("Re-encryption three-branch publication evidence does not match the pinned backup, source, scratch restore and orphan.")
  }

  // Every boundary must prove parity against the SAME original authenticated
  // source. D123 pins evidence within ONE parity call, but this publisher
  // invokes it repeatedly across async Git reads, WAL intent, and create-ref.
  // Caller-owned records must not become a new SHA authority between guards.
  const pinnedLocalParity = captureV4ReencryptionInitiatorParityEvidence(
    input.initiatorLocalParity,
  )

  // Backup/Scratch/Topology reports are TypeScript-readonly, NOT runtime
  // immutable. The journal-intent callback and remote reads yield to external
  // code before Git ref creation. Bind every accepted proof to this one run;
  // do not let a caller replace an affirmative Backup or scratch proof while
  // the initiating-vault parity still happens to match.
  const proofIdentity = JSON.stringify({
    plan, backupPlan: b, prepared: p, backup: proof, scratch,
    sourceTreeSha: input.sourceTreeSha, sourceConfig: input.sourceConfig,
  })
  const manifestIdentity = computeV4ReencryptionCandidateManifestDigest({
    prepared: p, sourceTreeSha: input.sourceTreeSha,
    destinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  })
  // A stable client object does not imply stable methods. A caller may swap
  // the Backup observer or Destination create method while WAL/GitHub awaits.
  const backupTransport = {
    branchName: input.backupRefReader.branchName,
    getRepositoryIdentity: input.backupRefReader.getRepositoryIdentity,
    getRepositoryDefaultBranch: input.backupRefReader.getRepositoryDefaultBranch,
    getGitRefOrNull: input.backupRefReader.getGitRefOrNull,
    getGitCommit: input.backupRefReader.getGitCommit,
  }
  const destinationTransport = {
    branchName: input.github.branchName,
    getRepositoryIdentity: input.github.getRepositoryIdentity,
    getRepositoryDefaultBranch: input.github.getRepositoryDefaultBranch,
    getGitRef: input.github.getGitRef,
    getGitRefOrNull: input.github.getGitRefOrNull,
    getGitCommit: input.github.getGitCommit,
    getTreeAt: input.github.getTreeAt,
    getBlob: input.github.getBlob,
    createGitRef: input.github.createGitRef,
  }
  const captured = {
    plan, backupPlan: b, prepared: p, backup: proof, scratch,
    records: input.expectedRecords, receipts: input.expectedReceipts,
    sourceConfig: input.sourceConfig, destinationConfig: input.expectedDestinationConfig,
    parity: input.initiatorLocalParity, backupReader: input.backupRefReader,
    github: input.github, sourceTreeSha: input.sourceTreeSha,
    signal: input.signal,
    destinationPassphrase: input.destinationPassphrase,
    assertExclusiveMigrationLease: input.assertExclusiveMigrationLease,
    assertInitiatingVaultUnchanged: input.assertInitiatingVaultUnchanged,
    assertDurablePublicationIntent: input.assertDurablePublicationIntent,
  }
  const assertEvidencePinned = () => {
    // Keep the original cancellation authority from crossing an async WAL or
    // GitHub boundary; callers cannot replace an aborted signal with a fresh one.
    throwIfV4Aborted(captured.signal)
    if (input.signal !== captured.signal
      || input.plan !== captured.plan || input.backupPlan !== captured.backupPlan
      || input.prepared !== captured.prepared || input.createdAndVerifiedBackup !== captured.backup
      || input.scratchRestore !== captured.scratch
      || input.expectedRecords !== captured.records || input.expectedReceipts !== captured.receipts
      || input.sourceConfig !== captured.sourceConfig
      || input.expectedDestinationConfig !== captured.destinationConfig
      || input.initiatorLocalParity !== captured.parity
      || input.backupRefReader !== captured.backupReader || input.github !== captured.github
      || input.backupRefReader.branchName !== backupTransport.branchName
      || input.backupRefReader.getRepositoryIdentity !== backupTransport.getRepositoryIdentity
      || input.backupRefReader.getRepositoryDefaultBranch !== backupTransport.getRepositoryDefaultBranch
      || input.backupRefReader.getGitRefOrNull !== backupTransport.getGitRefOrNull
      || input.backupRefReader.getGitCommit !== backupTransport.getGitCommit
      || input.github.branchName !== destinationTransport.branchName
      || input.github.getRepositoryIdentity !== destinationTransport.getRepositoryIdentity
      || input.github.getRepositoryDefaultBranch !== destinationTransport.getRepositoryDefaultBranch
      || input.github.getGitRef !== destinationTransport.getGitRef
      || input.github.getGitRefOrNull !== destinationTransport.getGitRefOrNull
      || input.github.getGitCommit !== destinationTransport.getGitCommit
      || input.github.getTreeAt !== destinationTransport.getTreeAt
      || input.github.getBlob !== destinationTransport.getBlob
      || input.github.createGitRef !== destinationTransport.createGitRef
      || input.sourceTreeSha !== captured.sourceTreeSha
      || input.destinationPassphrase !== captured.destinationPassphrase
      || input.assertExclusiveMigrationLease !== captured.assertExclusiveMigrationLease
      || input.assertInitiatingVaultUnchanged !== captured.assertInitiatingVaultUnchanged
      || input.assertDurablePublicationIntent !== captured.assertDurablePublicationIntent
      || JSON.stringify({
        plan, backupPlan: b, prepared: p, backup: proof, scratch,
        sourceTreeSha: input.sourceTreeSha, sourceConfig: input.sourceConfig,
      }) !== proofIdentity
      || computeV4ReencryptionCandidateManifestDigest({
        prepared: p, sourceTreeSha: input.sourceTreeSha,
        destinationConfig: input.expectedDestinationConfig,
        expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
      }) !== manifestIdentity) {
      throw new Error("Re-encryption three-branch publication evidence changed after validation.")
    }
  }

  // A D99 snapshot report does not prove the frozen Backup ref has not
  // subsequently moved. Reobserve it before mutation and after publication.
  const assertBackupStillFrozen = async () => {
    assertEvidencePinned()
    throwIfV4Aborted(captured.signal)
    const reader = input.backupRefReader
    const expectedRepo = b.backupRepoId.split("#")[0]
    if (!reader || reader.branchName !== b.backupBranch || !expectedRepo) {
      throw new Error("Re-encryption frozen Backup observer must use the exact Backup branch.")
    }
    const actualRepo = await reader.getRepositoryIdentity()
    throwIfV4Aborted(captured.signal)
    if (actualRepo.id !== b.physicalRepositoryId
      || actualRepo.fullName.toLowerCase() !== expectedRepo.toLowerCase()) {
      throw new Error("Re-encryption frozen Backup physical GitHub repository switched.")
    }
    const currentDefault = await reader.getRepositoryDefaultBranch()
    throwIfV4Aborted(captured.signal)
    if (currentDefault === b.backupBranch || currentDefault === plan.destinationBranch) {
      throw new Error("Re-encryption frozen Backup or Destination must not be the GitHub default branch.")
    }
    const observed = await reader.getGitRefOrNull()
    throwIfV4Aborted(captured.signal)
    if (!observed || observed.ref !== `refs/heads/${b.backupBranch}`
      || observed.type !== "commit" || observed.sha !== b.pinnedSourceCommitSha) {
      throw new Error("Re-encryption frozen Backup ref disappeared or changed from the pinned original.")
    }
    const commit = await reader.getGitCommit(b.pinnedSourceCommitSha)
    throwIfV4Aborted(captured.signal)
    if (commit.sha !== b.pinnedSourceCommitSha
      || commit.treeSha !== input.sourceTreeSha
      || !Array.isArray(commit.parentShas)) {
      throw new Error("Re-encryption frozen Backup Git commit or tree changed.")
    }
    assertEvidencePinned()
  }

  const guard = async () => {
    assertEvidencePinned()
    await assertBackupStillFrozen()
    throwIfV4Aborted(captured.signal)
    await input.assertExclusiveMigrationLease()
    throwIfV4Aborted(captured.signal)
    await input.assertInitiatingVaultUnchanged()
    throwIfV4Aborted(captured.signal)
    const parity = await verifyV4ReencryptionInitiatorLocalParity({
      ...pinnedLocalParity, signal: captured.signal,
    })
    if (parity.initiatorLocalCutoverAuthorized !== false
      || parity.checkedFileCount !== proof.verifiedFileCount
      || parity.checkedPlaintextBytes !== proof.verifiedPlaintextBytes) {
      throw new Error("Re-encryption initiating-device full local content parity failed.")
    }
    throwIfV4Aborted(captured.signal)
    assertEvidencePinned()
    await checkpoint()
    throwIfV4Aborted(captured.signal)
    assertEvidencePinned()
  }
  await guard()
  const published: V4ReencryptionVerifiedOrphanPublishReport =
    await publishAndVerifyV4ReencryptionOrphanRef({
      github: input.github,
      plan,
      prepared: p,
      sourceTreeSha: input.sourceTreeSha,
      sourceConfig: input.sourceConfig,
      expectedDestinationConfig: input.expectedDestinationConfig,
      expectedRecords: input.expectedRecords,
      expectedReceipts: input.expectedReceipts,
      destinationPassphrase: input.destinationPassphrase,
      signal: captured.signal,
      assertExclusiveMigrationLease: guard,
      assertPublicationEvidenceUnchanged: assertEvidencePinned,
      assertDurablePublicationIntent: async () => {
        await guard()
        // Persist the full exact ref+candidate intent (with caller-owned WAL).
        await input.assertDurablePublicationIntent()
        await guard()
      },
    })
  await guard()
  assertEvidencePinned()
  if (!published || published.destinationContentsReadbackVerified !== true
    || published.destinationRepoId !== plan.destinationRepoId
    || published.destinationCommitSha !== p.commitSha
    || published.verifiedFileCount !== proof.verifiedFileCount
    || published.verifiedPlaintextBytes !== proof.verifiedPlaintextBytes
    || published.initiatingDeviceCutoverAuthorized !== false) {
    throw new Error("Re-encryption published destination does not match the complete verified backup.")
  }
  return Object.freeze({
    integrityScope: "three-branch-verified-backup-and-destination-remote-only",
    sourceRepoId: b.sourceRepoId,
    backupRepoId: b.backupRepoId,
    destinationRepoId: plan.destinationRepoId,
    originalSourceCommitSha: plan.pinnedSourceCommitSha,
    destinationCommitSha: p.commitSha,
    verifiedFileCount: published.verifiedFileCount,
    verifiedPlaintextBytes: published.verifiedPlaintextBytes,
    backupContentsReadbackVerified: true,
    backupScratchRoundTripVerified: true,
    destinationContentsReadbackVerified: true,
    oldBranchSyncRemainsIndependent: true,
    powerLossDurabilityIndependentlyAudited: false,
    initiatingDeviceCutoverAuthorized: false,
  })
}
