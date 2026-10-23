import { sha256Hex, utf8ToBytes } from "../bytes";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4ObjectStorage, type V4PathLayout, type V4StorageMode } from "./protocol-types";
import { bucketForV4PathId } from "./paths";

export interface V4IndexFileRecord {
  path: string;
  pathId: string;
  fileId: string;
  plaintextSha256: string;
  size: number;
  mtime: number;
  remoteVersion: string;
  remotePath: string;
  encryptedPath?: string | undefined;
  storage: V4ObjectStorage;
  partPaths?: string[] | undefined;
  packId?: string | undefined;
  dirty?: boolean;
  deleted?: boolean;
}

export interface V4LocalIndexShard {
  bucket: string;
  hash: string;
  /** SHA-256 over the serialized local records; not part of the remote protocol. */
  contentDigest?: string;
  records: Record<string, V4IndexFileRecord>;
}

export interface V4LocalIndex {
  formatVersion: typeof V4_FORMAT_VERSION;
  repoId: string;
  deviceId: string;
  mode: V4StorageMode;
  pathLayout: V4PathLayout;
  remoteCommitSha?: string;
  epoch: number;
  generation: number;
  shardHashes: Record<string, string>;
  shards: Record<string, V4LocalIndexShard>;
}

export interface V4LocalIndexAdapter {
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat?(path: string): Promise<{ size: number } | null>;
}

type V4LocalIndexHeader = Omit<V4LocalIndex, "shards">;

export const V4_LOCAL_INDEX_HEADER_MAX_BYTES = 64 * 1024;
export const V4_LOCAL_INDEX_SHARD_MAX_BYTES = 32 * 1024 * 1024;

export function fitsV4LocalJsonSizeLimit(serialized: string, maxBytes: number): boolean {
  if (serialized.length > maxBytes) return false;
  let bytes = 0;
  for (let i = 0; i < serialized.length; i++) {
    const code = serialized.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < serialized.length
      && serialized.charCodeAt(i + 1) >= 0xdc00 && serialized.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > maxBytes) return false;
  }
  return true;
}

async function isV4OversizedLocalJson(adapter: V4LocalIndexAdapter, path: string, maximumBytes: number): Promise<boolean> {
  const stat = await adapter.stat?.(path);
  return !!stat && (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes);
}

function join(root: string, child: string): string {
  return `${root.replace(/\/+$/u, "")}/${child.replace(/^\/+/, "")}`;
}

function header(index: V4LocalIndex): V4LocalIndexHeader {
  const { shards: _shards, ...value } = index;
  return value;
}

function invalidV4LocalIndex(): V4LocalIndex {
  return createEmptyV4LocalIndex({ repoId: "", deviceId: "", mode: "plaintext" });
}

function isV4LocalIndexHeader(value: unknown): value is V4LocalIndexHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<V4LocalIndexHeader>;
  if (candidate.formatVersion !== V4_FORMAT_VERSION) return false;
  if (typeof candidate.repoId !== "string" || typeof candidate.deviceId !== "string") return false;
  if (candidate.mode !== "plaintext" && candidate.mode !== "encrypted") return false;
  if (candidate.pathLayout !== expectedV4PathLayout(candidate.mode)) return false;
  if (candidate.remoteCommitSha !== undefined && typeof candidate.remoteCommitSha !== "string") return false;
  if (!Number.isSafeInteger(candidate.epoch) || (candidate.epoch ?? -1) < 0) return false;
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation ?? -1) < 0) return false;
  if (!candidate.shardHashes || typeof candidate.shardHashes !== "object" || Array.isArray(candidate.shardHashes)) return false;
  return Object.entries(candidate.shardHashes).every(([bucket, hash]) => /^[0-9a-f]{2}$/u.test(bucket) && typeof hash === "string");
}

