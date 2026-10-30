import type { V4LocalIndexAdapter } from "./local-index"

export const V4_REENCRYPTION_SYNC_FENCE_ROOT = "github-sync-v4-rekey-sync-fence"
const FENCE_PATH = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9_./-]+$/u

/** A migration fence is a one-way pause until independently verified recovery. */
export class V4ReencryptionSyncFencedError extends Error {
  constructor() {
    super("Re-encryption is pending or its local fence cannot be verified. Sync and Force operations are paused; keep the recovery files and review the migration before proceeding.")
    this.name = "V4ReencryptionSyncFencedError"
  }
}

export interface V4ReencryptionSyncFenceInput {
  readonly adapter: V4LocalIndexAdapter
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  /** Caller must hold the initiating device's cooperative migration lease. */
  readonly assertExclusiveInitiatorLease: () => Promise<void>
}

export interface V4ReencryptionSyncFenceReport {
  readonly status: "reencryption-sync-fence-armed-uncommitted"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const active = new WeakMap<V4LocalIndexAdapter, boolean>()

/**
 * Call BEFORE starting any migration stage, while normal Sync is idle.
 * Never remove or overwrite the directory after an ambiguous write.
 * Root existence, including a torn mkdir, is enough to block all Sync runs.
 */
export async function armV4ReencryptionSyncFence(
  input: V4ReencryptionSyncFenceInput,
): Promise<V4ReencryptionSyncFenceReport> {
  if (!input || !RUN.test(input.runId)
    || !REPO.test(input.sourceRepoId) || !REPO.test(input.destinationRepoId)
    || input.sourceRepoId === input.destinationRepoId
    || input.sourceRepoId.split("#")[0] !== input.destinationRepoId.split("#")[0]
    || typeof input.adapter?.exists !== "function"
    || typeof input.adapter.mkdir !== "function"
    || typeof input.adapter.write !== "function"
    || typeof input.adapter.read !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function") {
    throw new Error("Invalid Re-encryption Sync fence identity or storage.")
  }
  const { adapter } = input
  if (active.has(adapter)) throw new V4ReencryptionSyncFencedError()
  active.set(adapter, true)
  const lease = input.assertExclusiveInitiatorLease
  const { exists, mkdir, write, read } = adapter
  const identity = Object.freeze({
    schemaVersion: 1 as const,
    phase: "migration-fenced-uncommitted" as const,
    runId: input.runId,
    sourceRepoId: input.sourceRepoId,
    destinationRepoId: input.destinationRepoId,
  })
  const pinned = JSON.stringify(identity)
  const unchanged = () => input.adapter === adapter
    && input.assertExclusiveInitiatorLease === lease
    && adapter.exists === exists && adapter.mkdir === mkdir
    && adapter.write === write && adapter.read === read
    && input.runId === identity.runId
    && input.sourceRepoId === identity.sourceRepoId
    && input.destinationRepoId === identity.destinationRepoId
  try {
    await lease()
    if (!unchanged() || await exists.call(adapter, V4_REENCRYPTION_SYNC_FENCE_ROOT) !== false
      || await exists.call(adapter, FENCE_PATH) !== false) throw new V4ReencryptionSyncFencedError()
    await mkdir.call(adapter, V4_REENCRYPTION_SYNC_FENCE_ROOT)
    await lease()
    if (!unchanged()) throw new V4ReencryptionSyncFencedError()
    await write.call(adapter, FENCE_PATH, pinned)
    await lease()
    if (!unchanged() || await read.call(adapter, FENCE_PATH) !== pinned
      || await exists.call(adapter, V4_REENCRYPTION_SYNC_FENCE_ROOT) !== true) {
      throw new V4ReencryptionSyncFencedError()
    }
    return Object.freeze({
      status: "reencryption-sync-fence-armed-uncommitted",
      localCutoverAuthorized: false, resumeSyncAuthorized: false,
      rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
    })
  } finally {
    active.delete(adapter)
  }
}

/** File content and checksum are not trusted: root presence is the fence. */
export async function assertV4ReencryptionSyncFenceClear(
  adapter: Pick<V4LocalIndexAdapter, "exists">,
): Promise<void> {
  try {
    if (await adapter.exists(V4_REENCRYPTION_SYNC_FENCE_ROOT) !== false
      || await adapter.exists(FENCE_PATH) !== false) throw new V4ReencryptionSyncFencedError()
  } catch {
    throw new V4ReencryptionSyncFencedError()
  }
}
