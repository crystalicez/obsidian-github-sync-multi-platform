import { throwIfV4Aborted } from "./cancellation"
import {
  computeV4ReencryptionCandidateManifestDigest,
  computeV4ReencryptionPreparationDigest,
} from "./reencryption-candidate-manifest-digest"
import {
  prepareV4ReencryptionOrphanCommit,
  type V4OrphanStagedCommitInput,
  type V4PreparedOrphanCommit,
} from "./reencryption-orphan-publication"
import type { V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"
import { captureV4ReencryptionInitiatorParityEvidence } from "./reencryption-initiator-parity"
import {
  inspectV4FrozenBackupAfterAmbiguousCreate,
  type V4FrozenBackupRecoveryInput,
} from "./reencryption-backup-reconcile"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import {
  stageV4ReencryptionVaultObjectsWithJournal,
  type V4JournaledReencryptionStageInput,
  type V4JournaledReencryptionStagingResult,
} from "./reencryption-journaled-staging"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"
import {
  inspectV4ReencryptionOrphanAfterAmbiguousPublication,
  type V4OrphanPublicationRecoveryInput,
} from "./reencryption-orphan-recovery"
import {
  createAndVerifyV4FrozenBackupRef,
  createAndVerifyV4FrozenBackupRefBestEffort,
  type V4CreateAndVerifyBackupInput,
  type V4CreatedAndVerifiedBackupReport,
} from "./reencryption-backup-create-verified"
import {
  publishV4ThreeBranchDestinationAfterBackup,
  type V4ThreeBranchPublicationInput,
  type V4ThreeBranchPublicationReport,
} from "./reencryption-three-branch-publish"
import type {
  V4ReencryptionRecoveryJournal,
  V4ReencryptionRefIntent,
  V4ReencryptionJournalSnapshot,
} from "./reencryption-recovery-journal"

type DurableLease = Pick<V4DesktopRekeyWalStorage,
  "assertExclusiveStageLease" | "assertCrashDurable">
type JournalCheckpoint = (generation?: number) => Promise<void>

interface JournalBound {
  readonly journal: V4ReencryptionRecoveryJournal
  /** Must be actual same-run, OS-exclusive desktop WAL, never a no-op in production. */
  readonly wal: DurableLease
  readonly signal?: AbortSignal | undefined
}

export interface V4JournaledBackupCreationInput
  extends Omit<V4CreateAndVerifyBackupInput, "assertDurableBackupIntent" | "assertExclusiveMigrationLease">, JournalBound {}

export interface V4JournaledThreeBranchStageInput
  extends Omit<V4JournaledReencryptionStageInput, "journal" | "assertExclusiveStageLease" | "assertCrashDurable" | "assertBestEffortWalCheckpoint">, JournalBound {}

export interface V4JournaledOrphanPreparationInput
  extends Omit<V4OrphanStagedCommitInput, "assertExclusiveMigrationLease">, JournalBound {}

export interface V4JournaledDestinationPublicationInput
  extends Omit<V4ThreeBranchPublicationInput,
    "assertDurablePublicationIntent" | "assertExclusiveMigrationLease" | "assertCrashDurable">, JournalBound {}

function sameRef(a: V4ReencryptionRefIntent, b: V4ReencryptionRefIntent): boolean {
  return a.role === b.role && a.repoId === b.repoId
    && a.commitSha === b.commitSha && a.treeSha === b.treeSha
    && a.manifestSha256 === b.manifestSha256
}

function findExactRef(
  values: readonly V4ReencryptionRefIntent[],
  intent: V4ReencryptionRefIntent,
): boolean {
  return values.some(item => sameRef(item, intent))
}

function assertJournalIdentity(
  journal: V4ReencryptionRecoveryJournal,
  source: string,
  destination: string,
): void {
  if (journal.sourceCommitSha !== source || journal.destinationRepoId !== destination) {
    throw new Error("Re-encryption WAL run identity disagrees with the immutable three-branch plan.")
  }
}

async function hold(wal: DurableLease, signal?: AbortSignal): Promise<void> {
  throwIfV4Aborted(signal)
  await wal.assertExclusiveStageLease()
  throwIfV4Aborted(signal)
  await wal.assertCrashDurable()
  throwIfV4Aborted(signal)
}

async function persistExactIntent(
  binding: Pick<JournalBound, "journal" | "signal">,
  intent: V4ReencryptionRefIntent,
  checkpoint: JournalCheckpoint,
): Promise<V4ReencryptionJournalSnapshot> {
  await checkpoint()
  const before = await binding.journal.load()
  if (!before) {
    throw new Error("Re-encryption WAL must be explicitly begun before GitHub ref mutation.")
  }
  if (before.pendingRefIntents.length > 0
    || before.verifiedRefObservations.some(ref => ref.role === intent.role)) {
    throw new Error("Re-encryption WAL has a previous ref intent; inspect remote and reconcile manually.")
  }
  const saved = await binding.journal.recordRefIntent(intent, before.generation)
  await checkpoint(saved.generation)
  await binding.journal.assertHealthySnapshot(saved.generation)
  if (!findExactRef(saved.pendingRefIntents, intent)
    || saved.verifiedRefObservations.some(ref => ref.role === intent.role)) {
    throw new Error("Re-encryption WAL exact Git ref intent is absent or already consumed.")
  }
  return saved
}

async function assertStillPersisted(
  binding: Pick<JournalBound, "journal" | "signal">,
  intent: V4ReencryptionRefIntent,
  generation: number,
  checkpoint: JournalCheckpoint,
): Promise<void> {
  await checkpoint(generation)
  const saved = await binding.journal.assertHealthySnapshot(generation)
  throwIfV4Aborted(binding.signal)
  if (saved.generation !== generation
    || !findExactRef(saved.pendingRefIntents, intent)
    || saved.permissionToPublish !== false || saved.cutoverAuthorized !== false) {
    throw new Error("Re-encryption WAL ref intent is stale, missing, or cannot authorize publication.")
  }
}

async function recordIndependentReadback(
  binding: Pick<JournalBound, "journal" | "signal">,
  intent: V4ReencryptionRefIntent, generation: number, checkpoint: JournalCheckpoint,
): Promise<void> {
  await assertStillPersisted(binding, intent, generation, checkpoint)
  const updated = await binding.journal.markRefReadbackObserved(intent, generation)
  if (!findExactRef(updated.verifiedRefObservations, intent)
    || updated.pendingRefIntents.some(r => r.role === intent.role)) {
    throw new Error("Re-encryption WAL failed to record exact independent ref readback.")
  }
  await checkpoint(updated.generation)
}

/**
 * D109: the approved three-branch staging path uses the SAME OS-bound WAL
 * as frozen Backup and orphan Destination publication. Unlike standalone
 * pre-release D81 experiments, a real WAL crash-durable barrier is required
 * before every irreversible Git Blob mutation and after writing each exact
 * intent/receipt. The platform barrier fails closed on Windows EPERM.
 *
 * No refs, source files, settings or local secrets are changed here.
 */
export async function stageV4JournaledThreeBranchVault(
  input: V4JournaledThreeBranchStageInput,
): Promise<V4JournaledReencryptionStagingResult> {
  assertJournalIdentity(input.journal, input.plan.pinnedSourceCommitSha, input.plan.destinationRepoId)
  if (!input.beginAfterVerifiedBackup) {
    throw new Error("Re-encryption three-branch staging requires a verified frozen Backup handoff.")
  }
  await hold(input.wal, input.signal)
  return stageV4ReencryptionVaultObjectsWithJournal({
    ...input,
    journal: input.journal,
    beginAfterVerifiedBackup: input.beginAfterVerifiedBackup,
    assertExclusiveStageLease: () => hold(input.wal, input.signal),
    assertCrashDurable: () => hold(input.wal, input.signal),
  })
}

export interface V4BestEffortJournaledThreeBranchStageInput
  extends Omit<V4JournaledThreeBranchStageInput, "wal"> {
  readonly wal: BestEffortJournalBinding["wal"]
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
}

/**
 * The owner-approved best-effort route is intentionally limited to one
 * verified-Backup handoff. Generation-bound WAL authentication precedes
 * each immutable Git Blob request; the normal strict route is unchanged.
 */
export async function stageV4BestEffortJournaledThreeBranchVault(
  input: V4BestEffortJournaledThreeBranchStageInput,
): Promise<V4JournaledReencryptionStagingResult> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || !input.beginAfterVerifiedBackup
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function") {
    throw new Error("Best-effort Staging requires verified Backup, live WAL and explicit risk acknowledgement.")
  }
  assertJournalIdentity(input.journal, input.plan.pinnedSourceCommitSha, input.plan.destinationRepoId)
  const checkpoint = bestEffortJournalCheckpoint(input)
  await checkpoint(input.beginAfterVerifiedBackup.expectedJournalGeneration)
  return stageV4ReencryptionVaultObjectsWithJournal({
    ...input,
    assertExclusiveStageLease: async () => {
      throwIfV4Aborted(input.signal)
      await input.wal.assertExclusiveStageLease()
      throwIfV4Aborted(input.signal)
    },
    assertBestEffortWalCheckpoint: generation => checkpoint(generation),
  })
}

