import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import { decodeV4RemoteConfig } from "./remote-index"

/**
 * A read-only, topology-independent preflight for the first-release
 * Re-encryption Wizard. Callers must obtain evidence from authenticated
 * platform/runtime reads, NEVER from user-editable flags.
 *
 * This function cannot start migration, write to a vault, or change Git refs.
 * Owner has approved topology A; the migration writer, verified backup,
 * second-device cutover and crash recovery are still incomplete, so this
 * preview deliberately remains blocked rather than authorizing publication.
 */
export type V4ReencryptionBlocker =
  | "migration-implementation-incomplete"
  | "source-authentication-unverified"
  | "source-snapshot-incomplete"
  | "backup-unverified"
  | "sync-in-progress"
  | "pending-recovery"
  | "conflicts-unresolved"
  | "local-edits-unresolved"
  | "other-devices-not-coordinated"
  | "git-history-risk-not-acknowledged"
  | "source-head-changed"
  | "source-head-unverified"
  | "source-kdf-metadata-missing"
  | "source-layout-unsupported"
  | "source-not-encrypted"

export interface V4ReencryptionEvidence {
  readonly sourceAuthenticated: boolean
  readonly snapshotComplete: boolean
  readonly backupVerified: boolean
  readonly syncIdle: boolean
  readonly recoveryClear: boolean
  readonly conflictsResolved: boolean
  readonly localChangesResolved: boolean
  readonly otherDevicesPaused: boolean
  readonly oldHistoryRiskAcknowledged: boolean
}

export interface V4ReencryptionReadinessInput {
  /** Full, bounded, authenticated bytes retrieved from a pinned remote source. */
  readonly sourceConfigBytes: Uint8Array
  readonly expectedRepositoryId: string
  /** Exact immutable source Git commit, NOT a branch name or 'HEAD'. */
  readonly pinnedSourceCommitSha: string
  /** Fresh HEAD read after inventory (null = cannot prove it). */
  readonly observedSourceCommitSha: string | null
  readonly requestedIterations: unknown
  /** Missing/untrusted evidence is never treated as affirmative. */
  readonly evidence?: Partial<V4ReencryptionEvidence> | undefined
}

export interface V4ReencryptionReadinessPreview {
  readonly status: "blocked"
  readonly sourceRepositoryId: string
  readonly pinnedSourceCommitSha: string
  readonly existingIterations: number | null
  readonly requestedIterations: number
  readonly blockers: readonly V4ReencryptionBlocker[]
}

const PROOF_TO_BLOCKER = {
  sourceAuthenticated: "source-authentication-unverified",
  snapshotComplete: "source-snapshot-incomplete",
  backupVerified: "backup-unverified",
  syncIdle: "sync-in-progress",
  recoveryClear: "pending-recovery",
  conflictsResolved: "conflicts-unresolved",
  localChangesResolved: "local-edits-unresolved",
  otherDevicesPaused: "other-devices-not-coordinated",
  oldHistoryRiskAcknowledged: "git-history-risk-not-acknowledged",
} as const satisfies { [K in keyof V4ReencryptionEvidence]: V4ReencryptionBlocker }

function assertSourceCommitSha(value: unknown): asserts value is string {
  // GitHub Git OIDs for this V4 repository use SHA-1 40-character lowercase hex.
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Re-encryption requires a pinned 40-character source commit SHA.")
  }
}

export function assessV4ReencryptionReadiness(
  input: V4ReencryptionReadinessInput,
): V4ReencryptionReadinessPreview {
  assertSourceCommitSha(input.pinnedSourceCommitSha)
  assertV4Pbkdf2Iterations(input.requestedIterations, V4_MIN_NEW_PBKDF2_ITERATIONS)

  // Reuse the production remote decoder: reject malformed config, unbounded
  // salt and KDF work before deriving any key or exposing a wizard action.
  if (!(input.sourceConfigBytes instanceof Uint8Array)) {
    throw new Error("Re-encryption requires authenticated remote config bytes.")
  }
  const config = decodeV4RemoteConfig(input.sourceConfigBytes)
  if (!input.expectedRepositoryId || config.repoId !== input.expectedRepositoryId) {
    throw new Error("Re-encryption source repository identity does not match the selected connection.")
  }

  const blockers: V4ReencryptionBlocker[] = []
  if (config.mode !== "encrypted") blockers.push("source-not-encrypted")
  if (config.pathLayout !== "opaque-stable-v1") blockers.push("source-layout-unsupported")
  if (config.kdf !== "PBKDF2-SHA-256" || config.algorithm !== "AES-GCM" || !config.kdfParams) {
    blockers.push("source-kdf-metadata-missing")
  }

  if (input.observedSourceCommitSha === null
    || !/^[0-9a-f]{40}$/u.test(input.observedSourceCommitSha)) {
    blockers.push("source-head-unverified")
  } else if (input.observedSourceCommitSha !== input.pinnedSourceCommitSha) {
    blockers.push("source-head-changed")
  }

  const evidenceKeys = Object.keys(PROOF_TO_BLOCKER) as Array<keyof V4ReencryptionEvidence>
  for (const key of evidenceKeys) {
    if (input.evidence?.[key] !== true) blockers.push(PROOF_TO_BLOCKER[key])
  }

  // The approved orphan-branch topology does NOT authorize incomplete
  // migration/cutover code to write to a Git ref or a local vault.
  blockers.push("migration-implementation-incomplete")
  return Object.freeze({
    status: "blocked",
    sourceRepositoryId: config.repoId,
    pinnedSourceCommitSha: input.pinnedSourceCommitSha,
    existingIterations: config.kdfParams?.iterations ?? null,
    requestedIterations: input.requestedIterations,
    blockers: Object.freeze(blockers),
  })
}
