import type { V4Keyring } from "./crypto"
import {
  isV4LocalIndexShardConsistent,
  type V4IndexFileRecord,
  type V4LocalIndex,
} from "./local-index"
import type { V4SyncOperation } from "./planner"
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
  input: { github: V4RemoteLoaderGithub; desiredConfig: V4RemoteConfig },
  commitSha: string | undefined,
  operation: V4SyncOperation,
): Promise<V4RemoteConfig | null> {
  const configFile = await input.github.getFileBytes(V4_CONFIG_PATH, commitSha)
  if (!configFile) return null
  const config = decodeV4RemoteConfig(configFile.bytes)
  if (config.repoId !== input.desiredConfig.repoId) throw new Error("V4 remote repository identity mismatch.")
  assertV4PathLayoutCompatible(config, input.desiredConfig, operation)
  return config
}

export async function loadV4RemoteState(
  input: { github: V4RemoteLoaderGithub; index: V4LocalIndex; keyring?: V4Keyring },
  commitSha: string | undefined,
  config: V4RemoteConfig | null,
): Promise<V4RemoteState | null> {
  if (!config) return null
  const headFile = await input.github.getFileBytes(V4_HEAD_PATH, commitSha)
  if (!headFile) throw new Error("V4 remote head is missing.")
  const head = await decodeV4RemoteHead(headFile.bytes, config, input.keyring)
  const records: V4IndexFileRecord[] = []
  for (const bucket of Object.keys(head.shardHashes)) {
    const cached = isV4LocalIndexShardConsistent(input.index, bucket, head.shardHashes[bucket])
      ? input.index.shards[bucket]
      : undefined
    if (cached) {
      assertV4RemoteShardRecords({ bucket, records: cached.records }, bucket, config)
      records.push(...Object.values(cached.records))
      continue
    }
    const file = await input.github.getFileBytes(v4RemoteShardPath(bucket, config.mode), commitSha)
    if (!file) throw new Error(`V4 remote shard is missing: ${bucket}`)
    records.push(...Object.values((await decodeV4RemoteShard(file.bytes, bucket, config, input.keyring)).records))
  }
  await assertV4RemoteRecordSet(records, config, input.keyring)
  return { config, head, records, commitSha: commitSha ?? "" }
}

export function remoteV4StateFromLocalIndex(
  index: V4LocalIndex,
  commitSha: string,
  config: V4RemoteConfig,
): V4RemoteState {
  return {
    config,
    head: {
      formatVersion: 4,
      mode: index.mode,
      epoch: index.epoch,
      generation: index.generation,
      journalId: "",
      shardHashes: { ...index.shardHashes },
      updatedAt: 0,
      deviceId: index.deviceId,
    },
    records: recordsFromIndex(index).map(record => ({
      ...record,
      partPaths: record.partPaths ? [...record.partPaths] : undefined,
    })),
    commitSha,
  }
}
