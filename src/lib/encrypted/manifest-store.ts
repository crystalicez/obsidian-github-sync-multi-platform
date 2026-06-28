import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE, ENCRYPTED_MANIFEST_PATH, ENCRYPTED_OBJECTS_ROOT, ENCRYPTED_PACKS_ROOT, ENCRYPTED_ROOT } from "./constants";
import { decryptJson, deriveEncryptionKey, encryptJson } from "./crypto";
import { randomBytes, toBase64Url } from "./bytes";
import { EncryptedManifest, EncryptedObjectRecord, EncryptedPackManifestRecord, EncryptedRepoConfig } from "./types";
import { classifyRemoteRepo } from "./remote-state";
import { ForeignRemoteError, WrongPassphraseError } from "./sync-errors";

const DEFAULT_PBKDF2_ITERATIONS = 600000;
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();
function invalidManifest(reason: string): Error {
  return new Error(`Invalid encrypted manifest: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeVaultPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path)) return false;
  const normalized = path.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (normalized !== path) return false;
  if (normalized.startsWith(`${ENCRYPTED_ROOT}/`)) return false;
  return !normalized.split("/").includes("..");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function isSafeEncryptedObjectPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(`${ENCRYPTED_OBJECTS_ROOT}/`) && path.endsWith(".enc") && !path.split("/").includes("..");
}

function isSafeEncryptedPackPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(`${ENCRYPTED_PACKS_ROOT}/`) && path.endsWith(".pack.enc") && !path.split("/").includes("..");
}

function validatePackRecord(id: string, record: unknown): asserts record is EncryptedPackManifestRecord {
  if (!isObject(record)) throw invalidManifest(`pack ${id} is not an object`);
  if (record.id !== id || !/^\d{6}$/u.test(id)) throw invalidManifest(`pack ${id} has invalid id`);
  if (!isSafeEncryptedPackPath(record.objectPath)) throw invalidManifest(`pack ${id} has unsafe object path`);
  if (typeof record.totalBytes !== "number" || record.totalBytes < 0) throw invalidManifest(`pack ${id} has invalid totalBytes`);
  if (typeof record.fileCount !== "number" || record.fileCount < 0) throw invalidManifest(`pack ${id} has invalid fileCount`);
}

function validateObjectRecord(path: string, record: unknown, packs: Record<string, EncryptedPackManifestRecord>): asserts record is EncryptedObjectRecord {
  if (!isObject(record)) throw invalidManifest(`file ${path} is not an object`);
  if (!isSafeVaultPath(path) || record.path !== path) throw invalidManifest(`unsafe vault path ${path}`);
  if (typeof record.id !== "string" || record.id.length === 0) throw invalidManifest(`file ${path} has invalid id`);
  if (!isSha256(record.plaintextSha256)) throw invalidManifest(`file ${path} has invalid plaintext hash`);
  if (typeof record.size !== "number" || record.size < 0) throw invalidManifest(`file ${path} has invalid size`);
  if (typeof record.mtime !== "number" || record.mtime < 0) throw invalidManifest(`file ${path} has invalid mtime`);
  const storage = record.storage ?? "single";
  if (storage === "pack") {
    if (typeof record.packId !== "string" || !packs[record.packId]) throw invalidManifest(`file ${path} references missing pack`);
    if (record.objectPath !== packs[record.packId].objectPath) throw invalidManifest(`file ${path} pack object path mismatch`);
    return;
  }
  if (storage === "chunked") {
    if (!Array.isArray(record.chunks) || record.chunks.length === 0) throw invalidManifest(`file ${path} has invalid chunks`);
    for (const chunk of record.chunks) {
      if (!isObject(chunk) || typeof chunk.index !== "number" || chunk.index < 1 || !isSafeEncryptedObjectPath(chunk.path)) throw invalidManifest(`file ${path} has invalid chunk`);
    }
    return;
  }
  if (storage !== "single") throw invalidManifest(`file ${path} has invalid storage`);
  if (!isSafeEncryptedObjectPath(record.objectPath)) throw invalidManifest(`file ${path} has unsafe object path`);
}

function validateEncryptedManifest(value: unknown): EncryptedManifest {
  if (!isObject(value)) throw invalidManifest("manifest is not an object");
  if (value.formatVersion !== ENCRYPTED_FORMAT_VERSION || value.indexMode !== ENCRYPTED_INDEX_MODE) throw invalidManifest("unsupported format");
  if (typeof value.updatedAt !== "number" || !isObject(value.files)) throw invalidManifest("missing metadata");
  const packs = (isObject(value.packs) ? value.packs : {}) as Record<string, EncryptedPackManifestRecord>;
  for (const [id, record] of Object.entries(packs)) validatePackRecord(id, record);
  for (const [path, record] of Object.entries(value.files)) validateObjectRecord(path, record, packs);
  return value as unknown as EncryptedManifest;
}

function cachedEncryptionKey(passphrase: string, config: EncryptedRepoConfig): Promise<CryptoKey> {
  const cacheKey = `${config.kdf}:${config.kdfParams.iterations}:${config.kdfParams.salt}:${passphrase}`;
  let key = derivedKeyCache.get(cacheKey);
  if (!key) {
    key = deriveEncryptionKey(passphrase, config);
    derivedKeyCache.set(cacheKey, key);
  }
  return key;
}

export class EncryptedManifestStore {
  constructor(private readonly github: GitHubClient, private readonly passphrase: string, private readonly allowForeignInit: boolean = false) {}

  async loadOrCreate(): Promise<{ config: EncryptedRepoConfig; manifest: EncryptedManifest; manifestSha?: string; key: CryptoKey }> {
    const config = await this.loadOrCreateConfig();
    const key = await cachedEncryptionKey(this.passphrase, config);
    const remoteManifest = await this.github.getFile(ENCRYPTED_MANIFEST_PATH);
    if (!remoteManifest) {
      return {
        config,
        key,
        manifest: { formatVersion: ENCRYPTED_FORMAT_VERSION, indexMode: ENCRYPTED_INDEX_MODE, updatedAt: Date.now(), files: {} },
      };
    }
    try {
      const manifest = validateEncryptedManifest(await decryptJson<EncryptedManifest>(key, GitHubClient.decodeContent(remoteManifest.content)));
      return { config, key, manifest, manifestSha: remoteManifest.sha };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid encrypted manifest:")) throw error;
      throw new WrongPassphraseError();
    }
  }

  async save(manifest: EncryptedManifest, key: CryptoKey, manifestSha?: string): Promise<string> {
    manifest.updatedAt = Date.now();
    const encrypted = await encryptJson(key, manifest);
    return this.github.putFile(ENCRYPTED_MANIFEST_PATH, encrypted, manifestSha);
  }

  private async loadOrCreateConfig(): Promise<EncryptedRepoConfig> {
    const remoteConfig = await this.github.getFile(ENCRYPTED_CONFIG_PATH);
    if (remoteConfig) return JSON.parse(GitHubClient.decodeContent(remoteConfig.content)) as EncryptedRepoConfig;

    const state = await classifyRemoteRepo(this.github);
    if (state.kind === "foreign-nonempty" && !this.allowForeignInit) throw new ForeignRemoteError();
    if (state.kind === "corrupt-plugin") throw new Error(state.message ?? "Encrypted repository metadata is corrupt.");

    const now = Date.now();
    const config: EncryptedRepoConfig = {
      formatVersion: ENCRYPTED_FORMAT_VERSION,
      indexMode: ENCRYPTED_INDEX_MODE,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: DEFAULT_PBKDF2_ITERATIONS, salt: toBase64Url(randomBytes(16)) },
      createdAt: now,
      updatedAt: now,
    };
    await this.github.putFile(ENCRYPTED_CONFIG_PATH, JSON.stringify(config, null, 2));
    return config;
  }
}
