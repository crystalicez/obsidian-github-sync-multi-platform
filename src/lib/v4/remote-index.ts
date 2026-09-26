import { bytesToUtf8, fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload, type V4Keyring } from "./crypto"
import { buildV4PartPaths, shouldUseV4Parts, V4_PART_BYTES } from "./large-files"
import type { V4IndexFileRecord } from "./local-index"
import { bucketForV4PathId, normalizeV4VaultPath, objectIdForV4File, opaqueV4ObjectPath, opaqueV4PackPath, pathIdForV4Path } from "./paths"
import { PACK_MAX_ENTRY_BYTES } from "./pack-planner"
import { V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION } from "./part-write-policy"
import { effectiveV4PathLayout, V4_CONFIG_PATH, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "./protocol-types"
import type { V4PreparedFile } from "./storage-codec"

export interface V4RemoteShard {
  bucket: string
  records: Record<string, V4IndexFileRecord>
}

export const V4_MAX_KDF_ITERATIONS = 5_000_000
export const V4_MAX_KDF_SALT_BYTES = 64
const V4_PROTOCOL_TOKEN = /^[A-Za-z0-9_-]{1,128}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assertCanonicalKdfSalt(salt: unknown): asserts salt is string {
  if (typeof salt !== "string" || salt.length < 2 || salt.length > 86 || !/^[A-Za-z0-9_-]+$/u.test(salt)) {
    throw new Error("Invalid V4 encryption salt.")
  }
  let decoded: Uint8Array
  try { decoded = fromBase64Url(salt) } catch { throw new Error("Invalid V4 encryption salt.") }
  if (decoded.byteLength < 1 || decoded.byteLength > V4_MAX_KDF_SALT_BYTES || toBase64Url(decoded) !== salt) {
    throw new Error("Invalid V4 encryption salt.")
  }
}

export function assertV4RemoteRecordDescriptor(record: V4IndexFileRecord, config: V4RemoteConfig): void {
  let normalized: string
  try {
    normalized = normalizeV4VaultPath(record.path)
  } catch (error) {
    throw new Error(`Unsafe V4 remote record path: ${record.path}`, { cause: error })
  }
  if (normalized !== record.path) throw new Error(`V4 remote record path is not normalized: ${record.path}`)
  if (!record.fileId) throw new Error("V4 remote record has an empty fileId.")
  if (!/^[0-9a-f]{64}$/u.test(record.plaintextSha256)) throw new Error("V4 remote record plaintext hash is invalid.")
  if (!V4_PROTOCOL_TOKEN.test(record.remoteVersion)) throw new Error("V4 remote record version is invalid.")
  if (!Number.isSafeInteger(record.size) || record.size < 0) throw new Error("V4 remote record size is invalid.")
  if (!Number.isFinite(record.mtime)) throw new Error("V4 remote record mtime is invalid.")
  if (typeof record.remotePath !== "string" || !record.remotePath) throw new Error("V4 remote record path descriptor is invalid.")
  if (typeof record.remoteVersion !== "string") throw new Error("V4 remote record version is invalid.")
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
    if (shouldUseV4Parts(record.size, record.size + (config.mode === "encrypted" ? 33 : 0))) {
      throw new Error("V4 single storage exceeds the writer size limit.")
    }
    if (config.mode === "plaintext" && record.remotePath !== record.path) throw new Error("V4 plaintext single storage path does not match its logical path.")
    return
  }
  if (record.storage === "chunked") {
    if (!Array.isArray(record.partPaths) || record.partPaths.length === 0 || record.remotePath !== record.partPaths[0] || record.packId !== undefined) {
      throw new Error("V4 chunked storage has inconsistent part descriptors.")
    }
    if (record.partPaths.length > V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION) {
      throw new Error("V4 chunked storage exceeds the part-count budget.")
    }
    if (record.size > V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION * V4_PART_BYTES) {
      throw new Error("V4 chunked storage exceeds the writer size budget.")
    }
    if (record.partPaths.some(path => typeof path !== "string" || !path)) throw new Error("V4 chunked storage has invalid part paths.")
    if (config.mode === "plaintext") {
      const expected = buildV4PartPaths({
        mode: "plaintext",
        logicalPath: record.path,
        version: record.remoteVersion,
        partCount: record.partPaths.length,
      })
      if (JSON.stringify(record.partPaths) !== JSON.stringify(expected)) throw new Error("V4 plaintext chunked storage paths are inconsistent.")
    }
    return
  }
  if (record.storage === "pack") {
    if (
      config.mode !== "encrypted"
      || !record.packId
      || !V4_PROTOCOL_TOKEN.test(record.packId)
      || record.partPaths !== undefined
      || record.size > PACK_MAX_ENTRY_BYTES
    ) {
      throw new Error("V4 pack storage has inconsistent or oversized descriptors.")
    }
    return
  }
  throw new Error("V4 remote record has an unsupported storage descriptor.")
}