/**
 * D111: a one-shot encrypted WAL intent BEFORE generating any unreachable
 * new-key metadata blob, Git tree or zero-parent commit. On a lost response
 * the old intent remains and this helper NEVER auto-retries.
 *
 * All metadata/tree/commit POST boundaries recheck the same OS WAL lease,
 * actual durability and exact generation/manifest evidence.
 */
export async function prepareV4JournaledOrphanCandidate(
  input: V4JournaledOrphanPreparationInput,
): Promise<V4PreparedOrphanCommit> {
  return prepareJournaledOrphanCandidate(input, () => hold(input.wal, input.signal))
}

export interface V4BestEffortJournaledOrphanPreparationInput
  extends Omit<V4JournaledOrphanPreparationInput, "wal"> {
  readonly wal: BestEffortJournalBinding["wal"]
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
}

export async function prepareV4BestEffortJournaledOrphanCandidate(
  input: V4BestEffortJournaledOrphanPreparationInput,
): Promise<V4PreparedOrphanCommit> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function") {
    throw new Error("Best-effort orphan preparation requires risk acknowledgement and live WAL storage.")
  }
  return prepareJournaledOrphanCandidate(input, bestEffortJournalCheckpoint(input))
}

async function prepareJournaledOrphanCandidate(
  input: Omit<V4JournaledOrphanPreparationInput, "wal">,
  checkpoint: JournalCheckpoint,
): Promise<V4PreparedOrphanCommit> {
  const { plan, staged, verifiedBackup } = input
  assertJournalIdentity(input.journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  await checkpoint()
  const starting = await input.journal.load()
  if (!starting || !starting.stageHandoffStarted
    || starting.candidatePreparationSha256 !== null
    || starting.pendingIntents.length > 0 || starting.pendingRefIntents.length > 0
    || verifiedBackup?.backupContentsReadbackVerified !== true
    || verifiedBackup.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || verifiedBackup.pinnedSourceTreeSha !== input.sourceTreeSha
    || !starting.verifiedRefObservations.some(r => r.role === "backup"
      && r.repoId === verifiedBackup.backupRepoId
      && r.commitSha === plan.pinnedSourceCommitSha && r.treeSha === input.sourceTreeSha)) {
    throw new Error("Re-encryption orphan candidate requires exact WAL Backup, complete staging, and unused one-shot preparation.")
  }
  const receipts = new Map(starting.receipts.map(r => [r.path, r] as const))
  if (receipts.size !== starting.receipts.length
    || receipts.size !== staged.receipts.length
    || staged.receipts.some(r => {
      const persisted = receipts.get(r.path)
      return !persisted || persisted.sha !== r.sha || persisted.byteLength !== r.byteLength
    })) {
    throw new Error("Re-encryption orphan candidate staged ciphertext differs from authenticated WAL receipts.")
  }
  const fingerprintCurrentCandidateInputs = () => computeV4ReencryptionPreparationDigest({
    sourceCommitSha: plan.pinnedSourceCommitSha,
    sourceTreeSha: input.sourceTreeSha,
    destinationRepoId: plan.destinationRepoId,
    destinationConfig: input.destinationConfig,
    sourceConfig: input.sourceConfig, deviceId: input.deviceId,
    journalId: input.journalId, createdAt: input.createdAt,
    expectedRecords: staged.records,
    expectedReceipts: staged.receipts,
  })
  const digest = fingerprintCurrentCandidateInputs()
  await input.journal.assertHealthySnapshot(starting.generation)
  const recorded = await input.journal.recordCandidatePreparationIntent(digest, starting.generation)
  const assertSealed = async () => {
    await checkpoint(recorded.generation)
    const saved = await input.journal.assertHealthySnapshot(recorded.generation)
    if (saved.candidatePreparationSha256 !== digest
      || fingerprintCurrentCandidateInputs() !== digest
      || saved.pendingIntents.length || saved.pendingRefIntents.length
      || saved.cutoverAuthorized !== false) {
      throw new Error("Re-encryption orphan candidate inputs or WAL intent changed before Git mutation.")
    }
  }
  await assertSealed()
  const prepared = await prepareV4ReencryptionOrphanCommit({
    ...input, assertExclusiveMigrationLease: assertSealed,
  })
  await assertSealed()
  const preparedReceipt = {
    commitSha: prepared.commitSha,
    treeSha: prepared.treeSha,
    manifestSha256: computeV4ReencryptionCandidateManifestDigest({
      prepared, sourceTreeSha: input.sourceTreeSha,
      destinationConfig: input.destinationConfig,
      expectedRecords: staged.records, expectedReceipts: staged.receipts,
    }),
  }
  const observed = await input.journal.recordPreparedCandidateReceipt(preparedReceipt, recorded.generation)
  await checkpoint(observed.generation)
  await input.journal.assertHealthySnapshot(observed.generation)
  if (observed.preparedCandidateReceipt?.commitSha !== preparedReceipt.commitSha
    || observed.preparedCandidateReceipt.treeSha !== preparedReceipt.treeSha
    || observed.preparedCandidateReceipt.manifestSha256 !== preparedReceipt.manifestSha256
    || observed.cutoverAuthorized !== false) {
    throw new Error("Re-encryption orphan candidate WAL receipt did not preserve the verified commit/tree.")
  }
  return prepared
}

/**
 * D102: trusted caller starts a new journal explicitly after source preflight.
 * This coordinator refuses auto-resume. It persists source-SHA-pinned Backup
 * ref intent BEFORE the create-only GitHub POST, then records a separate
 * readback observation only AFTER D99 verifies every original ciphertext file.
 *
 * Crash after POST but before confirmed observation => pending intent on disk.
 * Later callers MUST reconcile via the read-only D95 inspector and must not
 * invoke this create function again on the same journal.
 */
export async function createV4JournaledFrozenBackup(
  input: V4JournaledBackupCreationInput,
): Promise<V4CreatedAndVerifiedBackupReport> {
  const { plan } = input
  assertJournalIdentity(input.journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  const intent: V4ReencryptionRefIntent = Object.freeze({
    role: "backup",
    repoId: plan.backupRepoId,
    commitSha: plan.pinnedSourceCommitSha,
    treeSha: input.expectedSourceTreeSha,
  })
  const recorded = await persistExactIntent(input, intent, () => hold(input.wal, input.signal))
  const result = await createAndVerifyV4FrozenBackupRef({
    plan, verifiedSource: input.verifiedSource, source: input.source,
    backup: input.backup, expectedSourceTreeSha: input.expectedSourceTreeSha,
    originalPassphrase: input.originalPassphrase,
    signal: input.signal,
    assertExclusiveMigrationLease: () => hold(input.wal, input.signal),
    assertDurableBackupIntent: () => assertStillPersisted(input, intent, recorded.generation, () => hold(input.wal, input.signal)),
  })
  if (!result.backupContentsReadbackVerified
    || result.backupRepoId !== intent.repoId
    || result.pinnedSourceCommitSha !== intent.commitSha
    || result.pinnedSourceTreeSha !== intent.treeSha) {
    throw new Error("Re-encryption WAL authenticated Backup readback disagrees with ref intent.")
  }
  await recordIndependentReadback(input, intent, recorded.generation, () => hold(input.wal, input.signal))
  return result
}

type BestEffortJournalBinding = {
  readonly plan: Pick<V4SameRepoReencryptionBackupBranchProposal, "pinnedSourceCommitSha" | "destinationRepoId">
  readonly journal: V4ReencryptionRecoveryJournal
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
  readonly signal?: AbortSignal | undefined
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
}

function bestEffortJournalCheckpoint(input: BestEffortJournalBinding): JournalCheckpoint {
  const { plan, journal, wal } = input
  return async (requestedGeneration) => {
    throwIfV4Aborted(input.signal)
    await wal.assertExclusiveStageLease()
    throwIfV4Aborted(input.signal)
    const generation = requestedGeneration ?? (await journal.load())?.generation
    if (!generation) throw new Error("Best-effort Re-encryption needs an existing authenticated WAL run.")
    const report = await inspectV4BestEffortWalRecovery({
      storage: wal, journal,
      expected: {
        sourceCommitSha: plan.pinnedSourceCommitSha,
        destinationRepoId: plan.destinationRepoId,
        generation,
      },
    })
    throwIfV4Aborted(input.signal)
    if (report.observation !== "authenticated-uncommitted"
      || report.generation !== generation || report.remoteWritesAuthorized !== false) {
      throw new Error("Best-effort Re-encryption WAL is uncertain; Manual Recovery is required.")
    }
    await wal.assertExclusiveStageLease()
    throwIfV4Aborted(input.signal)
  }
}

export interface V4BestEffortJournaledBackupCreationInput
  extends Omit<V4JournaledBackupCreationInput, "wal"> {
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
}

/**
 * An explicit, Backup-only best-effort route for unsupported directory fsync.
 * Neither success nor readback authorizes Destination or local Cutover.
 */
export async function createV4BestEffortJournaledFrozenBackup(
  input: V4BestEffortJournaledBackupCreationInput,
): Promise<V4CreatedAndVerifiedBackupReport> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function") {
    throw new Error("Best-effort Re-encryption Backup needs risk acknowledgement and live WAL storage.")
  }
  const { plan, journal } = input
  assertJournalIdentity(journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  const checkpoint = bestEffortJournalCheckpoint(input)
  const intent: V4ReencryptionRefIntent = Object.freeze({
    role: "backup",
    repoId: plan.backupRepoId,
    commitSha: plan.pinnedSourceCommitSha,
    treeSha: input.expectedSourceTreeSha,
  })
  const recorded = await persistExactIntent(input, intent, checkpoint)
  const result = await createAndVerifyV4FrozenBackupRefBestEffort({
    plan, verifiedSource: input.verifiedSource, source: input.source,
    backup: input.backup, expectedSourceTreeSha: input.expectedSourceTreeSha,
    originalPassphrase: input.originalPassphrase, signal: input.signal,
    acknowledgement: input.acknowledgement,
    assertExclusiveMigrationLease: () => checkpoint(recorded.generation),
    assertBestEffortBackupIntent: () =>
      assertStillPersisted(input, intent, recorded.generation, checkpoint),
  })
  if (!result.backupContentsReadbackVerified
    || result.backupRepoId !== intent.repoId
    || result.pinnedSourceCommitSha !== intent.commitSha
    || result.pinnedSourceTreeSha !== intent.treeSha) {
    throw new Error("Best-effort Backup contents disagree with the exact encrypted WAL intent.")
  }
  await recordIndependentReadback(input, intent, recorded.generation, checkpoint)
  return result
}

export interface V4JournaledFrozenBackupRecoveryInput
  extends V4FrozenBackupRecoveryInput, JournalBound {
  readonly verifiedOriginalSource: V4ReencryptionVerifiedSource
}

export interface V4JournaledFrozenBackupRecoveryReport {
  readonly integrityScope: "read-only-frozen-backup-reconciliation-to-encrypted-wal"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly backedUpContentsVerified: true
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly automaticallyRetryCreateAuthorized: false
  readonly installedObsidianRestoreVerified: false
  readonly destinationPublicationAuthorized: false
  readonly initiatingDeviceCutoverAuthorized: false
}

/**
 * D103: explicit recovery entrypoint AFTER a restart, a lost GitHub POST
 * response, and an operator-confirmed WAL lock recovery. It NEVER calls a
 * GitHub mutation: checks exact pending WAL intent, then independently
 * authenticates every frozen Backup ciphertext byte by immutable Git SHA.
 * Only complete matching content can be recorded as a WAL readback
 * observation; it is still NOT installed restore/durability/cutover evidence.
 */
export async function reconcileV4PendingFrozenBackupWithJournal(
  input: V4JournaledFrozenBackupRecoveryInput,
): Promise<V4JournaledFrozenBackupRecoveryReport> {
  return reconcileFrozenBackup(input, () => hold(input.wal, input.signal))
}

export interface V4BestEffortJournaledBackupRecoveryInput
  extends Omit<V4JournaledFrozenBackupRecoveryInput, "wal"> {
  readonly wal: BestEffortJournalBinding["wal"]
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
}

export async function reconcileV4PendingFrozenBackupWithJournalBestEffort(
  input: V4BestEffortJournaledBackupRecoveryInput,
): Promise<V4JournaledFrozenBackupRecoveryReport> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function") {
    throw new Error("Best-effort Backup Recovery needs risk acknowledgement and live WAL storage.")
  }
  return reconcileFrozenBackup(input, bestEffortJournalCheckpoint(input))
}

