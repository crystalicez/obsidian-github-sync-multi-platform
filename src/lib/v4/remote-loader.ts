import type { V4Keyring } from "./crypto"
import { boundedMap } from "./bounded-map"
import {
  isV4LocalIndexShardConsistent,
  type V4IndexFileRecord,
  type V4LocalIndex,
} from "./local-index"
import type { V4SyncOperation } from "./planner"
import { hashV4ShardRecords, toV4RemoteRecord } from "./shard-hash"
import {
  assertV4RemoteRecordSet,
  assertV4RemoteShardRecords,
  decodeV4RemoteConfig,
  decodeV4RemoteHead,
  decodeV4RemoteShard,
  v4RemoteShardPath,
} from "./remote-index"
import {
  effectiveV4PathLayout,
  expectedV4PathLayout,
  V4_CONFIG_PATH,
  V4_HEAD_PATH,
  type V4RemoteConfig,
  type V4RemoteHead,
} from "./protocol-types"

export interface V4RemoteLoaderGithub {
  getFileBytes(path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null>
}

export interface V4ObservedRemoteConfig {
  commitSha: string
  config: V4RemoteConfig
}

export interface V4RemoteState {
  config: V4RemoteConfig
  head: V4RemoteHead
  records: V4IndexFileRecord[]
  commitSha: string
}

function recordsFromIndex(index: V4LocalIndex): V4IndexFileRecord[] {
  return Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .filter(record => !record.deleted)
}

export function assertV4PathLayoutCompatible(
  remote: V4RemoteConfig,
  desired: V4RemoteConfig,
  operation: V4SyncOperation,
): void {
  const actual = effectiveV4PathLayout(remote)
  const expected = expectedV4PathLayout(desired.mode)
  if (actual === expected) return
  if (operation === "forcePush") return
  throw new Error(`Remote encrypted path layout is ${actual}; confirmed Force Push is required to migrate to ${expected}.`)
}

export async function loadV4RemoteConfig(
  input: { github: V4RemoteLoaderGithub; desiredConfig: V4RemoteConfig; observedRemoteConfig?: V4ObservedRemoteConfig },
  commitSha: string | undefined,
  operation: V4SyncOperation,
): Promise<V4RemoteConfig | null> {
  let config: V4RemoteConfig
  if (input.observedRemoteConfig && input.observedRemoteConfig.commitSha === commitSha) {
    config = input.observedRemoteConfig.config
  } else {
    const configFile = await input.github.getFileBytes(V4_CONFIG_PATH, commitSha)
    if (!configFile) return null
    config = decodeV4RemoteConfig(configFile.bytes)
  }
  if (config.repoId !== input.desiredConfig.repoId) throw new Error("V4 remote repository identity mismatch.")
  assertV4PathLayoutCompatible(config, input.desiredConfig, operation)
  return config
}

export async function loadV4RemoteState(
  input: { github: V4RemoteLoaderGithub; index: V4LocalIndex; keyring?: V4Keyring; maxConcurrentShardReads?: 1 | 2 },
  commitSha: string | undefined,
  config: V4RemoteConfig | null,
): Promise<V4RemoteState | null> {
  if (!config) return null
  const headFile = await input.github.getFileBytes(V4_HEAD_PATH, commitSha)
  if (!headFile) throw new Error("V4 remote head is missing.")
  const head = await decodeV4RemoteHead(headFile.bytes, config, input.keyring)
  const shardRecords = await boundedMap(Object.keys(head.shardHashes), input.maxConcurrentShardReads ?? 1, async bucket => {
    const expectedHash = head.shardHashes[bucket]
    let cached = isV4LocalIndexShardConsistent(input.index, bucket, expectedHash)
      ? input.index.shards[bucket]
      : undefined
    if (cached && await hashV4ShardRecords(Object.values(cached.records)) !== expectedHash) cached = undefined
    if (cached) {
      const remoteRecords = Object.fromEntries(
        Object.entries(cached.records).map(([pathId, record]) => [pathId, toV4RemoteRecord(record)]),
      )
      assertV4RemoteShardRecords({ bucket, records: remoteRecords }, bucket, config)
      return Object.values(remoteRecords)
    }
    const file = await input.github.getFileBytes(v4RemoteShardPath(bucket, config.mode), commitSha)
    if (!file) throw new Error(`V4 remote shard is missing: ${bucket}`)
    const shard = await decodeV4RemoteShard(file.bytes, bucket, config, input.keyring)
    if (await hashV4ShardRecords(Object.values(shard.records)) !== expectedHash) {
      throw new Error(`V4 remote shard hash mismatch: ${bucket}`)
    }
    return Object.values(shard.records)
  })
  const records: V4IndexFileRecord[] = shardRecords.flat()
  await assertV4RemoteRecordSet(records, config, input.keyring)
  return { config, head, records, commitSha: commitSha ?? "" }
}
