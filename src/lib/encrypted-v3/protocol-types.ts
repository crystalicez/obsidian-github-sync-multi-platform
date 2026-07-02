export const ENCRYPTED_V3_ROOT = ".obsidian-github-sync-v3";
export const ENCRYPTED_V3_HEAD_PATH = `${ENCRYPTED_V3_ROOT}/head.enc`;

export interface EncryptedV3RemoteHead {
  formatVersion: 3;
  epoch: number;
  generation: number;
  headId: string;
  shardHashes: Record<string, string>;
  deviceId: string;
  updatedAt: number;
}

export interface EncryptedV3ShardRecord {
  pathId: string;
  encryptedPath: string;
  fileId: string;
  plaintextSha256: string;
  size: number;
  mtime: number;
  storage: "loose" | "chunked" | "base-pack" | "delta-pack";
  objectPath: string;
  version: string;
  updatedBy: string;
  updatedAt: number;
  deleted?: boolean;
}

export interface EncryptedV3Shard {
  formatVersion: 3;
  bucket: string;
  records: Record<string, EncryptedV3ShardRecord>;
}
