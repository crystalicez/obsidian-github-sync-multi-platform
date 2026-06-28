import { Modal, Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { OBJECT_ID_BYTES } from "./constants";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { compileIgnorePathRegex } from "./ignore";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { planEncryptedPacks } from "./pack-planner";
import { downloadEncryptedPack, uploadEncryptedPack } from "./pack-sync";
import { chooseEncryptedStorageMode } from "./scale-policy";
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

function blockIfEncryptedForcePushRequired(plugin: FastSync, operation: EncryptedSyncOperation, path?: string): boolean {
  if (!(plugin.settings as { encryptedForcePushRequired?: boolean }).encryptedForcePushRequired || operation === "forcePush") return false;
  reportSyncError(operation, new Error("Encrypted sync was just enabled. Run Force push once to initialize the encrypted remote state."), path);
  return true;
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
  if (blockIfEncryptedForcePushRequired(plugin, options.operation)) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    const ignoreRules = configuredIgnoreRules(plugin);
    const { store, key, manifest, manifestSha } = await loadStore(plugin, options.operation === "forcePush");

    let manifestChanged = false;
    if (options.operation === "forcePull") {
      if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, true);
      await pullEncryptedChanges(plugin, key, manifest, true);
      await deleteLocalFilesMissingFromRemote(plugin, manifest, ignoreRules);
    } else if (options.operation === "forcePush") {
      manifestChanged = await pushEncryptedForceLocalChanges(plugin, key, manifest, ignoreRules);
    } else {
      if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, false);
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
          packId: record.packId,
          manifestUpdatedAt: manifest.updatedAt,
          size: record.size,
          mtime: record.mtime,
        };
      }
    }
    if (options.operation === "forcePush") {
      (plugin.settings as { encryptedForcePushRequired?: boolean }).encryptedForcePushRequired = false;
      if (typeof (plugin as FastSync & { saveSettings?: () => Promise<void> }).saveSettings === "function") await (plugin as FastSync & { saveSettings: () => Promise<void> }).saveSettings();
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
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", file.path)) return;
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

    const reusableExisting = existing?.storage === "pack" ? undefined : existing;
    const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
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
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", file.path)) return;
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
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", _file.path)) return;
  await encryptedSync(plugin, { operation: "localChange" });
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const [path, record] of Object.entries(manifest.files)) {
    if (record.deleted || record.storage === "pack") continue;
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

async function pushEncryptedForceLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>): Promise<boolean> {
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
  const totalBytes = localFiles.reduce((sum, file) => sum + file.stat.size, 0);
  const mode = chooseEncryptedStorageMode({ fileCount: localFiles.length, totalBytes });
  if (mode === "pack") return pushEncryptedPackLocalChanges(plugin, key, manifest, localFiles);
  return pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, true);
}

async function pushEncryptedPackLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, localFiles: TFile[]): Promise<boolean> {
  const plan = planEncryptedPacks(localFiles.map(file => ({ path: normalizeVaultPath(file.path), size: file.stat.size, mtime: file.stat.mtime })));
  const filesByPath = new Map(localFiles.map(file => [normalizeVaultPath(file.path), file] as const));
  manifest.files = {};
  manifest.packs = {};

  for (const pack of plan.packs) {
    const archiveFiles = [];
    for (const entry of pack.files) {
      const file = filesByPath.get(entry.path);
      if (!file) continue;
      const bytes = await readVaultFileBytes(plugin.app.vault, file);
      const plaintextSha256 = await sha256Hex(bytes);
      archiveFiles.push({ path: entry.path, mtime: entry.mtime, bytes, plaintextSha256 });
      manifest.files[entry.path] = {
        id: `${pack.id}:${entry.path}`,
        path: entry.path,
        objectPath: pack.objectPath,
        plaintextSha256,
        storage: "pack",
        packId: pack.id,
        size: entry.size,
        mtime: entry.mtime,
        deleted: false,
        deletedAt: undefined,
      };
    }
    manifest.packs[pack.id] = await uploadEncryptedPack(plugin.githubClient, key, pack.id, archiveFiles, manifest.packs[pack.id]);
  }
  return true;
}

async function pullEncryptedPackChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const pack of Object.values(manifest.packs ?? {})) {
    const files = await downloadEncryptedPack(plugin.githubClient, key, pack);
    for (const file of files) {
      const record = manifest.files[file.path];
      if (!record || record.deleted || record.storage !== "pack" || record.packId !== pack.id) continue;
      if (!shouldSyncEncryptedFile({ path: file.path, stat: { size: file.bytes.byteLength, mtime: file.mtime } } as TFile, ignoreRules)) continue;
      const plaintextSha256 = await sha256Hex(file.bytes);
      if (plaintextSha256 !== record.plaintextSha256) throw new Error(`Encrypted pack file failed integrity check for ${file.path}.`);
      const localState = state.files[file.path];
      if (!force && localState?.plaintextSha256 === record.plaintextSha256) continue;
      const localFile = plugin.app.vault.getAbstractFileByPath(file.path);
      if (!force && localFile instanceof TFile && localState) {
        const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
        if (localState.plaintextSha256 !== localHash) {
          const resolution = await chooseConflictResolution(plugin, configuredConflictPolicy(plugin), file.path, localFile, record.mtime);
          if (resolution === "keep-local") continue;
          if (resolution === "copy-remote") {
            await writeVaultFileBytes(plugin.app.vault, conflictPathFor(file.path, Date.now(), "remote"), file.bytes);
            continue;
          }
          if (resolution === "merged") {
            const localText = await plugin.app.vault.read(localFile);
            const remoteText = new TextDecoder().decode(file.bytes);
            await writeVaultFileBytes(plugin.app.vault, file.path, new TextEncoder().encode(mergeTextContent(localText, remoteText)));
            continue;
          }
        }
      }
      plugin.addIgnoredFile(file.path);
      try {
        await writeVaultFileBytes(plugin.app.vault, file.path, file.bytes);
      } finally {
        plugin.removeIgnoredFile(file.path);
      }
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
    const reusableExisting = existing?.storage === "pack" ? undefined : existing;
    const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
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
