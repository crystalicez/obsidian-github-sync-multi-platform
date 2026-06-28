export type EncryptedStorageKind = "single" | "chunked" | "pack";
export type EncryptedSyncOperation = "normal" | "manual" | "forcePush" | "forcePull" | "startup" | "scheduled" | "localChange";
export type ConflictPolicy = "copy" | "newer" | "merge" | "ask";
export type RemoteRepoStateKind = "empty" | "encrypted-plugin" | "foreign-nonempty" | "corrupt-plugin" | "wrong-passphrase";

export interface EncryptedChunkRecord {
  index: number;
  path: string;
  remoteSha?: string;
}

export interface RemoteRepoState {
  kind: RemoteRepoStateKind;
  message?: string;
}

export interface EncryptedRepoConfig {
  formatVersion: 1;
  indexMode: "single";
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA-256";
  kdfParams: { iterations: number; salt: string };
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedObjectRecord {
  id: string;
  path: string;
  objectPath: string;
  plaintextSha256: string;
  remoteSha?: string;
  storage?: EncryptedStorageKind;
  chunks?: EncryptedChunkRecord[];
  packId?: string;
  size: number;
  mtime: number;
  deleted?: boolean;
  deletedAt?: number;
}

export interface EncryptedManifest {
  formatVersion: 1;
  indexMode: "single";
  updatedAt: number;
  files: Record<string, EncryptedObjectRecord>;
  packs?: Record<string, EncryptedPackManifestRecord>;
}

export interface EncryptedLocalFileState {
  plaintextSha256: string;
  objectPath: string;
  remoteSha?: string;
  storage?: EncryptedStorageKind;
  chunks?: EncryptedChunkRecord[];
  packId?: string;
  manifestUpdatedAt: number;
  size?: number;
  mtime?: number;
}

export type EncryptedStorageMode = "object" | "pack";

export interface EncryptedPackFileEntry {
  path: string;
  size: number;
  mtime: number;
  plaintextSha256?: string;
}

export interface EncryptedPackPlanRecord {
  id: string;
  objectPath: string;
  totalBytes: number;
  files: EncryptedPackFileEntry[];
}

export interface EncryptedPackPlan {
  totalFiles: number;
  totalBytes: number;
  packs: EncryptedPackPlanRecord[];
}

export interface EncryptedPackManifestRecord {
  id: string;
  objectPath: string;
  remoteSha?: string;
  totalBytes: number;
  fileCount: number;
  updatedAt: number;
}
