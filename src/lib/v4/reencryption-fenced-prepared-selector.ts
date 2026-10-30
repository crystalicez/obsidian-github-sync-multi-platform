import type { V4LocalIndexAdapter } from "./local-index"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "./reencryption-sync-fence"
import {
  inspectV4BestEffortPreparedSelectorAfterRestart,
  stageV4BestEffortPreparedSelectorEvidence,
  type V4BestEffortPreparedSelectorRestartReport,
  type V4BestEffortPreparedSelectorStageInput,
  type V4BestEffortPreparedSelectorStageReport,
} from "./reencryption-prepared-selector-stage"

const PATH = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
const MAX_FENCE_BYTES = 512

interface PinnedFence {
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
}

/**
 * This is NOT a signed migration receipt. A byte-exact, independently
 * read-back D173 fence is required in addition to D170/D172 authenticated
 * WAL/Intent/Selector observations. The mere existence of the fence keeps
 * normal Sync paused, even if its identity has been corrupted.
 */
async function assertExactFence(
  adapter: V4LocalIndexAdapter,
  pinned: PinnedFence,
  assertLease: () => Promise<void>,
): Promise<void> {
  const expected = JSON.stringify({
    schemaVersion: 1,
    phase: "migration-fenced-uncommitted",
    runId: pinned.runId,
    sourceRepoId: pinned.sourceRepoId,
    destinationRepoId: pinned.destinationRepoId,
  })
  await assertLease()
  if (await adapter.exists(V4_REENCRYPTION_SYNC_FENCE_ROOT) !== true
    || await adapter.exists(PATH) !== true) {
    throw new Error("Missing Re-encryption Sync fence; Manual Recovery required.")
  }
  const first = await adapter.read(PATH)
  if (typeof first !== "string" || first.length > MAX_FENCE_BYTES || first !== expected) {
    throw new Error("Foreign, torn or noncanonical Re-encryption Sync fence; Manual Recovery required.")
  }
  await assertLease()
  if (await adapter.read(PATH) !== first
    || await adapter.exists(V4_REENCRYPTION_SYNC_FENCE_ROOT) !== true
    || await adapter.exists(PATH) !== true) {
    throw new Error("Re-encryption Sync fence changed; Manual Recovery required.")
  }
}

function wrapFencedHolder(input: V4BestEffortPreparedSelectorStageInput):
  V4BestEffortPreparedSelectorStageInput {
  const { restart, identity, withExclusiveInitiatorLease: holder } = input
  if (!restart || !identity || typeof holder !== "function"
    || typeof restart.assertExclusiveInitiatorLease !== "function"
    || typeof restart.indexAdapter?.read !== "function"
    || typeof restart.indexAdapter.exists !== "function") {
    throw new Error("Fenced Re-encryption requires an active migration holder and storage.")
  }
  const adapter = restart.indexAdapter
  const assertLease = restart.assertExclusiveInitiatorLease
  const pinned = Object.freeze({
    runId: identity.runId,
    sourceRepoId: identity.sourceRepoId,
    destinationRepoId: identity.destinationRepoId,
  })
  const expected = JSON.stringify(identity)
  const originalRestart = restart
  const originalKey = input.journalKey
  const unchanged = () => input.restart === originalRestart
    && input.identity === identity
    && JSON.stringify(identity) === expected
    && input.journalKey === originalKey
    && input.withExclusiveInitiatorLease === holder
    && restart.indexAdapter === adapter
    && restart.assertExclusiveInitiatorLease === assertLease
    && restart.runId === pinned.runId
    && restart.expected.sourceRepoId === pinned.sourceRepoId
    && restart.expected.destinationRepoId === pinned.destinationRepoId

  return {
    ...input,
    withExclusiveInitiatorLease: async <T>(body: () => Promise<T>): Promise<T> =>
      holder(async () => {
        if (!unchanged()) {
          throw new Error("Fenced Re-encryption identity changed; Manual Recovery required.")
        }
        await assertExactFence(adapter, pinned, assertLease)
        if (!unchanged()) {
          throw new Error("Fenced Re-encryption identity changed; Manual Recovery required.")
        }
        const result = await body()
        await assertExactFence(adapter, pinned, assertLease)
        if (!unchanged()) {
          throw new Error("Fenced Re-encryption identity changed; Manual Recovery required.")
        }
        return result
      }),
  }
}

/**
 * D176: internal one-shot preparation, not a Wizard Run. Reuses D172's only
 * encrypted prepared-evidence writer; no active selector, settings, secrets,
 * GitHub refs, or local index is switched. A lost fence readback after writing
 * leaves independent evidence intact for Manual Recovery.
 */
export async function stageV4FencedBestEffortPreparedSelector(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4BestEffortPreparedSelectorStageReport> {
  return stageV4BestEffortPreparedSelectorEvidence(wrapFencedHolder(input))
}

/**
 * D176: non-authorizing restart observation. Any torn/foreign fence remains a
 * hard Sync block and is reported as Manual Recovery, never as permission.
 */
export async function inspectV4FencedBestEffortPreparedSelectorAfterRestart(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4BestEffortPreparedSelectorRestartReport> {
  const guarded = wrapFencedHolder(input)
  try {
    return await inspectV4BestEffortPreparedSelectorAfterRestart(guarded)
  } catch {
    return Object.freeze({
      integrityScope: "read-only-prepared-selector-and-authenticated-wal",
      evidence: "best-effort-wal-readback-not-power-loss-durable",
      observation: "manual-recovery-required",
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      rollbackAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
    })
  }
}