export function assertV4RemoteShardRecords(shard: V4RemoteShard, bucket: string, config: V4RemoteConfig): void {
  for (const [recordKey, record] of Object.entries(shard.records)) {
    if (recordKey !== record.pathId) throw new Error(`V4 shard record key does not match pathId: ${recordKey}`)
    if (bucketForV4PathId(record.pathId) !== bucket) throw new Error(`V4 record pathId is outside shard bucket: ${bucket}`)
    assertV4RemoteRecordDescriptor(record, config)
  }
}

export async function assertV4RemoteRecordSet(records: V4IndexFileRecord[], config: V4RemoteConfig, keyring?: V4Keyring): Promise<void> {
  const fileIds = new Set<string>()
  const logicalPaths = new Set<string>()
  for (const record of records) {
    assertV4RemoteRecordDescriptor(record, config)
    if (fileIds.has(record.fileId)) throw new Error(`Duplicate V4 remote fileId: ${record.fileId}`)
    fileIds.add(record.fileId)
    if (logicalPaths.has(record.path)) throw new Error(`Duplicate V4 remote logical path: ${record.path}`)
    logicalPaths.add(record.path)
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
  return utf8ToBytes(JSON.stringify(config))
}

export function decodeV4RemoteConfig(bytes: Uint8Array): V4RemoteConfig {
  const parsed = JSON.parse(bytesToUtf8(bytes)) as unknown
  if (!isRecord(parsed)) throw new Error("Invalid V4 remote config.")
  const config = parsed as unknown as V4RemoteConfig
  if (config.formatVersion !== 4 || (config.mode !== "plaintext" && config.mode !== "encrypted")) {
    throw new Error("Unsupported remote format. Force Push is required to initialize V4.")
  }
  if (typeof config.repoId !== "string" || !config.repoId) throw new Error("Invalid V4 remote repository identity.")
  if (config.pathLayout !== undefined && config.pathLayout !== "plaintext-v1" && config.pathLayout !== "opaque-stable-v1") {
    throw new Error("Unsupported V4 path layout.")
  }
  if (config.mode === "encrypted") {
    if (config.algorithm !== "AES-GCM") throw new Error("Unsupported V4 encryption algorithm.")
    if (config.kdf !== "PBKDF2-SHA-256") throw new Error("Unsupported V4 KDF.")
    if (!isRecord(config.kdfParams)) throw new Error("Invalid V4 encrypted KDF parameters.")
    if (!Number.isSafeInteger(config.kdfParams.iterations) || config.kdfParams.iterations < 1 || config.kdfParams.iterations > V4_MAX_KDF_ITERATIONS) {
      throw new Error("Invalid V4 encrypted KDF iteration count.")
    }
    assertCanonicalKdfSalt(config.kdfParams.salt)
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
  let plaintext: Uint8Array
  try {
    plaintext = config.mode === "plaintext"
      ? bytes
      : await decryptV4Payload(keyring?.indexKey ?? new Uint8Array(), bytes, { kind, aad })
  } catch (error) {
    throw new Error(`Unable to decrypt V4 ${kind} metadata (${aad}). Check the encryption passphrase.`, { cause: error })
  }
  return JSON.parse(bytesToUtf8(plaintext)) as T
}

export async function decodeV4RemoteHead(
  bytes: Uint8Array,
  config: V4RemoteConfig,
  keyring?: V4Keyring,
): Promise<V4RemoteHead> {
  const parsed = await decodeMetadata<unknown>(bytes, config, keyring, "head", config.repoId)
  if (!isRecord(parsed)) throw new Error("Invalid V4 remote head.")
  const head = parsed as unknown as V4RemoteHead
  if (
    head.formatVersion !== 4
    || head.mode !== config.mode
    || !Number.isSafeInteger(head.epoch) || head.epoch < 0
    || !Number.isSafeInteger(head.generation) || head.generation < 0
    || typeof head.journalId !== "string" || !V4_PROTOCOL_TOKEN.test(head.journalId)
    || !Number.isFinite(head.updatedAt)
    || typeof head.deviceId !== "string"
    || !isRecord(head.shardHashes)
  ) throw new Error("Invalid V4 remote head.")
  const shardHashes = Object.entries(head.shardHashes)
  if (
    shardHashes.length > 256
    || shardHashes.some(([bucket, hash]) => !/^[0-9a-f]{2}$/u.test(bucket) || typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))
  ) throw new Error("Invalid V4 remote head shard hashes.")
  return head
}

export async function decodeV4RemoteShard(
  bytes: Uint8Array,
  bucket: string,
  config: V4RemoteConfig,
  keyring?: V4Keyring,
): Promise<V4RemoteShard> {
  const parsed = await decodeMetadata<unknown>(bytes, config, keyring, "index", `${config.repoId}:${bucket}`)
  if (!isRecord(parsed) || parsed.bucket !== bucket || !isRecord(parsed.records)) {
    throw new Error(`V4 shard bucket or record shape mismatch: ${bucket}`)
  }
  const shard = parsed as unknown as V4RemoteShard
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
