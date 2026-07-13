export const V4_FORMAT_VERSION = 4 as const;
export const V4_ROOT = ".obsidian-github-sync-v4";
export const V4_CONFIG_PATH = `${V4_ROOT}/config.json`;
export const V4_HEAD_PATH = `${V4_ROOT}/head`;

export type V4StorageMode = "plaintext" | "encrypted";
export type V4ObjectStorage = "single" | "chunked" | "pack";

export interface V4RemoteConfig {
  formatVersion: typeof V4_FORMAT_VERSION;
  mode: V4StorageMode;
  repoId: string;
  algorithm?: "AES-GCM";
  kdf?: "PBKDF2-SHA-256";
  kdfParams?: { iterations: number; salt: string };
}

export interface V4RemoteHead {
  formatVersion: typeof V4_FORMAT_VERSION;
  mode: V4StorageMode;
  epoch: number;
  generation: number;
  journalId: string;
  shardHashes: Record<string, string>;
  updatedAt: number;
  deviceId: string;
}

export interface V4FileRecord {
  pathId: string;
  fileId: string;
  plaintextSha256: string;
  size: number;
  mtime: number;
  remoteVersion: string;
  remotePath: string;
  storage: V4ObjectStorage;
  partPaths?: string[];
  packId?: string;
  encryptedPath?: string;
  deleted?: boolean;
}
