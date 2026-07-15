import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4ObjectStorage, type V4PathLayout, type V4StorageMode } from "./protocol-types";

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

export async function saveV4LocalIndexShard(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex, bucket: string): Promise<void> {
  const shard = index.shards[bucket] ?? { hash: "", records: {} };
  index.shardHashes[bucket] = shard.hash;
  await adapter.mkdir(root);
  await adapter.mkdir(join(root, "shards"));
  await adapter.write(join(root, "index.json"), JSON.stringify(header(index)));
  await adapter.write(join(root, `shards/${bucket}.json`), JSON.stringify(shard));
}

export async function saveV4LocalIndexHeader(adapter: V4LocalIndexAdapter, root: string, index: V4LocalIndex): Promise<void> {
  await adapter.mkdir(root);
  await adapter.write(join(root, "index.json"), JSON.stringify(header(index)));
}

export async function loadV4LocalIndex(adapter: V4LocalIndexAdapter, root: string): Promise<V4LocalIndex> {
  const headerPath = join(root, "index.json");
  if (!(await adapter.exists(headerPath))) return createEmptyV4LocalIndex({ repoId: "", deviceId: "", mode: "plaintext" });
  const parsed = JSON.parse(await adapter.read(headerPath)) as V4LocalIndexHeader;
  if (parsed.formatVersion !== V4_FORMAT_VERSION) throw new Error("Unsupported V4 local index version.");
  const index: V4LocalIndex = { ...parsed, shards: {} };
  for (const bucket of Object.keys(index.shardHashes)) {
    const path = join(root, `shards/${bucket}.json`);
    if (await adapter.exists(path)) index.shards[bucket] = JSON.parse(await adapter.read(path)) as V4LocalIndexShard;
  }
  return index;
}