async function reconcileFrozenBackup(
  input: Omit<V4JournaledFrozenBackupRecoveryInput, "wal">,
  checkpoint: JournalCheckpoint,
): Promise<V4JournaledFrozenBackupRecoveryReport> {
  const { plan } = input
  assertJournalIdentity(input.journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  if (!input.verifiedOriginalSource
    || input.verifiedOriginalSource.integrityScope !== "all-live-objects"
    || input.verifiedOriginalSource.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption Backup WAL recovery requires a verified immutable Source snapshot.")
  }
  const intent: V4ReencryptionRefIntent = {
    role: "backup",
    repoId: plan.backupRepoId,
    commitSha: plan.pinnedSourceCommitSha,
    treeSha: input.expectedSourceTreeSha,
  }
  await checkpoint()
  const initial = await input.journal.load()
  if (!initial || initial.pendingRefIntents.length !== 1
    || !findExactRef(initial.pendingRefIntents, intent)
    || initial.verifiedRefObservations.length !== 0
    || initial.pendingIntents.length !== 0) {
    throw new Error("Re-encryption Backup WAL recovery requires one exact unresolved frozen ref intent.")
  }
  await input.journal.assertHealthySnapshot(initial.generation)
  const full = await inspectV4FrozenBackupAfterAmbiguousCreate({
    plan, backup: input.backup,
    expectedSourceTreeSha: input.expectedSourceTreeSha,
    originalPassphrase: input.originalPassphrase,
    signal: input.signal,
  })
  if (full.outcome !== "matching-backup-full-readback"
    || full.backupContentsReadbackVerified !== true
    || full.verifiedFileCount !== input.verifiedOriginalSource.verifiedFileCount
    || full.verifiedPlaintextBytes !== input.verifiedOriginalSource.totalVerifiedPlaintextBytes
    || full.automaticallyRetryCreateAuthorized !== false
    || full.overwriteAuthorized !== false || full.cutoverAuthorized !== false) {
    throw new Error("Re-encryption Backup WAL recovery is missing, conflicting or not fully authenticated.")
  }
  await recordIndependentReadback(input, intent, initial.generation, checkpoint)
  return Object.freeze({
    integrityScope: "read-only-frozen-backup-reconciliation-to-encrypted-wal",
    backupRepoId: intent.repoId,
    pinnedSourceCommitSha: intent.commitSha,
    backedUpContentsVerified: true,
    verifiedFileCount: full.verifiedFileCount,
    verifiedPlaintextBytes: full.verifiedPlaintextBytes,
    automaticallyRetryCreateAuthorized: false,
    installedObsidianRestoreVerified: false,
    destinationPublicationAuthorized: false,
    initiatingDeviceCutoverAuthorized: false,
  })
}

export interface V4JournaledOrphanRecoveryInput
  extends V4OrphanPublicationRecoveryInput, JournalBound {
  readonly backupPlan: V4SameRepoReencryptionBackupBranchProposal
  readonly backupRefReader: V4ThreeBranchPublicationInput["backupRefReader"]
  readonly verifiedOriginalSource: V4ReencryptionVerifiedSource
}

export interface V4JournaledOrphanRecoveryReport {
  readonly integrityScope: "read-only-orphan-reconciliation-to-encrypted-wal"
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly destinationContentsVerified: true
  readonly automaticallyRetryCreateAuthorized: false
  readonly independentlyAuditedDurability: false
  readonly initiatingDeviceCutoverAuthorized: false
}

/**
 * D103 read-only AFTER RESTART destination reconciliation. No GitHub writes,
 * no ref creation retry, no local cutover. The source manifest/expectedRecords
 * must be reconstructed and independently verified by the calling recovery
 * controller, not blindly loaded from a stale process memory buffer.
 */
export async function reconcileV4PendingOrphanWithJournal(
  input: V4JournaledOrphanRecoveryInput,
): Promise<V4JournaledOrphanRecoveryReport> {
  const { plan, prepared, backupPlan: b } = input
  assertJournalIdentity(input.journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  if (!prepared || !b || !input.verifiedOriginalSource
    || input.verifiedOriginalSource.integrityScope !== "all-live-objects"
    || input.verifiedOriginalSource.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || b.sourceRepoId !== plan.sourceRepoId || b.destinationRepoId !== plan.destinationRepoId
    || b.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || prepared.sourceTreeSha !== input.sourceTreeSha
    || prepared.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption destination WAL recovery has mismatched source and three-branch topology.")
  }
  const intent: V4ReencryptionRefIntent = {
    role: "destination", repoId: plan.destinationRepoId,
    commitSha: prepared.commitSha, treeSha: prepared.treeSha,
    manifestSha256: computeV4ReencryptionCandidateManifestDigest({
      prepared, sourceTreeSha: input.sourceTreeSha,
      destinationConfig: input.expectedDestinationConfig,
      expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
    }),
  }
  const backupIntent: V4ReencryptionRefIntent = {
    role: "backup", repoId: b.backupRepoId,
    commitSha: b.pinnedSourceCommitSha, treeSha: input.sourceTreeSha,
  }
  const checkBackup = async () => {
    throwIfV4Aborted(input.signal)
    const reader = input.backupRefReader
    if (!reader || reader.branchName !== b.backupBranch) {
      throw new Error("Re-encryption destination WAL recovery missing exact frozen Backup scope.")
    }
    const repo = await reader.getRepositoryIdentity()
    throwIfV4Aborted(input.signal)
    if (repo.id !== b.physicalRepositoryId
      || repo.fullName.toLowerCase() !== b.backupRepoId.split("#")[0]!.toLowerCase()) {
      throw new Error("Re-encryption destination WAL recovery Backup physical repository mismatch.")
    }
    const ref = await reader.getGitRefOrNull()
    throwIfV4Aborted(input.signal)
    if (!ref || ref.ref !== `refs/heads/${b.backupBranch}`
      || ref.type !== "commit" || ref.sha !== b.pinnedSourceCommitSha) {
      throw new Error("Re-encryption destination WAL recovery frozen Backup ref has changed.")
    }
    const commit = await reader.getGitCommit(b.pinnedSourceCommitSha)
    throwIfV4Aborted(input.signal)
    if (commit.sha !== b.pinnedSourceCommitSha || commit.treeSha !== input.sourceTreeSha) {
      throw new Error("Re-encryption destination WAL recovery frozen Backup tree changed.")
    }
  }
  await hold(input.wal, input.signal)
  const starting = await input.journal.load()
  if (!starting || starting.pendingRefIntents.length !== 1
    || !findExactRef(starting.pendingRefIntents, intent)
    || !findExactRef(starting.verifiedRefObservations, backupIntent)
    || !starting.stageHandoffStarted
    || starting.pendingIntents.length !== 0) {
    throw new Error("Re-encryption destination WAL recovery requires an exact pending Destination intent and verified Backup.")
  }
  const receipts = new Map(starting.receipts.map(r => [r.path, r] as const))
  if (receipts.size !== starting.receipts.length || receipts.size !== input.expectedReceipts.length
    || input.expectedReceipts.some(r => {
      const match = receipts.get(r.path)
      return !match || match.sha !== r.sha || match.byteLength !== r.byteLength
    })) {
    throw new Error("Re-encryption destination WAL recovery has mismatched staged ciphertext receipts.")
  }
  const candidateDigest = computeV4ReencryptionPreparationDigest({
    sourceCommitSha: plan.pinnedSourceCommitSha, sourceTreeSha: input.sourceTreeSha,
    destinationRepoId: plan.destinationRepoId,
    destinationConfig: input.expectedDestinationConfig,
    sourceConfig: input.sourceConfig, deviceId: prepared.deviceId,
    journalId: prepared.journalId, createdAt: prepared.createdAt,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  })
  if (starting.candidatePreparationSha256 !== candidateDigest) {
    throw new Error("Re-encryption destination recovery has a mismatched one-shot candidate preparation WAL intent.")
  }
  const completed = starting.preparedCandidateReceipt
  const expectedManifest = computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha: input.sourceTreeSha,
    destinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  })
  if (!completed || completed.commitSha !== prepared.commitSha
    || completed.treeSha !== prepared.treeSha
    || completed.manifestSha256 !== expectedManifest) {
    throw new Error("Re-encryption destination recovery requires the exact sealed candidate prepared receipt.")
  }
  await input.journal.assertHealthySnapshot(starting.generation)
  await checkBackup()
  const full = await inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    github: input.github, plan, prepared,
    sourceTreeSha: input.sourceTreeSha,
    sourceConfig: input.sourceConfig,
    expectedDestinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords,
    expectedReceipts: input.expectedReceipts,
    destinationPassphrase: input.destinationPassphrase,
    signal: input.signal,
  })
  if (full.outcome !== "destination-pinned-and-fully-verified"
    || !full.destinationContentsVerified
    || full.verifiedFileCount !== input.verifiedOriginalSource.verifiedFileCount
    || full.verifiedPlaintextBytes !== input.verifiedOriginalSource.totalVerifiedPlaintextBytes
    || full.automaticallyRetryCreateAuthorized !== false || full.localCutoverAuthorized !== false) {
    throw new Error("Re-encryption destination WAL recovery remote content is missing, conflicting or incomplete.")
  }
  await checkBackup()
  await recordIndependentReadback(input, intent, starting.generation, () => hold(input.wal, input.signal))
  return Object.freeze({
    integrityScope: "read-only-orphan-reconciliation-to-encrypted-wal",
    destinationRepoId: intent.repoId,
    destinationCommitSha: intent.commitSha,
    verifiedFileCount: full.verifiedFileCount,
    verifiedPlaintextBytes: full.verifiedPlaintextBytes,
    destinationContentsVerified: true,
    automaticallyRetryCreateAuthorized: false,
    independentlyAuditedDurability: false,
    initiatingDeviceCutoverAuthorized: false,
  })
}

