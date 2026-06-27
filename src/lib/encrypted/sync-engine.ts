import { Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { GitHubClient } from "../github-api";
import { OBJECT_ID_BYTES } from "./constants";
import { decryptBytes, encryptBytes } from "./crypto";
import { EncryptedManifestStore } from "./manifest-store";
import { conflictPathFor, normalizeVaultPath, objectPathForId } from "./paths";
import { EncryptedLocalFileState, EncryptedManifest, EncryptedObjectRecord } from "./types";
import { listEncryptedSyncCandidates, readVaultFileBytes, shouldSyncEncryptedFile, writeVaultFileBytes } from "./vault";
import { randomBytes, sha256Hex, toBase64Url } from "./bytes";

function ensureEncryptedState(plugin: FastSync): { files: { [path: string]: EncryptedLocalFileState }; manifestSha?: string } {
  if (!plugin.syncData.encrypted) plugin.syncData.encrypted = { files: {} };
  return plugin.syncData.encrypted;
}

function requireEncryptedPassphrase(plugin: FastSync): string {
  const settings = plugin.settings as { encryptionPassphrase?: string };
  const passphrase = settings.encryptionPassphrase?.trim();
  if (!passphrase) throw new Error("Encrypted sync passphrase is required.");
  return passphrase;
}

async function loadStore(plugin: FastSync) {
  const store = new EncryptedManifestStore(plugin.githubClient, requireEncryptedPassphrase(plugin));
  return { store, ...(await store.loadOrCreate()) };
}

async function uploadEncryptedObject(
  plugin: FastSync,
  key: CryptoKey,
  plaintext: Uint8Array,
  existing?: EncryptedObjectRecord
): Promise<EncryptedObjectRecord> {
  const payload = await encryptBytes(key, plaintext);
  const objectId = existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
  const objectPath = existing?.objectPath ?? objectPathForId(objectId);
  const sha = await plugin.githubClient.putFile(objectPath, JSON.stringify(payload), existing?.remoteSha);
  return {
    id: objectId,
    path: existing?.path ?? "",
    objectPath,
    plaintextSha256: await sha256Hex(plaintext),
    remoteSha: sha,
    size: plaintext.byteLength,
    mtime: Date.now(),
  };
}

export async function encryptedFullSync(plugin: FastSync): Promise<void> {
  if (plugin.isSyncInProgress || !plugin.githubClient) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    const state = ensureEncryptedState(plugin);
    const { store, key, manifest, manifestSha } = await loadStore(plugin);
    await pullEncryptedChanges(plugin, key, manifest);
    await pushEncryptedLocalChanges(plugin, key, manifest);
    const newManifestSha = await store.save(manifest, key, manifestSha);
    plugin.syncData.encrypted = { files: {}, manifestSha: newManifestSha };
    for (const [path, record] of Object.entries(manifest.files)) {
      if (!record.deleted) {
        plugin.syncData.encrypted.files[path] = {
          plaintextSha256: record.plaintextSha256,
          objectPath: record.objectPath,
          remoteSha: record.remoteSha,
          manifestUpdatedAt: manifest.updatedAt,
        };
      }
    }
    state.manifestSha = newManifestSha;
    await plugin.saveSyncData();
    new Notice("Encrypted sync completed");
  } catch (error) {
    console.error("Encrypted sync failed:", error);
    new Notice(`Encrypted sync failed: ${(error as Error).message}`);
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
  }
}

export async function encryptedModify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!shouldSyncEncryptedFile(file) || !plugin.githubClient) return;
  await encryptedFullSync(plugin);
}

export async function encryptedDelete(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;
  const { store, key, manifest, manifestSha } = await loadStore(plugin);
  const path = normalizeVaultPath(file.path);
  const record = manifest.files[path];
  if (record) {
    record.deleted = true;
    record.deletedAt = Date.now();
    await store.save(manifest, key, manifestSha);
    delete ensureEncryptedState(plugin).files[path];
    await plugin.saveSyncData();
  }
}

export async function encryptedRename(_file: TAbstractFile, _oldfile: string, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  await encryptedFullSync(plugin);
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const [path, record] of Object.entries(manifest.files)) {
    if (record.deleted) continue;
    const localState = state.files[path];
    if (localState?.plaintextSha256 === record.plaintextSha256) continue;
    const remote = await plugin.githubClient.getFile(record.objectPath);
    if (!remote) throw new Error(`Missing encrypted object: ${record.objectPath}`);
    const plaintext = await decryptBytes(key, JSON.parse(GitHubClient.decodeContent(remote.content)));
    const localFile = plugin.app.vault.getAbstractFileByPath(path);
    if (localFile instanceof TFile && localState) {
      const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
      if (localState.plaintextSha256 !== localHash) {
        await writeVaultFileBytes(plugin.app.vault, conflictPathFor(path, Date.now(), "remote"), plaintext);
        continue;
      }
    }
    plugin.addIgnoredFile(path);
    try {
      await writeVaultFileBytes(plugin.app.vault, path, plaintext);
    } finally {
      plugin.removeIgnoredFile(path);
    }
  }
}

async function pushEncryptedLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest): Promise<void> {
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault);
  const localPaths = new Set(localFiles.map(file => normalizeVaultPath(file.path)));
  for (const [path, record] of Object.entries(manifest.files)) {
    if (!record.deleted && !localPaths.has(path) && ensureEncryptedState(plugin).files[path]) {
      record.deleted = true;
      record.deletedAt = Date.now();
    }
  }
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    const existing = manifest.files[path];
    if (existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) continue;
    const uploaded = await uploadEncryptedObject(plugin, key, plaintext, existing);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
  }
}
