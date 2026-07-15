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
  encryptedPath?: string;
  storage: V4ObjectStorage;
  partPaths?: string[];
  packId?: string;
  dirty?: boolean;
  deleted?: boolean;
}

export interface V4LocalIndexShard {
  bucket: string;
  hash: string;
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
}

type V4LocalIndexHeader = Omit<V4LocalIndex, "shards">;

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

async function saveV4LocalIndexShard(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex, bucket: string): Promise<void> {
  const shard = index.shards[bucket];
  if (!shard || !isShardConsistent(shard, bucket, shard.hash)) throw new Error(`Invalid V4 local index shard: ${bucket}`);
  index.shardHashes[bucket] = shard.hash;
  await adapter.mkdir(root);
  await adapter.mkdir(join(root, "shards"));
  await adapter.write(join(root, `shards/${bucket}.json`), JSON.stringify(shard));
}

async function saveV4LocalIndexHeader(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex): Promise<void> {
  await adapter.mkdir(root);
  await adapter.write(join(root, "index.json"), JSON.stringify(header(index)));
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
  const parsed = JSON.parse(await adapter.read(headerPath)) as V4LocalIndexHeader;
  if (parsed.formatVersion !== V4_FORMAT_VERSION) throw new Error("Unsupported V4 local index version.");
  if (!parsed.shardHashes || typeof parsed.shardHashes !== "object" || Array.isArray(parsed.shardHashes)) return invalidV4LocalIndex();
  const index: V4LocalIndex = { ...parsed, shards: {} };
  for (const bucket of Object.keys(index.shardHashes)) {
    const path = join(root, `shards/${bucket}.json`);
    if (!(await adapter.exists(path))) return invalidV4LocalIndex();
    const serialized = await adapter.read(path);
    try {
      index.shards[bucket] = JSON.parse(serialized) as V4LocalIndexShard;
    } catch (error) {
      if (error instanceof SyntaxError) return invalidV4LocalIndex();
      throw error;
    }
  }
  return isV4LocalIndexCacheComplete(index) ? index : invalidV4LocalIndex();
}
