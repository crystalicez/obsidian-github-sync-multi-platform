import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE, ENCRYPTED_MANIFEST_PATH } from "./constants";
import { decryptJson, deriveEncryptionKey, encryptJson } from "./crypto";
import { randomBytes, toBase64Url } from "./bytes";
import { EncryptedManifest, EncryptedRepoConfig } from "./types";
import { classifyRemoteRepo } from "./remote-state";
import { ForeignRemoteError, WrongPassphraseError } from "./sync-errors";

const DEFAULT_PBKDF2_ITERATIONS = 600000;

export class EncryptedManifestStore {
  constructor(private readonly github: GitHubClient, private readonly passphrase: string) {}

  async loadOrCreate(): Promise<{ config: EncryptedRepoConfig; manifest: EncryptedManifest; manifestSha?: string; key: CryptoKey }> {
    const config = await this.loadOrCreateConfig();
    const key = await deriveEncryptionKey(this.passphrase, config);
    const remoteManifest = await this.github.getFile(ENCRYPTED_MANIFEST_PATH);
    if (!remoteManifest) {
      return {
        config,
        key,
        manifest: { formatVersion: ENCRYPTED_FORMAT_VERSION, indexMode: ENCRYPTED_INDEX_MODE, updatedAt: Date.now(), files: {} },
      };
    }
    try {
      const manifest = await decryptJson<EncryptedManifest>(key, GitHubClient.decodeContent(remoteManifest.content));
      return { config, key, manifest, manifestSha: remoteManifest.sha };
    } catch (_error) {
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
    if (state.kind === "foreign-nonempty") throw new ForeignRemoteError();
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