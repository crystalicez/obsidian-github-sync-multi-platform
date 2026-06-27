import { Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { OBJECT_ID_BYTES } from "./constants";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { compileIgnorePathRegex } from "./ignore";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { EncryptedManifestStore } from "./manifest-store";
import { conflictPathFor, normalizeVaultPath } from "./paths";
import { reportSyncError } from "./sync-errors";
import { ConflictPolicy, EncryptedLocalFileState, EncryptedManifest, EncryptedObjectRecord, EncryptedSyncOperation } from "./types";
import { deleteVaultFileIfExists, listEncryptedSyncCandidates, readVaultFileBytes, shouldSyncEncryptedFile, writeVaultFileBytes } from "./vault";
import { randomBytes, sha256Hex, toBase64Url } from "./bytes";

export interface EncryptedSyncOptions {
  operation: EncryptedSyncOperation;
}

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

function configuredConflictPolicy(plugin: FastSync): ConflictPolicy {
  return ((plugin.settings as { conflictPolicy?: ConflictPolicy }).conflictPolicy ?? "copy") as ConflictPolicy;
}

function configuredIgnoreRules(plugin: FastSync) {
  return compileIgnorePathRegex((plugin.settings as { ignorePathRegex?: string }).ignorePathRegex ?? "");
}

async function loadStore(plugin: FastSync) {
  const store = new EncryptedManifestStore(plugin.githubClient, requireEncryptedPassphrase(plugin));
  return { store, ...(await store.loadOrCreate()) };
}

export async function encryptedFullSync(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "normal" });
}

export async function encryptedManualSync(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "manual" });
}

export async function encryptedForcePush(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "forcePush" });
}

export async function encryptedForcePull(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "forcePull" });
}

export async function encryptedSync(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  if (plugin.isSyncInProgress || !plugin.githubClient) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    const ignoreRules = configuredIgnoreRules(plugin);
    const { store, key, manifest, manifestSha } = await loadStore(plugin);

    if (options.operation === "forcePull") {
      await pullEncryptedChanges(plugin, key, manifest, true);
      await deleteLocalFilesMissingFromRemote(plugin, manifest, ignoreRules);
    } else if (options.operation === "forcePush") {
      await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, true);
    } else {
      await pullEncryptedChanges(plugin, key, manifest, false);
      await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, false);
    }

    const newManifestSha = await store.save(manifest, key, manifestSha);
    plugin.syncData.encrypted = { files: {}, manifestSha: newManifestSha };
    for (const [path, record] of Object.entries(manifest.files)) {
      if (!record.deleted) {
        plugin.syncData.encrypted.files[path] = {
          plaintextSha256: record.plaintextSha256,
          objectPath: record.objectPath,
          remoteSha: record.remoteSha,
          storage: record.storage,
          chunks: record.chunks,
          manifestUpdatedAt: manifest.updatedAt,
        };
      }
    }
    await plugin.saveSyncData();
    new Notice(`Encrypted ${options.operation} completed`);
  } catch (error) {
    reportSyncError(options.operation, error);
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
  }
}

export async function encryptedModify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!shouldSyncEncryptedFile(file, configuredIgnoreRules(plugin)) || !plugin.githubClient) return;
  await encryptedSync(plugin, { operation: "localChange" });
}

export async function encryptedDelete(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;
  try {
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
  } catch (error) {
    reportSyncError("localChange", error, file.path);
  }
}

export async function encryptedRename(_file: TAbstractFile, _oldfile: string, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  await encryptedSync(plugin, { operation: "localChange" });
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const [path, record] of Object.entries(manifest.files)) {
    if (record.deleted) continue;
    const localState = state.files[path];
    if (!force && localState?.plaintextSha256 === record.plaintextSha256) continue;
    const plaintext = await downloadEncryptedFileObject(plugin.githubClient, key, record);
    const localFile = plugin.app.vault.getAbstractFileByPath(path);
    if (!force && localFile instanceof TFile && localState) {
      const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
      if (localState.plaintextSha256 !== localHash) {
        const resolution = await chooseConflictResolution(plugin, configuredConflictPolicy(plugin), path, localFile, record.mtime);
        if (resolution === "keep-local") continue;
        if (resolution === "copy-remote") {
          await writeVaultFileBytes(plugin.app.vault, conflictPathFor(path, Date.now(), "remote"), plaintext);
          continue;
        }
        if (resolution === "merged") {
          const localText = await plugin.app.vault.read(localFile);
          const remoteText = new TextDecoder().decode(plaintext);
          await writeVaultFileBytes(plugin.app.vault, path, new TextEncoder().encode(mergeTextContent(localText, remoteText)));
          continue;
        }
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

async function pushEncryptedLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>, force: boolean): Promise<void> {
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
  const localPaths = new Set(localFiles.map(file => normalizeVaultPath(file.path)));
  for (const [path, record] of Object.entries(manifest.files)) {
    if (!record.deleted && !localPaths.has(path) && (force || ensureEncryptedState(plugin).files[path])) {
      record.deleted = true;
      record.deletedAt = Date.now();
    }
  }
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    const existing = manifest.files[path];
    if (!force && existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) continue;
    const objectId = existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, existing);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
  }
}

async function deleteLocalFilesMissingFromRemote(plugin: FastSync, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>): Promise<void> {
  const remotePaths = new Set(Object.entries(manifest.files).filter(([, record]) => !record.deleted).map(([path]) => path));
  for (const file of listEncryptedSyncCandidates(plugin.app.vault, ignoreRules)) {
    const path = normalizeVaultPath(file.path);
    if (!remotePaths.has(path)) {
      plugin.addIgnoredFile(path);
      try {
        await deleteVaultFileIfExists(plugin.app.vault, path);
      } finally {
        plugin.removeIgnoredFile(path);
      }
    }
  }
}