import { bytesToUtf8, sha256Hex, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload, type V4Keyring } from "./crypto"
import { buildV4PartPaths } from "./large-files"
import { assertV4MetadataBytes } from "./metadata-bounds"
import type { V4IndexFileRecord } from "./local-index"
import { bucketForV4PathId, normalizeV4VaultPath, objectIdForV4File, opaqueV4ObjectPath, opaqueV4PackPath, pathIdForV4Path } from "./paths"
import { effectiveV4PathLayout, V4_CONFIG_PATH, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "./protocol-types"
import type { V4PreparedFile } from "./storage-codec"

export interface V4RemoteShard {
  bucket: string
  records: Record<string, V4IndexFileRecord>
}

function assertNormalizedRemoteRecord(record: V4IndexFileRecord, config: V4RemoteConfig): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("V4 remote record descriptor is invalid.")
  if (typeof record.path !== "string") throw new Error("V4 remote record path is invalid.")
  if (typeof record.pathId !== "string" || !/^[0-9a-f]{64}$/u.test(record.pathId)) throw new Error("V4 remote record pathId is invalid.")
  if (typeof record.fileId !== "string" || !record.fileId) throw new Error("V4 remote record fileId is invalid.")
  if (typeof record.plaintextSha256 !== "string" || !record.plaintextSha256) throw new Error("V4 remote record plaintext hash is invalid.")
  if (typeof record.remoteVersion !== "string" || !record.remoteVersion) {
    throw new Error("V4 remote record version is invalid.")
  }
  if (!Number.isSafeInteger(record.size) || record.size < 0) throw new Error("V4 remote record size is invalid.")
  if (typeof record.mtime !== "number" || !Number.isFinite(record.mtime)) throw new Error("V4 remote record mtime is invalid.")
  if (typeof record.remotePath !== "string" || !record.remotePath) throw new Error("V4 remote record remote path is invalid.")
  let normalized: string
  try {
    normalized = normalizeV4VaultPath(record.path)
  } catch (error) {
    throw new Error(`Unsafe V4 remote record path: ${record.path}`, { cause: error })
  }
  if (normalized !== record.path) throw new Error(`V4 remote record path is not normalized: ${record.path}`)
  if (!record.fileId) throw new Error("V4 remote record has an empty fileId.")
  if (record.encryptedPath !== undefined && record.encryptedPath !== record.remotePath) {
    const legacyPackedArtifact = effectiveV4PathLayout(config) === "encrypted-folders-v0"
      && record.storage === "pack"
      && normalizeV4VaultPath(record.encryptedPath) === record.encryptedPath
      && normalizeV4VaultPath(record.remotePath) === record.remotePath
      && record.encryptedPath.startsWith(`${V4_ROOT}/data/`)
      && record.remotePath.startsWith(`${V4_ROOT}/packs/`)
      && record.encryptedPath.endsWith(".enc")
      && record.remotePath.endsWith(".enc")
    if (!legacyPackedArtifact) throw new Error("V4 encryptedPath does not match remotePath.")
  }
  if (record.storage === "single") {
    if (record.partPaths !== undefined || record.packId !== undefined) throw new Error("V4 single storage has inconsistent part or pack descriptors.")
    if (config.mode === "plaintext" && record.remotePath !== record.path) throw new Error("V4 plaintext single storage path does not match its logical path.")
    return
  }
  if (record.storage === "chunked") {
    if (!Array.isArray(record.partPaths) || record.partPaths.length === 0
      || record.remotePath !== record.partPaths[0] || record.packId !== undefined) {
      throw new Error("V4 chunked storage has inconsistent part descriptors.")
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(record.remoteVersion)) throw new Error("V4 chunked storage has an unsafe remote version.")
    const uniqueParts = new Set<string>()
    for (const part of record.partPaths) {
      if (typeof part !== "string" || !part
        || !(part.startsWith(`${V4_ROOT}/large/`) || part.startsWith(`${V4_ROOT}/parts/`))) {
        throw new Error("V4 chunked storage has an invalid part namespace.")
      }
      let normalized: string
      try {
        normalized = normalizeV4VaultPath(part)
      } catch {
        throw new Error("V4 chunked storage has an unsafe part path.")
      }
      if (normalized !== part || uniqueParts.has(part)) {
        throw new Error("V4 chunked storage has a non-normalized or duplicate part path.")
      }
      uniqueParts.add(part)
    }
    return
  }
  if (record.storage === "pack") {
    if (config.mode !== "encrypted" || !record.packId || !/^[A-Za-z0-9_-]+$/u.test(record.packId) || record.partPaths !== undefined) {
      throw new Error("V4 pack storage has inconsistent descriptors.")
    }
    let normalizedPackPath: string
    try {
      normalizedPackPath = normalizeV4VaultPath(record.remotePath)
    } catch {
      throw new Error("V4 pack storage has an unsafe remote path.")
    }
    if (normalizedPackPath !== record.remotePath || !record.remotePath.startsWith(`${V4_ROOT}/packs/`)
      || !record.remotePath.endsWith(".enc")) {
      throw new Error("V4 pack storage has an invalid remote path namespace.")
    }
    return
  }
  throw new Error("V4 remote record has an unsupported storage descriptor.")
}

