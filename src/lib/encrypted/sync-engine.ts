import { Modal, Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { OBJECT_ID_BYTES } from "./constants";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { compileIgnorePathRegex } from "./ignore";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { EncryptedManifestStore } from "./manifest-store";
import { conflictPathFor, normalizeVaultPath } from "./paths";
import { reportSyncError } from "./sync-errors";
import { ConflictPolicy, EncryptedLocalFileState, EncryptedManifest, EncryptedSyncOperation } from "./types";
import { effectiveConflictPolicy } from "./settings-policy";
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
  return effectiveConflictPolicy((plugin.settings as { conflictPolicy?: ConflictPolicy }).conflictPolicy);
}

function configuredIgnoreRules(plugin: FastSync) {
  return compileIgnorePathRegex((plugin.settings as { ignorePathRegex?: string }).ignorePathRegex ?? "");
}

async function loadStore(plugin: FastSync, allowForeignInit: boolean = false) {
  const store = new EncryptedManifestStore(plugin.githubClient, requireEncryptedPassphrase(plugin), allowForeignInit);
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

async function promptForeignRemoteForcePush(plugin: FastSync): Promise<boolean> {
  return new Promise(resolve => {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText("Remote repository is not empty");
    modal.contentEl.createEl("p", { text: "This repository does not look like it belongs to this encrypted sync plugin. Force push will initialize encrypted sync metadata and may overwrite remote encrypted state managed by this plugin." });
    const buttons = modal.contentEl.createDiv();
    buttons.createEl("button", { text: "Cancel" }).onclick = () => { modal.close(); resolve(false); };
    const confirm = buttons.createEl("button", { text: "Force push local to remote" });
    confirm.addClass("mod-warning");
    confirm.onclick = () => { modal.close(); resolve(true); };
    modal.open();
  });
}

export async function encryptedSync(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  if (plugin.isSyncInProgress || !plugin.githubClient) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    const ignoreRules = configuredIgnoreRules(plugin);
    const { store, key, manifest, manifestSha } = await loadStore(plugin, options.operation === "forcePush");

    let manifestChanged = false;
    if (options.operation === "forcePull") {
      await pullEncryptedChanges(plugin, key, manifest, true);
      await deleteLocalFilesMissingFromRemote(plugin, manifest, ignoreRules);
    } else if (options.operation === "forcePush") {
      manifestChanged = await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, true);
    } else {
      await pullEncryptedChanges(plugin, key, manifest, false);
      manifestChanged = await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, false);
    }

    const newManifestSha = manifestChanged || !manifestSha ? await store.save(manifest, key, manifestSha) : manifestSha;
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
          size: record.size,
          mtime: record.mtime,
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
  try {
    const { store, key, manifest, manifestSha } = await loadStore(plugin);
    const path = normalizeVaultPath(file.path);
    const state = ensureEncryptedState(plugin);
    const existing = manifest.files[path];
    const cached = state.files[path];
    if (existing && !existing.deleted && cached?.plaintextSha256 === existing.plaintextSha256 && cached.size === file.stat.size && cached.mtime === file.stat.mtime) return;

    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    if (existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) {
      state.files[path] = { ...cached, plaintextSha256, objectPath: existing.objectPath, remoteSha: existing.remoteSha, storage: existing.storage, chunks: existing.chunks, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
      await plugin.saveSyncData();
      return;
    }

    const objectId = existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, existing);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    const newManifestSha = await store.save(manifest, key, manifestSha);
    state.manifestSha = newManifestSha;
    state.files[path] = { plaintextSha256, objectPath: manifest.files[path].objectPath, remoteSha: manifest.files[path].remoteSha, storage: manifest.files[path].storage, chunks: manifest.files[path].chunks, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
    await plugin.saveSyncData();
  } catch (error) {
    reportSyncError("localChange", error, file.path);
  }
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

async function pushEncryptedLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>, force: boolean): Promise<boolean> {
  const state = ensureEncryptedState(plugin);
  let changed = false;
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
  const localPaths = new Set(localFiles.map(file => normalizeVaultPath(file.path)));
  for (const [path, record] of Object.entries(manifest.files)) {
    if (!record.deleted && !localPaths.has(path) && (force || state.files[path])) {
      record.deleted = true;
      record.deletedAt = Date.now();
      changed = true;
    }
  }
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const existing = manifest.files[path];
    const cached = state.files[path];
    if (!force && existing && !existing.deleted && cached?.plaintextSha256 === existing.plaintextSha256 && cached.size === file.stat.size && cached.mtime === file.stat.mtime) continue;
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    if (!force && existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) continue;
    const objectId = existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, existing);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    changed = true;
  }
  return changed;
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
