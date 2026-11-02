import type { V4LocalIndexAdapter } from "./local-index"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT, V4ReencryptionSyncFencedError } from "./reencryption-sync-fence"

const FENCE_PATH = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9_./-]+$/u
const MAX_MARKER = 4096

/**
 * An identity-matched local Sync Fence is a REQUIRED read-only prerequisite,
 * not a cryptographic signature or permission to create a migration.
 * The caller still needs a live initiating lease and quiescent Runtime.
 */
export interface V4PersistedWalFenceInput {
  readonly adapter: Pick<V4LocalIndexAdapter, "read" | "exists">
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly assertLiveOwner: () => void
}

/** Recheck the persisted, same-run Fence at EVERY WAL write boundary. */
export function createV4PersistedWalFenceAssertion(
  input: V4PersistedWalFenceInput,
): () => Promise<void> {
  const { adapter, runId, sourceRepoId, destinationRepoId, assertLiveOwner } = input
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof assertLiveOwner !== "function" || !RUN.test(runId)
    || !REPO.test(sourceRepoId) || !REPO.test(destinationRepoId)
    || sourceRepoId === destinationRepoId
    || sourceRepoId.split("#")[0] !== destinationRepoId.split("#")[0]) {
    throw new V4ReencryptionSyncFencedError()
  }
  const read = adapter.read
  const exists = adapter.exists
  // Exactly the canonical D173 arming payload. Never treat merely present or
  // parseable JSON, or a different device/attempt's marker, as our Fence.
  const expected = JSON.stringify({
    schemaVersion: 1,
    phase: "migration-fenced-uncommitted",
    runId,
    sourceRepoId,
    destinationRepoId,
  })
  const check = () => {
    assertLiveOwner()
    if (input.adapter !== adapter || input.runId !== runId
      || input.sourceRepoId !== sourceRepoId
      || input.destinationRepoId !== destinationRepoId
      || input.assertLiveOwner !== assertLiveOwner
      || adapter.read !== read || adapter.exists !== exists) {
      throw new V4ReencryptionSyncFencedError()
    }
  }
  return Object.freeze(async () => {
    try {
      check()
      const rootPresent = await exists.call(adapter, V4_REENCRYPTION_SYNC_FENCE_ROOT)
      check()
      const markerPresent = await exists.call(adapter, FENCE_PATH)
      check()
      if (rootPresent !== true || markerPresent !== true) {
        throw new V4ReencryptionSyncFencedError()
      }
      const first = await read.call(adapter, FENCE_PATH)
      check()
      if (typeof first !== "string" || first.length > MAX_MARKER || first !== expected) {
        throw new V4ReencryptionSyncFencedError()
      }
      const second = await read.call(adapter, FENCE_PATH)
      check()
      if (second !== first) throw new V4ReencryptionSyncFencedError()
      if (await exists.call(adapter, V4_REENCRYPTION_SYNC_FENCE_ROOT) !== true) {
        throw new V4ReencryptionSyncFencedError()
      }
      check()
      if (await exists.call(adapter, FENCE_PATH) !== true) {
        throw new V4ReencryptionSyncFencedError()
      }
      check()
    } catch {
      // Missing/torn/unreadable Fence is NEVER an invitation to retry writes.
      throw new V4ReencryptionSyncFencedError()
    }
  })
}
