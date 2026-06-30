export type EncryptedSnapshotStorageKind = "object" | "pack" | "chunked";

export interface EncryptedSnapshotFileRecord {
  path: string;
  objectId: string;
  storage: EncryptedSnapshotStorageKind;
  objectPath?: string;
  remoteSha?: string;
  plaintextSha256: string;
  size: number;
  mtime: number;
  packId?: string;
  chunkIds?: string[];
  chunks?: Array<{ index: number; path: string; remoteSha?: string }>;
  deleted?: boolean;
  deletedAt?: number;
}

export interface EncryptedSnapshotPackRecord {
  id: string;
  objectPath: string;
  remoteSha?: string;
  totalBytes: number;
  fileCount: number;
  updatedAt: number;
}

export interface EncryptedSnapshotManifest {
  formatVersion: 2;
  snapshotId: string;
  parentSnapshotIds: string[];
  generation: number;
  createdAt: number;
  files: Record<string, EncryptedSnapshotFileRecord>;
  packs?: Record<string, EncryptedSnapshotPackRecord>;
}

export interface EncryptedSnapshotHead {
  formatVersion: 2;
  snapshotId: string;
  generation: number;
  updatedAt: number;
}

export interface StoredEncryptedSnapshotHead {
  head: EncryptedSnapshotHead;
  sha: string;
}

export interface StoredEncryptedSnapshot {
  snapshot: EncryptedSnapshotManifest;
  sha: string;
  path: string;
}