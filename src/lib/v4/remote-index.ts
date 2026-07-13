import { bytesToUtf8, utf8ToBytes } from "../encrypted/bytes"
import { decryptV4Payload, encryptV4Payload, type V4Keyring } from "./crypto"
import type { V4IndexFileRecord } from "./local-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "./protocol-types"
import type { V4PreparedFile } from "./storage-codec"

export interface V4RemoteShard {
  bucket: string
  records: Record<string, V4IndexFileRecord>
}

export function v4RemoteShardPath(bucket: string, mode: V4RemoteConfig["mode"]): string {
  if (!/^[0-9a-f]{2}$/u.test(bucket)) throw new Error("Invalid V4 shard bucket.")
  return `${V4_ROOT}/index/${bucket}.${mode === "encrypted" ? "enc" : "json"}`
}

export function encodeV4RemoteConfig(config: V4RemoteConfig): Uint8Array {
  return utf8ToBytes(JSON.stringify(config))
}

export function decodeV4RemoteConfig(bytes: Uint8Array): V4RemoteConfig {
  const config = JSON.parse(bytesToUtf8(bytes)) as V4RemoteConfig
  if (config.formatVersion !== 4 || (config.mode !== "plaintext" && config.mode !== "encrypted")) {
    throw new Error("Unsupported remote format. Force Push is required to initialize V4.")
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
  const head = await decodeMetadata<V4RemoteHead>(bytes, config, keyring, "head", config.repoId)
  if (head.formatVersion !== 4 || head.mode !== config.mode) throw new Error("Invalid V4 remote head.")
  return head
}

export async function decodeV4RemoteShard(
  bytes: Uint8Array,
  bucket: string,
  config: V4RemoteConfig,
  keyring?: V4Keyring,
): Promise<V4RemoteShard> {
  const shard = await decodeMetadata<V4RemoteShard>(bytes, config, keyring, "index", `${config.repoId}:${bucket}`)
  if (shard.bucket !== bucket) throw new Error(`V4 shard bucket mismatch: ${bucket}`)
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
