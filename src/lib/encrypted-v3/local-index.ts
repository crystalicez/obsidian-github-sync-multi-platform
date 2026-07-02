export interface V3IndexFileRecord {
  path: string;
  pathId: string;
  fileId: string;
  plaintextSha256: string;
  size: number;
  mtime: number;
  remoteVersion: string;
  encryptedPath?: string;
  objectPath?: string;
  chunkPaths?: string[];
  storage?: "loose" | "chunked" | "base-pack" | "delta-pack";
  dirty?: boolean;
  deleted?: boolean;
}

export interface V3LocalIndexShard {
  hash: string;
  records: Record<string, V3IndexFileRecord>;
}

export interface V3LocalIndex {
  formatVersion: 3;
  repoId: string;
  deviceId: string;
  remoteCommitSha?: string;
  epoch: number;
  generation: number;
  shardHashes: Record<string, string>;
  shards: Record<string, V3LocalIndexShard>;
}

export interface V3LocalIndexAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

interface V3LocalIndexHeader {
  formatVersion: 3;
  repoId: string;
  deviceId: string;
  remoteCommitSha?: string;
  epoch: number;
  generation: number;
  shardHashes: Record<string, string>;
}

function joinPath(root: string, child: string): string {
  return `${root.replace(/\/+$/u, "")}/${child.replace(/^\/+/u, "")}`;
}

function headerFromIndex(index: V3LocalIndex): V3LocalIndexHeader {
  return {
    formatVersion: 3,
    repoId: index.repoId,
    deviceId: index.deviceId,
    remoteCommitSha: index.remoteCommitSha,
    epoch: index.epoch,
    generation: index.generation,
    shardHashes: index.shardHashes,
  };
}

export function createEmptyV3LocalIndex(input: { repoId: string; deviceId: string }): V3LocalIndex {
  return {
    formatVersion: 3,
    repoId: input.repoId,
    deviceId: input.deviceId,
    epoch: 0,
    generation: 0,
    shardHashes: {},
    shards: {},
  };
}

export async function saveV3LocalIndexShard(adapter: V3LocalIndexAdapter, root: string, index: V3LocalIndex, bucket: string): Promise<void> {
  const shard = index.shards[bucket] ?? { hash: "", records: {} };
  index.shardHashes[bucket] = shard.hash;
  await adapter.mkdir(root);
  await adapter.mkdir(joinPath(root, "shards"));
  await adapter.write(joinPath(root, "index.json"), JSON.stringify(headerFromIndex(index)));
  await adapter.write(joinPath(root, `shards/${bucket}.json`), JSON.stringify(shard));
}

export async function saveV3LocalIndexHeader(adapter: V3LocalIndexAdapter, root: string, index: V3LocalIndex): Promise<void> {
  await adapter.mkdir(root);
  await adapter.write(joinPath(root, "index.json"), JSON.stringify(headerFromIndex(index)));
}

export async function loadV3LocalIndex(adapter: V3LocalIndexAdapter, root: string): Promise<V3LocalIndex> {
  const headerPath = joinPath(root, "index.json");
  if (!(await adapter.exists(headerPath))) return createEmptyV3LocalIndex({ repoId: "", deviceId: "" });
  const header = JSON.parse(await adapter.read(headerPath)) as V3LocalIndexHeader;
  const index: V3LocalIndex = { ...header, shards: {} };
  for (const bucket of Object.keys(header.shardHashes)) {
    const shardPath = joinPath(root, `shards/${bucket}.json`);
    if (await adapter.exists(shardPath)) index.shards[bucket] = JSON.parse(await adapter.read(shardPath)) as V3LocalIndexShard;
  }
  return index;
}
