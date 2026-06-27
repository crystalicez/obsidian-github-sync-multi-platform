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
}

export interface EncryptedLocalFileState {
  plaintextSha256: string;
  objectPath: string;
  remoteSha?: string;
  manifestUpdatedAt: number;
}