/**
 * D102: ensures a completed, authenticated BACKUP ref observation is present
 * in the SAME encrypted WAL before D100 may even call the orphan publisher.
 * Every durability/lease callback is bound to the WAL, not a free-standing
 * success callback. The initiating-vault edit guard is still caller-provided.
 *
 * No local device cutover is performed or authorized.
 */
export async function publishV4JournaledThreeBranchDestination(
  input: V4JournaledDestinationPublicationInput,
): Promise<V4ThreeBranchPublicationReport> {
  const { plan, backupPlan, createdAndVerifiedBackup } = input
  assertJournalIdentity(input.journal, plan.pinnedSourceCommitSha, plan.destinationRepoId)
  // Pin the original Source hashes BEFORE awaiting WAL lease, reads or intent
  // persistence. D100 also snapshots on entry for non-journaled callers.
  const pinnedLocalParity = captureV4ReencryptionInitiatorParityEvidence(
    input.initiatorLocalParity,
  )
  const verifiedBackup: V4ReencryptionRefIntent = {
    role: "backup",
    repoId: backupPlan.backupRepoId,
    commitSha: backupPlan.pinnedSourceCommitSha,
    treeSha: createdAndVerifiedBackup.pinnedSourceTreeSha,
  }
  await hold(input.wal, input.signal)
  const starting = await input.journal.load()
  if (!starting || !findExactRef(starting.verifiedRefObservations, verifiedBackup)
    || !starting.stageHandoffStarted
    || starting.pendingRefIntents.length > 0 || starting.pendingIntents.length > 0) {
    throw new Error("Re-encryption WAL requires completed Backup readback and no unresolved mutations.")
  }
  // Prevent publishing ciphertext merely because a caller supplied a
  // structural D79 result: every Git blob must have an independently
  // persisted matching WAL receipt (not just an in-memory stage result).
  const receipts = new Map(starting.receipts.map(r => [r.path, r] as const))
  if (receipts.size !== starting.receipts.length
    || receipts.size !== input.expectedReceipts.length
    || input.expectedReceipts.some(r => {
      const persisted = receipts.get(r.path)
      return !persisted || persisted.sha !== r.sha || persisted.byteLength !== r.byteLength
    })) {
    throw new Error("Re-encryption WAL staged blob receipts do not match the completed destination inventory.")
  }
  const candidateDigest = computeV4ReencryptionPreparationDigest({
    sourceCommitSha: plan.pinnedSourceCommitSha, sourceTreeSha: input.sourceTreeSha,
    destinationRepoId: plan.destinationRepoId,
    destinationConfig: input.expectedDestinationConfig,
    sourceConfig: input.sourceConfig, deviceId: input.prepared.deviceId,
    journalId: input.prepared.journalId, createdAt: input.prepared.createdAt,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  })
  if (starting.candidatePreparationSha256 !== candidateDigest) {
    throw new Error("Re-encryption destination publication needs the exact sealed candidate preparation WAL intent.")
  }
  const intent: V4ReencryptionRefIntent = Object.freeze({
    role: "destination",
    repoId: plan.destinationRepoId,
    commitSha: input.prepared.commitSha,
    treeSha: input.prepared.treeSha,
    manifestSha256: computeV4ReencryptionCandidateManifestDigest({
      prepared: input.prepared, sourceTreeSha: input.sourceTreeSha,
      destinationConfig: input.expectedDestinationConfig,
      expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
    }),
  })
  const completed = starting.preparedCandidateReceipt
  if (!completed || completed.commitSha !== intent.commitSha
    || completed.treeSha !== intent.treeSha
    || completed.manifestSha256 !== intent.manifestSha256) {
    throw new Error("Re-encryption destination publication requires the exact sealed candidate prepared receipt.")
  }
  const recorded = await persistExactIntent(input, intent, () => hold(input.wal, input.signal))
  const result = await publishV4ThreeBranchDestinationAfterBackup({
    github: input.github, plan, backupPlan, createdAndVerifiedBackup,
    scratchRestore: input.scratchRestore, backupRefReader: input.backupRefReader,
    initiatorLocalParity: pinnedLocalParity,
    prepared: input.prepared, sourceTreeSha: input.sourceTreeSha,
    sourceConfig: input.sourceConfig, expectedDestinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
    destinationPassphrase: input.destinationPassphrase,
    assertInitiatingVaultUnchanged: input.assertInitiatingVaultUnchanged,
    signal: input.signal,
    assertCrashDurable: () => hold(input.wal, input.signal),
    assertExclusiveMigrationLease: () => hold(input.wal, input.signal),
    assertDurablePublicationIntent: () => assertStillPersisted(input, intent, recorded.generation, () => hold(input.wal, input.signal)),
  })
  if (!result.destinationContentsReadbackVerified
    || result.destinationRepoId !== intent.repoId
    || result.destinationCommitSha !== intent.commitSha
    || result.initiatingDeviceCutoverAuthorized !== false) {
    throw new Error("Re-encryption WAL destination full readback disagrees with the published Git ref.")
  }
  await recordIndependentReadback(input, intent, recorded.generation, () => hold(input.wal, input.signal))
  return result
}
