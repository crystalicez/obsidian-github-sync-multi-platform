import { createEmptyV4LocalIndex, isV4LocalIndexCacheComplete, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter, type V4IndexFileRecord } from "./local-index"
import { V4_RUNTIME_INDEX_ROOT } from "./reencryption-index-root"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"
import type { V4GitHubForkSourceTranscodeInventory } from "./reencryption-trusted-loader"

type Inventory = V4GitHubForkSourceTranscodeInventory
const sha = /^[a-f0-9]{40}$/u

// Compare authenticated remote record identity and bytes, ignoring only
// local mtime/dirty bookkeeping. Tombstones are not live file content.
function recordIdentity(record: V4IndexFileRecord): string {
  const { mtime: _mtime, dirty: _dirty, ...rest } = record
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)))
}

function assertIndexMatches(index: V4LocalIndex, inventory: Inventory, deviceId: string): void {
  const head = inventory.sourceHead
  if (!sha.test(inventory.pinnedSourceCommitSha) || index.repoId !== inventory.sourceConfig.repoId
    || index.deviceId !== deviceId || index.remoteCommitSha !== inventory.pinnedSourceCommitSha
    || index.mode !== "encrypted" || index.pathLayout !== "opaque-stable-v1"
    || index.epoch !== head.epoch || index.generation !== head.generation
    || !isV4LocalIndexCacheComplete(index)
    || JSON.stringify(Object.entries(index.shardHashes).sort()) !== JSON.stringify(Object.entries(head.shardHashes).sort())) {
    throw Error("Installed Re-encryption Index identity or generation differs from authenticated Git metadata.")
  }
  if (Object.keys(inventory.sourceShards).length !== Object.keys(index.shards).length) throw Error("Installed Re-encryption shard count differs.")
  for (const [bucket, remote] of Object.entries(inventory.sourceShards)) {
    const local = index.shards[bucket]
    if (!local || Object.keys(local.records).length !== Object.keys(remote.records).length) throw Error("Installed Re-encryption Index record count differs.")
    for (const [id, expected] of Object.entries(remote.records)) {
      const actual = local.records[id]
      if (!actual || actual.dirty === true || recordIdentity(actual) !== recordIdentity(expected)) {
        throw Error("Installed Re-encryption Index record identity differs from authenticated Git metadata.")
      }
    }
  }
}

export interface V4InstalledShadowReport {
  readonly status: "shadow-index-staged-uncommitted"
  readonly shadowRoot: string
  readonly destinationCommitSha: string
  readonly verifiedFileCount: number
  readonly evidence: "best-effort-readback-only"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly powerLossDurabilityProven: false
}

/** Read-only independent verification; does not grant activation authority. */
export async function verifyV4InstalledReencryptionShadow(input: {
  adapter: V4LocalIndexAdapter; runId: string; deviceId: string; source: Inventory; destination: Inventory
}): Promise<void> {
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, input.runId)
  const source = await loadV4LocalIndex(input.adapter, roots.sourceIndexRoot)
  const shadow = await loadV4LocalIndex(input.adapter, roots.shadowIndexRoot)
  assertIndexMatches(source, input.source, input.deviceId)
  assertIndexMatches(shadow, input.destination, input.deviceId)
  if (JSON.stringify(source) !== JSON.stringify(await loadV4LocalIndex(input.adapter, roots.sourceIndexRoot))
    || JSON.stringify(shadow) !== JSON.stringify(await loadV4LocalIndex(input.adapter, roots.shadowIndexRoot))) {
    throw Error("Installed Source or Shadow changed during recovery readback.")
  }
}

interface Scope {
  readonly adapter: V4LocalIndexAdapter
  readonly runId: string
  readonly deviceId: string
  readonly source: Inventory
  readonly destination: Inventory
  readonly assertLeaseAndOwner: () => Promise<void>
  readonly assertPhysicalParity: () => Promise<void>
  readonly checkpoint: () => Promise<void>
}

/** Installed best-effort staging only. The native WAL lease is held by the
 * caller for this entire operation. Never substitute this for a durability
 * barrier or allow an ambiguous previous directory to be overwritten. */
