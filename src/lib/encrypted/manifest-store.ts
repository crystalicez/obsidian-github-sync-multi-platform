import { GitHubClient, readGitHubFileBytes, readGitHubBlobOrFileBytes } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE, ENCRYPTED_MANIFEST_PATH, ENCRYPTED_OBJECTS_ROOT, ENCRYPTED_PACKS_ROOT, ENCRYPTED_ROOT } from "./constants";
import { decryptJson, deriveEncryptionKey, encryptJson } from "./crypto";
import { fromBase64Url, randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "./bytes";
import { EncryptedManifest, EncryptedObjectRecord, EncryptedPackManifestRecord, EncryptedRepoConfig } from "./types";
import { classifyRemoteRepo } from "./remote-state";
import { ForeignRemoteError, WrongPassphraseError } from "./sync-errors";

const DEFAULT_PBKDF2_ITERATIONS = 600000;
const MIN_PBKDF2_ITERATIONS = 100000;
const MAX_PBKDF2_ITERATIONS = 2000000;
const DERIVED_KEY_CACHE_LIMIT = 32;
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

function invalidManifest(reason: string): Error {
  return new Error(`Invalid encrypted manifest: ${reason}`);
}

function invalidConfig(reason: string): Error {
  return new Error(`Invalid encrypted config: ${reason}`);
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

function validateEncryptedConfig(value: unknown): EncryptedRepoConfig {
  if (!isObject(value)) throw invalidConfig("config is not an object");
  if (value.formatVersion !== ENCRYPTED_FORMAT_VERSION || value.indexMode !== ENCRYPTED_INDEX_MODE) throw invalidConfig("unsupported format");
  if (value.algorithm !== "AES-GCM") throw invalidConfig("unsupported encryption algorithm");
  if (value.kdf !== "PBKDF2-SHA-256") throw invalidConfig("unsupported key derivation function");
  if (!isObject(value.kdfParams)) throw invalidConfig("missing key derivation parameters");
  const iterations = value.kdfParams.iterations;
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) throw invalidConfig("PBKDF2 iterations out of supported range");
  const salt = value.kdfParams.salt;
  if (typeof salt !== "string" || !/^[A-Za-z0-9_-]+$/u.test(salt)) throw invalidConfig("salt is not base64url");
  const saltBytes = fromBase64Url(salt);
  if (saltBytes.byteLength < 16 || saltBytes.byteLength > 64) throw invalidConfig("salt length is unsupported");
  if (typeof value.createdAt !== "number" || value.createdAt < 0 || typeof value.updatedAt !== "number" || value.updatedAt < 0) throw invalidConfig("invalid timestamps");
  return value as unknown as EncryptedRepoConfig;
}

async function cachedEncryptionKey(passphrase: string, config: EncryptedRepoConfig): Promise<CryptoKey> {
  const cacheMaterial = `${config.kdf}:${config.kdfParams.iterations}:${config.kdfParams.salt}:${passphrase}`;
  const cacheKey = await sha256Hex(utf8ToBytes(cacheMaterial));
  let key = derivedKeyCache.get(cacheKey);
  if (!key) {
    key = deriveEncryptionKey(passphrase, config);
    derivedKeyCache.set(cacheKey, key);
    if (derivedKeyCache.size > DERIVED_KEY_CACHE_LIMIT) {
      const oldestKey = derivedKeyCache.keys().next().value;
      if (oldestKey) derivedKeyCache.delete(oldestKey);
    }
  }
  return key;
}

export class EncryptedManifestStore {
  constructor(private readonly github: GitHubClient, private readonly passphrase: string, private readonly allowForeignInit: boolean = false) {}

  async loadOrCreate(): Promise<{ config: EncryptedRepoConfig; manifest: EncryptedManifest; manifestSha?: string; key: CryptoKey }> {
    const config = await this.loadOrCreateConfig();
    const key = await cachedEncryptionKey(this.passphrase, config);
    const remoteManifest = await readGitHubBlobOrFileBytes(this.github, ENCRYPTED_MANIFEST_PATH, undefined);
    if (!remoteManifest) {
      return {
        config,
        key,
        manifest: { formatVersion: ENCRYPTED_FORMAT_VERSION, indexMode: ENCRYPTED_INDEX_MODE, updatedAt: Date.now(), files: {} },
      };
    }
    try {
      const manifest = validateEncryptedManifest(await decryptJson<EncryptedManifest>(key, new TextDecoder().decode(remoteManifest.bytes)));
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
    const remoteConfig = await readGitHubBlobOrFileBytes(this.github, ENCRYPTED_CONFIG_PATH);
    if (remoteConfig) {
      try {
        return validateEncryptedConfig(JSON.parse(new TextDecoder().decode(remoteConfig.bytes)));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid encrypted config:")) throw error;
        throw invalidConfig(error instanceof Error ? error.message : "config could not be parsed");
      }
    }

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
