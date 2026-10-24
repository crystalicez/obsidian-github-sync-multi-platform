import { sha256Hex, utf8ToBytes } from "../bytes"
import type { V4Keyring } from "./crypto"
import type { V4IndexFileRecord } from "./local-index"
import { assertV4RemoteRecordSet, assertV4RemoteShardRecords, type V4RemoteShard } from "./remote-index"
import type { V4RemoteConfig, V4RemoteHead } from "./protocol-types"

/**
 * Read-only structural inventory over a PINNED, already authenticated source
 * snapshot. The caller must fetch/decrypt head + every index shard from the
 * same immutable commit, and independently validate remote object *bytes*.
 *
 * Does not read GitHub, access the vault, write files, or authorize migration.
 */
export interface V4ReencryptionInventoryInput {
  readonly config: V4RemoteConfig
  readonly head: V4RemoteHead
  readonly shards: Readonly<Record<string, V4RemoteShard>>
  readonly keyring?: V4Keyring
  readonly pinnedSourceCommitSha: string
}

export interface V4ReencryptionInventoryPreview {
  readonly integrityScope: "metadata-only"
  readonly objectContentVerified: false
  readonly pinnedSourceCommitSha: string
  readonly fileCount: number
  readonly totalLogicalBytes: string
  readonly shardCount: number
  readonly distinctRemoteObjectCount: number
  readonly chunkedFileCount: number
  readonly packFileCount: number
}

function assertHeadMatchesConfig(head: V4RemoteHead, config: V4RemoteConfig): void {
  if (!head || typeof head !== "object" || Array.isArray(head)
    || head.formatVersion !== 4 || head.mode !== config.mode
    || !Number.isSafeInteger(head.epoch) || head.epoch < 0
    || !Number.isSafeInteger(head.generation) || head.generation < 0
    || head.generation >= Number.MAX_SAFE_INTEGER
    || typeof head.journalId !== "string"
    || typeof head.deviceId !== "string"
    || typeof head.updatedAt !== "number" || !Number.isFinite(head.updatedAt)
    || !head.shardHashes || typeof head.shardHashes !== "object" || Array.isArray(head.shardHashes)
    || !Object.entries(head.shardHashes).every(([bucket, signature]) =>
      /^[0-9a-f]{2}$/u.test(bucket) && typeof signature === "string" && /^[0-9a-f]{64}$/u.test(signature))) {
    throw new Error("Re-encryption inventory received an invalid remote head.")
  }
}

function objectPaths(record: V4IndexFileRecord): readonly string[] {
  return record.storage === "chunked" ? record.partPaths ?? [] : [record.remotePath]
}

function assertSafeCount(count: number): void {
  if (!Number.isSafeInteger(count)) throw new Error("Re-encryption inventory count exceeds safe precision.")
}

export async function inspectV4ReencryptionInventory(
  input: V4ReencryptionInventoryInput,
): Promise<V4ReencryptionInventoryPreview> {
  const { config, head, shards, keyring, pinnedSourceCommitSha } = input
  if (!/^[0-9a-f]{40}$/u.test(pinnedSourceCommitSha)) {
    throw new Error("Re-encryption inventory requires a pinned full source commit SHA.")
  }
  if (!config || config.formatVersion !== 4 || config.mode !== "encrypted"
    || config.pathLayout !== "opaque-stable-v1" || !config.repoId) {
    throw new Error("Re-encryption inventory requires supported encrypted V4 remote configuration.")
  }
  if (!keyring) throw new Error("Re-encryption inventory requires an authenticated encryption keyring.")
  assertHeadMatchesConfig(head, config)
  if (!shards || typeof shards !== "object" || Array.isArray(shards)) {
    throw new Error("Re-encryption inventory shards must be a complete bucket map.")
  }
  const headBuckets = Object.keys(head.shardHashes)
  const actualBuckets = Object.keys(shards)
  if (actualBuckets.length !== headBuckets.length
    || headBuckets.some(bucket => !Object.hasOwn(shards, bucket))
    || actualBuckets.some(bucket => !Object.hasOwn(head.shardHashes, bucket))) {
    throw new Error("Re-encryption inventory has missing or unexpected remote shard buckets.")
  }

  const records: V4IndexFileRecord[] = []
  // This signature follows sync-session.ts: JSON.stringify(records sorted by
  // pathId) and SHA-256 over those UTF-8 bytes. It is a logical record hash,
  // NOT proof that referenced remote ciphertext blobs actually exist.
  for (const bucket of headBuckets) {
    const shard = shards[bucket]
    if (!shard || shard.bucket !== bucket) {
      throw new Error("Re-encryption inventory has a missing or mismatched shard bucket.")
    }
    assertV4RemoteShardRecords(shard, bucket, config)
    const bucketRecords = Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId))
    if (bucketRecords.some(record => record.dirty === true)) {
      throw new Error("Re-encryption inventory contains an uncommitted dirty remote record.")
    }
    const signature = await sha256Hex(utf8ToBytes(JSON.stringify(bucketRecords)))
    if (signature !== head.shardHashes[bucket]) {
      throw new Error("Re-encryption inventory shard signature/hash does not match pinned head.")
    }
    records.push(...bucketRecords)
  }
  await assertV4RemoteRecordSet(records, config, keyring)

  let fileCount = 0
  let chunkedFileCount = 0
  let packFileCount = 0
  let totalLogicalBytes = BigInt(0)
  const occupiedObjects = new Map<string, { storage: V4IndexFileRecord["storage"]; packId?: string }>()
  for (const record of records) {
    if (record.deleted) continue
    if (!/^[0-9a-f]{64}$/u.test(record.plaintextSha256)) {
      throw new Error("Re-encryption inventory has an invalid logical plaintext hash.")
    }
    fileCount++
    totalLogicalBytes += BigInt(record.size)
    if (record.storage === "chunked") chunkedFileCount++
    if (record.storage === "pack") packFileCount++
    for (const objectPath of objectPaths(record)) {
      const existing = occupiedObjects.get(objectPath)
      if (existing && !(record.storage === "pack" && existing.storage === "pack"
        && record.packId === existing.packId)) {
        throw new Error("Re-encryption inventory has an unsafe shared remote object path.")
      }
      occupiedObjects.set(objectPath, { storage: record.storage, ...(record.packId ? { packId: record.packId } : {}) })
    }
  }

  for (const count of [fileCount, chunkedFileCount, packFileCount, headBuckets.length, occupiedObjects.size]) {
    assertSafeCount(count)
  }
  return Object.freeze({
    integrityScope: "metadata-only",
    objectContentVerified: false,
    pinnedSourceCommitSha,
    fileCount,
    totalLogicalBytes: totalLogicalBytes.toString(),
    shardCount: headBuckets.length,
    distinctRemoteObjectCount: occupiedObjects.size,
    chunkedFileCount,
    packFileCount,
  })
}