export function assertV4RemoteShardRecords(shard: V4RemoteShard, bucket: string, config: V4RemoteConfig): void {
  if (!shard || typeof shard !== "object" || Array.isArray(shard)
    || !shard.records || typeof shard.records !== "object" || Array.isArray(shard.records)) {
    throw new Error("V4 remote shard records descriptor is invalid.")
  }
  for (const [recordKey, record] of Object.entries(shard.records)) {
    if (recordKey !== record.pathId) throw new Error(`V4 shard record key does not match pathId: ${recordKey}`)
    if (bucketForV4PathId(record.pathId) !== bucket) throw new Error(`V4 record pathId is outside shard bucket: ${bucket}`)
    assertNormalizedRemoteRecord(record, config)
  }
}

/**
 * Reject remote file-to-directory and canonical spelling aliases before a local
 * mutation can overwrite one of their logical paths on another filesystem.
 * Fail closed: no persistent format migration or implicit rename is performed.
 */
export function assertV4LogicalPathSetSafe(paths: Iterable<string>): void {
  const logicalPaths = new Set<string>()
  const canonicalLogicalPaths = new Map<string, string>()
  for (const path of paths) {
    if (logicalPaths.has(path)) throw new Error(`Duplicate V4 remote logical path: ${path}`)
    logicalPaths.add(path)
    const canonicalPath = path.normalize("NFC").toLowerCase()
    const canonicalPrevious = canonicalLogicalPaths.get(canonicalPath)
    if (canonicalPrevious && canonicalPrevious !== path) {
      throw new Error(`V4 remote logical path canonical collision: ${canonicalPrevious} <-> ${path}`)
    }
    canonicalLogicalPaths.set(canonicalPath, path)
  }
  for (const [canonicalPath, originalPath] of canonicalLogicalPaths) {
    let slash = canonicalPath.indexOf("/")
    while (slash > 0) {
      const originalAncestor = canonicalLogicalPaths.get(canonicalPath.slice(0, slash))
      if (originalAncestor) {
        throw new Error(`V4 remote logical path topology collision: ${originalAncestor} is a file ancestor of ${originalPath}`)
      }
      slash = canonicalPath.indexOf("/", slash + 1)
    }
  }
}

export async function assertV4RemoteRecordSet(records: V4IndexFileRecord[], config: V4RemoteConfig, keyring?: V4Keyring): Promise<void> {
  const fileIds = new Set<string>()
  for (const record of records) assertNormalizedRemoteRecord(record, config)
  assertV4LogicalPathSetSafe(records.map(record => record.path))
  for (const record of records) {
    if (fileIds.has(record.fileId)) throw new Error(`Duplicate V4 remote fileId: ${record.fileId}`)
    fileIds.add(record.fileId)
    if (config.mode === "encrypted" && !keyring) throw new Error("Encryption passphrase is required to validate encrypted V4 records.")
    const expectedPathId = config.mode === "encrypted"
      ? await pathIdForV4Path(keyring!.pathKey, record.path)
      : await sha256Hex(utf8ToBytes(`path:${record.path}`))
    if (record.pathId !== expectedPathId) throw new Error(`V4 remote pathId does not match logical path: ${record.path}`)
    if (config.mode !== "encrypted" || effectiveV4PathLayout(config) !== "opaque-stable-v1") continue
    const opaqueKeyring = keyring!
    if (record.storage === "single") {
      if (record.remotePath !== await opaqueV4ObjectPath(opaqueKeyring.pathKey, record.fileId)) throw new Error("V4 encrypted single storage path is inconsistent with fileId.")
      continue
    }
    if (record.storage === "chunked") {
      const opaqueId = await objectIdForV4File(opaqueKeyring.pathKey, record.fileId)
      const expected = buildV4PartPaths({ mode: "encrypted", logicalPath: record.path, version: record.remoteVersion, partCount: record.partPaths!.length, opaqueId })
      if (JSON.stringify(record.partPaths) !== JSON.stringify(expected)) throw new Error("V4 encrypted chunked storage paths are inconsistent with fileId.")
      continue
    }
    if (record.remotePath !== await opaqueV4PackPath(opaqueKeyring.pathKey, record.packId!)) throw new Error("V4 encrypted pack storage path is inconsistent with packId.")
  }
}

export function v4RemoteShardPath(bucket: string, mode: V4RemoteConfig["mode"]): string {
  if (!/^[0-9a-f]{2}$/u.test(bucket)) throw new Error("Invalid V4 shard bucket.")
  return `${V4_ROOT}/index/${bucket}.${mode === "encrypted" ? "enc" : "json"}`
}

export function encodeV4RemoteConfig(config: V4RemoteConfig): Uint8Array {
  const bytes = utf8ToBytes(JSON.stringify(config))
  assertV4MetadataBytes(bytes, "config")
  return bytes
}

