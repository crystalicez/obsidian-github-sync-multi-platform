import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import {
  inspectV4ReencryptionRestartEvidence,
  type V4ReencryptionRestartInspection,
  type V4ReencryptionRestartInspectionInput,
} from "./reencryption-local-cutover-restart"
import {
  inspectV4ReencryptionLocalTransactionAfterCrash,
  type V4ReencryptionLocalRecoveryInput,
  type V4ReencryptionLocalRecoveryReport,
} from "./reencryption-local-transaction-recovery"

interface BestEffortRestartBinding {
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
}

export interface V4BestEffortReencryptionRestartInput
  extends Omit<V4ReencryptionRestartInspectionInput, "assertCrashDurable">,
  BestEffortRestartBinding {}

export interface V4BestEffortReencryptionLocalRecoveryInput
  extends Omit<V4ReencryptionLocalRecoveryInput, "assertCrashDurable">,
  BestEffortRestartBinding {}

export interface V4BestEffortReencryptionRestartReport extends V4ReencryptionRestartInspection {
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
}

export interface V4BestEffortReencryptionLocalRecoveryReport
  extends V4ReencryptionLocalRecoveryReport {
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
}

const EVIDENCE = "best-effort-wal-readback-not-power-loss-durable" as const

/**
 * Adapt the D136/D139 read-only inspectors to D165 authenticated WAL checks.
 * The checkpoint is not a crash-durability assertion: callers must never use
 * these reports to resume Sync, select Destination or clear old secrets.
 */
function restartCheckpoint(input: V4BestEffortReencryptionRestartInput): () => Promise<void> {
  if (input?.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || input.journal.sourceCommitSha !== input.sourceCommitSha
    || input.journal.destinationRepoId !== input.expected?.destinationRepoId) {
    throw new Error("Best-effort restart inspection requires risk acknowledgement and matching live WAL.")
  }
  const { wal, journal } = input
  const lease = wal.assertExclusiveStageLease
  const checkpoint = wal.assertBestEffortCheckpoint
  const reader = journal.assertHealthySnapshot
  const expected = Object.freeze({
    sourceCommitSha: input.sourceCommitSha,
    destinationRepoId: input.expected.destinationRepoId,
    generation: input.expectedWalGeneration,
  })
  const bindings = Object.freeze({
    runId: input.runId, indexRoot: input.indexRoot,
    backupRepoId: input.backupRepoId, expected: { ...input.expected },
    settings: { ...input.settings }, indexAdapter: input.indexAdapter,
    getSecret: input.getSecret, initiatorLease: input.assertExclusiveInitiatorLease,
  })
  const unchanged = () => input.wal === wal && input.journal === journal
    && wal.assertExclusiveStageLease === lease
    && wal.assertBestEffortCheckpoint === checkpoint
    && journal.assertHealthySnapshot === reader
    && journal.sourceCommitSha === expected.sourceCommitSha
    && journal.destinationRepoId === expected.destinationRepoId
    && input.sourceCommitSha === expected.sourceCommitSha
    && input.expectedWalGeneration === expected.generation
    && input.runId === bindings.runId && input.indexRoot === bindings.indexRoot
    && input.backupRepoId === bindings.backupRepoId
    && input.indexAdapter === bindings.indexAdapter
    && input.getSecret === bindings.getSecret
    && input.assertExclusiveInitiatorLease === bindings.initiatorLease
    && Object.entries(bindings.expected).every(([key, value]) =>
      input.expected[key as keyof typeof bindings.expected] === value)
    && Object.entries(bindings.settings).every(([key, value]) =>
      input.settings[key as keyof typeof bindings.settings] === value)

  return async () => {
    if (!unchanged()) throw new Error("Best-effort restart identity changed; Manual Recovery required.")
    await lease.call(wal)
    const report = await inspectV4BestEffortWalRecovery({
      storage: wal, journal, expected,
    })
    if (!unchanged() || report.observation !== "authenticated-uncommitted"
      || report.generation !== expected.generation || report.resumeSyncAuthorized !== false) {
      throw new Error("Best-effort restart WAL is uncertain; Manual Recovery required.")
    }
    await lease.call(wal)
    if (!unchanged()) throw new Error("Best-effort restart identity changed; Manual Recovery required.")
  }
}

export async function inspectV4BestEffortReencryptionRestartEvidence(
  input: V4BestEffortReencryptionRestartInput,
): Promise<V4BestEffortReencryptionRestartReport> {
  const checkpoint = restartCheckpoint(input)
  const report = await inspectV4ReencryptionRestartEvidence({
    ...input, assertCrashDurable: checkpoint,
  })
  return Object.freeze({ ...report, evidence: EVIDENCE })
}

export async function inspectV4BestEffortReencryptionLocalTransactionAfterCrash(
  input: V4BestEffortReencryptionLocalRecoveryInput,
): Promise<V4BestEffortReencryptionLocalRecoveryReport> {
  const checkpoint = restartCheckpoint(input)
  const report = await inspectV4ReencryptionLocalTransactionAfterCrash({
    ...input, assertCrashDurable: checkpoint,
  })
  return Object.freeze({ ...report, evidence: EVIDENCE })
}
