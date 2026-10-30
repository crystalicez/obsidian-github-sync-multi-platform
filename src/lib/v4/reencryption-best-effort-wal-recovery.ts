import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import type { V4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"

export interface V4BestEffortWalRecoveryInput {
  readonly storage: Pick<V4DesktopRekeyWalStorage, "assertBestEffortCheckpoint">
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  readonly expected: {
    readonly sourceCommitSha: string
    readonly destinationRepoId: string
    readonly generation: number
  }
}

export interface V4BestEffortWalRecoveryReport {
  readonly evidence: "best-effort-readback-not-power-loss-durable"
  readonly observation: "authenticated-uncommitted" | "manual-recovery-required"
  readonly generation: number | null
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4BestEffortWalRecoveryReport = Object.freeze({
  evidence: "best-effort-readback-not-power-loss-durable",
  observation: "manual-recovery-required",
  generation: null,
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})

/**
 * Reopens and authenticates a previously saved WAL generation. The report is
 * diagnostic only: neither readback nor AES-GCM authentication proves a
 * durable local Cutover or permission to retry a GitHub mutation.
 */
export async function inspectV4BestEffortWalRecovery(
  input: V4BestEffortWalRecoveryInput,
): Promise<V4BestEffortWalRecoveryReport> {
  const { storage, journal, expected } = input
  if (typeof storage?.assertBestEffortCheckpoint !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof expected?.sourceCommitSha !== "string"
    || !/^[0-9a-f]{40}$/u.test(expected.sourceCommitSha)
    || typeof expected.destinationRepoId !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9_./-]+$/u.test(expected.destinationRepoId)
    || !Number.isSafeInteger(expected.generation) || expected.generation < 1
    || journal.sourceCommitSha !== expected.sourceCommitSha
    || journal.destinationRepoId !== expected.destinationRepoId) {
    throw new Error("Invalid best-effort Re-encryption WAL recovery identity.")
  }

  const checkpoint = storage.assertBestEffortCheckpoint
  const read = journal.assertHealthySnapshot
  const identity = JSON.stringify(expected)
  const unchanged = () => storage.assertBestEffortCheckpoint === checkpoint
    && journal.assertHealthySnapshot === read
    && journal.sourceCommitSha === expected.sourceCommitSha
    && journal.destinationRepoId === expected.destinationRepoId
    && JSON.stringify(input.expected) === identity
    && input.storage === storage && input.journal === journal

  try {
    if (await checkpoint.call(storage) !== "best-effort-readback-only"
      || !unchanged()) return MANUAL
    const first = await read.call(journal, expected.generation)
    if (!unchanged() || first.generation !== expected.generation
      || first.cutoverAuthorized !== false || first.permissionToPublish !== false
      || first.requiresRemoteRevalidation !== true) return MANUAL
    if (await checkpoint.call(storage) !== "best-effort-readback-only"
      || !unchanged()) return MANUAL
    const second = await read.call(journal, expected.generation)
    if (!unchanged() || second.generation !== expected.generation
      || JSON.stringify(first) !== JSON.stringify(second)
      || await checkpoint.call(storage) !== "best-effort-readback-only"
      || !unchanged()) return MANUAL

    return Object.freeze({
      ...MANUAL,
      observation: "authenticated-uncommitted",
      generation: expected.generation,
    })
  } catch {
    return MANUAL
  }
}