export async function stageV4InstalledReencryptionShadow(input: Scope): Promise<V4InstalledShadowReport> {
  const { adapter, runId, deviceId, source, destination, assertLeaseAndOwner, assertPhysicalParity, checkpoint } = input
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, runId)
  if (!deviceId || source.sourceConfig.repoId === destination.sourceConfig.repoId
    || source.sourceConfig.repoId.split("#")[0] !== destination.sourceConfig.repoId.split("#")[0]
    || source.sourceConfig.mode !== "encrypted" || destination.sourceConfig.mode !== "encrypted"
    || source.pinnedSourceCommitSha === destination.pinnedSourceCommitSha) throw Error("Invalid installed shadow identity.")
  const expected = new Map(source.sourceRecords.map(record => [record.path, record]))
  if (expected.size !== source.sourceRecords.length || destination.sourceRecords.length !== expected.size
    || new Set(destination.sourceRecords.map(record => record.path)).size !== expected.size
    || destination.sourceRecords.some(record => {
      const old = expected.get(record.path)
      return !old || record.deleted || old.size !== record.size || old.plaintextSha256 !== record.plaintextSha256
    })) throw Error("Installed Shadow Destination differs from authenticated Source content.")
  await assertLeaseAndOwner()
  const original = await loadV4LocalIndex(adapter, roots.sourceIndexRoot)
  assertIndexMatches(original, source, deviceId)
  const sealedSource = JSON.stringify(original)
  if (await adapter.exists(roots.shadowIndexRoot)) throw Error("Existing installed Shadow Index requires Manual Recovery.")
  const index = createEmptyV4LocalIndex({ repoId: destination.sourceConfig.repoId, deviceId, mode: "encrypted" })
  index.remoteCommitSha = destination.pinnedSourceCommitSha
  index.epoch = destination.sourceHead.epoch
  index.generation = destination.sourceHead.generation
  index.shardHashes = { ...destination.sourceHead.shardHashes }
  for (const [bucket, shard] of Object.entries(destination.sourceShards)) {
    const hash = index.shardHashes[bucket]
    if (hash === undefined) throw Error("Destination shard hash missing.")
    index.shards[bucket] = { bucket, hash, records: Object.fromEntries(Object.entries(shard.records).map(([id, record]) => {
      if (record.deleted || record.dirty) throw Error("Destination Shadow must contain only clean live records.")
      return [id, { ...record, dirty: false, ...(record.partPaths ? { partPaths: [...record.partPaths] } : {}) }]
    })) }
  }
  assertIndexMatches(index, destination, deviceId)
  await assertPhysicalParity()
  await assertLeaseAndOwner()
  if (JSON.stringify(await loadV4LocalIndex(adapter, roots.sourceIndexRoot)) !== sealedSource
    || await adapter.exists(roots.shadowIndexRoot)) throw Error("Installed Source or Shadow changed before staging.")
  await assertLeaseAndOwner()
  await saveV4LocalIndex(adapter, roots.shadowIndexRoot, index)
  await checkpoint()
  await assertLeaseAndOwner()
  const loaded = await loadV4LocalIndex(adapter, roots.shadowIndexRoot)
  assertIndexMatches(loaded, destination, deviceId)
  if (JSON.stringify(loaded.shards) !== JSON.stringify(index.shards)) throw Error("Installed Shadow Index readback differs.")
  await assertPhysicalParity()
  await checkpoint()
  await assertLeaseAndOwner()
  if (JSON.stringify(await loadV4LocalIndex(adapter, roots.sourceIndexRoot)) !== sealedSource
    || JSON.stringify(await loadV4LocalIndex(adapter, roots.shadowIndexRoot)) !== JSON.stringify(loaded)) {
    throw Error("Installed Source or Shadow changed during final readback.")
  }
  await assertLeaseAndOwner()
  return Object.freeze({ status: "shadow-index-staged-uncommitted", shadowRoot: roots.shadowIndexRoot,
    destinationCommitSha: destination.pinnedSourceCommitSha, verifiedFileCount: destination.sourceRecords.length,
    evidence: "best-effort-readback-only", localCutoverAuthorized: false, resumeSyncAuthorized: false,
    powerLossDurabilityProven: false })
}