export function decodeV4RemoteConfig(bytes: Uint8Array): V4RemoteConfig {
  assertV4MetadataBytes(bytes, "config")
  const config = JSON.parse(bytesToUtf8(bytes)) as V4RemoteConfig
  if (config.formatVersion !== 4 || (config.mode !== "plaintext" && config.mode !== "encrypted")) {
    throw new Error("Unsupported remote format. Force Push is required to initialize V4.")
  }
  if (config.pathLayout !== undefined && config.pathLayout !== "plaintext-v1" && config.pathLayout !== "opaque-stable-v1") {
    throw new Error("Unsupported V4 path layout.")
  }
  return config
}

async function encodeMetadata(
  value: unknown,
  config: V4RemoteConfig,
  keyring: V4Keyring | undefined,
  kind: "head" | "index",
  aad: string,
): Promise<Uint8Array> {
  const bytes = utf8ToBytes(JSON.stringify(value))
  assertV4MetadataBytes(bytes, kind === "index" ? "shard" : "head")
  if (config.mode === "plaintext") return bytes
  if (!keyring) throw new Error("Encryption passphrase is required to read encrypted V4 metadata.")
  return encryptV4Payload(keyring.indexKey, bytes, { kind, aad })
}

async function decodeMetadata<T>(
  bytes: Uint8Array,
  config: V4RemoteConfig,
  keyring: V4Keyring | undefined,
  kind: "head" | "index",
  aad: string,
): Promise<T> {
  const metadataKind = kind === "index" ? "shard" : "head"
  assertV4MetadataBytes(bytes, metadataKind, config.mode === "encrypted")
  let plaintext: Uint8Array
  try {
    plaintext = config.mode === "plaintext"
      ? bytes
      : await decryptV4Payload(keyring?.indexKey ?? new Uint8Array(), bytes, { kind, aad })
  } catch (error) {
    throw new Error(`Unable to decrypt V4 ${kind} metadata (${aad}). Check the encryption passphrase.`, { cause: error })
  }
  assertV4MetadataBytes(plaintext, metadataKind)
  return JSON.parse(bytesToUtf8(plaintext)) as T
}

export async function decodeV4RemoteHead(
  bytes: Uint8Array,
  config: V4RemoteConfig,
  keyring?: V4Keyring,
): Promise<V4RemoteHead> {
  const decoded = await decodeMetadata<unknown>(bytes, config, keyring, "head", config.repoId)
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid V4 remote head.")
  const head = decoded as Partial<V4RemoteHead>
  if (head.formatVersion !== 4 || head.mode !== config.mode
    || !Number.isSafeInteger(head.epoch) || head.epoch! < 0
    || !Number.isSafeInteger(head.generation) || head.generation! < 0 || head.generation! >= Number.MAX_SAFE_INTEGER
    || typeof head.journalId !== "string"
    || typeof head.updatedAt !== "number" || !Number.isFinite(head.updatedAt)
    || typeof head.deviceId !== "string"
    || !head.shardHashes || typeof head.shardHashes !== "object" || Array.isArray(head.shardHashes)
    || !Object.entries(head.shardHashes).every(([bucket, hash]) => /^[0-9a-f]{2}$/u.test(bucket) && typeof hash === "string")
  ) throw new Error("Invalid V4 remote head.")
  return head as V4RemoteHead
}

export async function decodeV4RemoteShard(
  bytes: Uint8Array,
  bucket: string,
  config: V4RemoteConfig,
  keyring?: V4Keyring,
): Promise<V4RemoteShard> {
  const shard = await decodeMetadata<V4RemoteShard>(bytes, config, keyring, "index", `${config.repoId}:${bucket}`)
  if (shard.bucket !== bucket) throw new Error(`V4 shard bucket mismatch: ${bucket}`)
  assertV4RemoteShardRecords(shard, bucket, config)
  return shard
}

export async function buildV4RemoteMetadata(input: {
  config: V4RemoteConfig
  head: V4RemoteHead
  records: V4IndexFileRecord[]
  keyring?: V4Keyring
  buckets?: Iterable<string>
}): Promise<V4PreparedFile[]> {
  const grouped = new Map<string, Record<string, V4IndexFileRecord>>()
  for (const record of input.records) {
    const bucket = record.pathId.slice(0, 2)
    const records = grouped.get(bucket) ?? {}
    records[record.pathId] = record
    grouped.set(bucket, records)
  }
  const files: V4PreparedFile[] = [{ path: V4_CONFIG_PATH, bytes: encodeV4RemoteConfig(input.config) }]
  const selectedBuckets = input.buckets ? new Set(input.buckets) : null
  for (const [bucket, records] of grouped) {
    if (selectedBuckets && !selectedBuckets.has(bucket)) continue
    files.push({
      path: v4RemoteShardPath(bucket, input.config.mode),
      bytes: await encodeMetadata({ bucket, records }, input.config, input.keyring, "index", `${input.config.repoId}:${bucket}`),
    })
  }
  files.push({
    path: V4_HEAD_PATH,
    bytes: await encodeMetadata(input.head, input.config, input.keyring, "head", input.config.repoId),
  })
  return files
}