function isRecordMap(value: unknown, bucket: string): value is Record<string, V4IndexFileRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [recordKey, record] of Object.entries(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const pathId = (record as Partial<V4IndexFileRecord>).pathId;
    if (recordKey !== pathId) return false;
    try {
      if (bucketForV4PathId(pathId) !== bucket) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isShardConsistent(shard: unknown, bucket: string, expectedHash: string): shard is V4LocalIndexShard {
  if (!shard || typeof shard !== "object" || Array.isArray(shard)) return false;
  const candidate = shard as Partial<V4LocalIndexShard>;
  return candidate.bucket === bucket
    && candidate.hash === expectedHash
    && isRecordMap(candidate.records, bucket);
}

export function isV4LocalIndexShardConsistent(index: V4LocalIndex, bucket: string, expectedHash: string): boolean {
  return index.shardHashes[bucket] === expectedHash
    && isShardConsistent(index.shards[bucket], bucket, expectedHash);
}

export function isV4LocalIndexCacheComplete(index: V4LocalIndex): boolean {
  if (!index.shardHashes || typeof index.shardHashes !== "object" || Array.isArray(index.shardHashes)) return false;
  if (!index.shards || typeof index.shards !== "object" || Array.isArray(index.shards)) return false;
  const expectedBuckets = Object.keys(index.shardHashes);
  if (Object.keys(index.shards).length !== expectedBuckets.length) return false;
  return expectedBuckets.every(bucket => /^[0-9a-f]{2}$/u.test(bucket)
    && typeof index.shardHashes[bucket] === "string"
    && isV4LocalIndexShardConsistent(index, bucket, index.shardHashes[bucket]));
}

export function createEmptyV4LocalIndex(input: { repoId: string; deviceId: string; mode: V4StorageMode; pathLayout?: V4PathLayout }): V4LocalIndex {
  return {
    formatVersion: V4_FORMAT_VERSION,
    repoId: input.repoId,
    deviceId: input.deviceId,
    mode: input.mode,
    pathLayout: input.pathLayout ?? expectedV4PathLayout(input.mode),
    epoch: 0,
    generation: 0,
    shardHashes: {},
    shards: {},
  };
}

async function localShardContentDigest(bucket: string, records: Record<string, V4IndexFileRecord>): Promise<string> {
  return sha256Hex(utf8ToBytes(`v4-local-shard:${bucket}:${JSON.stringify(records)}`));
}

async function saveV4LocalIndexShard(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex, bucket: string): Promise<void> {
  const shard = index.shards[bucket];
  if (!shard || !isShardConsistent(shard, bucket, shard.hash)) throw new Error(`Invalid V4 local index shard: ${bucket}`);
  // A local cache label copied from the remote head does not authenticate its records.
  // Seal the actual serialized records without changing remote shard hashes.
  shard.contentDigest = await localShardContentDigest(bucket, shard.records);
  index.shardHashes[bucket] = shard.hash;
  await adapter.mkdir(root);
  await adapter.mkdir(join(root, "shards"));
  const serialized = JSON.stringify(shard);
  if (!fitsV4LocalJsonSizeLimit(serialized, V4_LOCAL_INDEX_SHARD_MAX_BYTES)) throw new Error("V4 local index shard exceeds the cache limit.");
  await adapter.write(join(root, `shards/${bucket}.json`), serialized);
}

async function saveV4LocalIndexHeader(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex): Promise<void> {
  await adapter.mkdir(root);
  const serialized = JSON.stringify(header(index));
  if (!fitsV4LocalJsonSizeLimit(serialized, V4_LOCAL_INDEX_HEADER_MAX_BYTES)) throw new Error("V4 local index header exceeds the cache limit.");
  await adapter.write(join(root, "index.json"), serialized);
}

export async function saveV4LocalIndex(
  adapter: V4LocalIndexAdapter,
  root: string,
  index: V4LocalIndex,
  previousShardHashes: Record<string, string> = {},
): Promise<void> {
  for (const bucket of Object.keys(index.shards)) {
    if (previousShardHashes[bucket] !== index.shardHashes[bucket]) await saveV4LocalIndexShard(adapter, root, index, bucket);
  }
  await saveV4LocalIndexHeader(adapter, root, index);
}

export async function loadV4LocalIndex(adapter: V4LocalIndexAdapter, root: string): Promise<V4LocalIndex> {
  const headerPath = join(root, "index.json");
  if (!(await adapter.exists(headerPath))) return invalidV4LocalIndex();
  if (await isV4OversizedLocalJson(adapter, headerPath, V4_LOCAL_INDEX_HEADER_MAX_BYTES)) return invalidV4LocalIndex();
  const serializedHeader = await adapter.read(headerPath);
  if (!fitsV4LocalJsonSizeLimit(serializedHeader, V4_LOCAL_INDEX_HEADER_MAX_BYTES)) return invalidV4LocalIndex();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedHeader);
  } catch (error) {
    if (error instanceof SyntaxError) return invalidV4LocalIndex();
    throw error;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const formatVersion = (parsed as { formatVersion?: unknown }).formatVersion;
    if (formatVersion !== undefined && formatVersion !== V4_FORMAT_VERSION) throw new Error("Unsupported V4 local index version.");
  }
  if (!isV4LocalIndexHeader(parsed)) return invalidV4LocalIndex();
  const index: V4LocalIndex = { ...parsed, shards: {} };
  for (const bucket of Object.keys(index.shardHashes)) {
    const path = join(root, `shards/${bucket}.json`);
    if (!(await adapter.exists(path))) return invalidV4LocalIndex();
    if (await isV4OversizedLocalJson(adapter, path, V4_LOCAL_INDEX_SHARD_MAX_BYTES)) return invalidV4LocalIndex();
    const serialized = await adapter.read(path);
    if (!fitsV4LocalJsonSizeLimit(serialized, V4_LOCAL_INDEX_SHARD_MAX_BYTES)) return invalidV4LocalIndex();
    let loaded: V4LocalIndexShard;
    try {
      loaded = JSON.parse(serialized) as V4LocalIndexShard;
    } catch (error) {
      if (error instanceof SyntaxError) return invalidV4LocalIndex();
      throw error;
    }
    // Never authorize a cached remote HEAD from mutated or pre-D5 unsealed records.
    // The remote protocol and its historical shard-hash algorithm are untouched.
    const expectedHash = index.shardHashes[bucket];
    if (expectedHash === undefined || !isShardConsistent(loaded, bucket, expectedHash)) return invalidV4LocalIndex();
    if (!/^[0-9a-f]{64}$/u.test(loaded.contentDigest ?? "")) return invalidV4LocalIndex();
    if (loaded.contentDigest !== await localShardContentDigest(bucket, loaded.records)) return invalidV4LocalIndex();
    index.shards[bucket] = loaded;
  }
  return isV4LocalIndexCacheComplete(index) ? index : invalidV4LocalIndex();
}
