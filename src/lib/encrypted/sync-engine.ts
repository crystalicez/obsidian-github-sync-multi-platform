import { Modal, Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { ENCRYPTED_PACK_PLAINTEXT_BYTES, OBJECT_ID_BYTES } from "./constants";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { compileIgnorePathRegex } from "./ignore";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { planEncryptedPacks } from "./pack-planner";
import { downloadEncryptedPack, uploadEncryptedPack } from "./pack-sync";
import { chooseEncryptedStorageMode } from "./scale-policy";
import { EncryptedManifestStore } from "./manifest-store";
import { classifyRemoteRepo } from "./remote-state";
import { conflictPathFor, normalizeVaultPath } from "./paths";
import { reportSyncError } from "./sync-errors";
import { ConflictPolicy, EncryptedLocalFileState, EncryptedManifest, EncryptedPackManifestRecord, EncryptedSyncOperation } from "./types";
import { effectiveConflictPolicy } from "./settings-policy";
import { deleteVaultFileIfExists, listEncryptedSyncCandidates, readVaultFileBytes, shouldSyncEncryptedFile, writeVaultFileBytes } from "./vault";
import { randomBytes, sha256Hex, toBase64Url } from "./bytes";

const syncQueues = new WeakMap<FastSync, Promise<any>>();

function getSyncQueue(plugin: FastSync): Promise<any> {
  let queue = syncQueues.get(plugin);
  if (!queue) {
    queue = Promise.resolve();
    syncQueues.set(plugin, queue);
  }
  return queue;
}

function enqueue<T>(plugin: FastSync, task: () => Promise<T>): Promise<T> {
  const queue = getSyncQueue(plugin);
  const next = queue.then(task);
  syncQueues.set(plugin, next.then(() => undefined, () => undefined));
  return next;
}

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
async function downloadManifestRecordBytes(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, record: EncryptedManifest["files"][string]): Promise<Uint8Array> {
  if (record.storage === "pack") {
    const pack = record.packId ? manifest.packs?.[record.packId] : undefined;
    if (!pack) throw new Error(`Missing encrypted pack record for ${record.path}`);
    const files = await downloadEncryptedPack(plugin.githubClient, key, pack);
    const file = files.find(entry => entry.path === record.path);
    if (!file) throw new Error(`Missing encrypted pack file: ${record.path}`);
    return file.bytes;
  }
  return downloadEncryptedFileObject(plugin.githubClient, key, record);
}

async function writeIgnoredVaultBytes(plugin: FastSync, path: string, bytes: Uint8Array): Promise<void> {
  plugin.addIgnoredFile(path);
  try {
    await writeVaultFileBytes(plugin.app.vault, path, bytes);
  } finally {
    plugin.removeIgnoredFile(path);
  }
}

function localStatForRecord(plugin: FastSync, path: string, record: EncryptedManifest["files"][string]): { size: number; mtime: number } {
  const localFile = plugin.app.vault.getAbstractFileByPath(path);
  if (localFile instanceof TFile) return { size: localFile.stat.size, mtime: localFile.stat.mtime };
  return { size: record.size, mtime: record.mtime };
}

function cacheEncryptedStateForRecord(plugin: FastSync, path: string, record: EncryptedManifest["files"][string]): void {
  const state = ensureEncryptedState(plugin);
  const stat = localStatForRecord(plugin, path, record);
  state.files[path] = {
    plaintextSha256: record.plaintextSha256,
    objectPath: record.objectPath,
    remoteSha: record.remoteSha,
    storage: record.storage,
    chunks: record.chunks,
    packId: record.packId,
    manifestUpdatedAt: Date.now(),
    size: stat.size,
    mtime: stat.mtime,
  };
}

async function resolveRemoteChangedBeforeLocalMutation(
  plugin: FastSync,
  key: CryptoKey,
  manifest: EncryptedManifest,
  path: string,
  record: EncryptedManifest["files"][string] | undefined,
  localState: EncryptedLocalFileState | undefined,
  localFile: TFile | null,
  localBytes?: Uint8Array,
): Promise<boolean> {
  if (!record || record.deleted) return false;
  if (localState?.plaintextSha256 === record.plaintextSha256) return false;
  if (!localState && (localFile || localBytes)) {
    const bytes = localBytes ?? await readVaultFileBytes(plugin.app.vault, localFile as TFile);
    if (await sha256Hex(bytes) === record.plaintextSha256) return false;
  }
  const remoteBytes = await downloadManifestRecordBytes(plugin, key, manifest, record);
  const resolution = await chooseConflictResolution(plugin, configuredConflictPolicy(plugin), path, localFile, record.mtime);
  if (resolution === "keep-local") return false;
  if (resolution === "use-remote") {
    await writeIgnoredVaultBytes(plugin, path, remoteBytes);
    return true;
  }
  if (resolution === "merged" && localFile) {
    const localText = localBytes ? new TextDecoder().decode(localBytes) : await plugin.app.vault.read(localFile);
    const remoteText = new TextDecoder().decode(remoteBytes);
    await writeIgnoredVaultBytes(plugin, path, new TextEncoder().encode(mergeTextContent(localText, remoteText)));
    return true;
  }
  await writeIgnoredVaultBytes(plugin, conflictPathFor(path, Date.now(), "remote"), remoteBytes);
  return true;
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

async function confirmForeignRemoteBeforeForcePush(plugin: FastSync, operation: EncryptedSyncOperation): Promise<boolean> {
  if (operation !== "forcePush") return true;
  const state = await classifyRemoteRepo(plugin.githubClient);
  if (state.kind !== "foreign-nonempty") return true;
  return promptForeignRemoteForcePush(plugin);
}

async function encryptedSyncImpl(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  if (plugin.isSyncInProgress || !plugin.githubClient) return;
  if (blockIfEncryptedForcePushRequired(plugin, options.operation)) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    if (!await confirmForeignRemoteBeforeForcePush(plugin, options.operation)) {
      new Notice("Force push cancelled");
      return;
    }
    const ignoreRules = configuredIgnoreRules(plugin);
    const { store, key, manifest, manifestSha } = await loadStore(plugin, options.operation === "forcePush");

    let manifestChanged = false;
    let packsToDeleteAfterSave: EncryptedPackManifestRecord[] = [];
    if (options.operation === "forcePull") {
      if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, true);
      await pullEncryptedChanges(plugin, key, manifest, true);
      await deleteLocalFilesMissingFromRemote(plugin, manifest, ignoreRules);
    } else if (options.operation === "forcePush") {
      const forcePushResult = await pushEncryptedForceLocalChanges(plugin, key, manifest, ignoreRules);
      manifestChanged = forcePushResult.changed;
      packsToDeleteAfterSave = forcePushResult.packsToDeleteAfterSave;
    } else {
      if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, false);
      await pullEncryptedChanges(plugin, key, manifest, false);
      const pushResult = await pushEncryptedAutoLocalChanges(plugin, key, manifest, ignoreRules);
      manifestChanged = pushResult.changed;
      packsToDeleteAfterSave = pushResult.packsToDeleteAfterSave;
    }

    const newManifestSha = manifestChanged || !manifestSha ? await store.save(manifest, key, manifestSha) : manifestSha;
    if (packsToDeleteAfterSave.length > 0) await deleteObsoleteRemotePacks(plugin, packsToDeleteAfterSave, manifest);
    plugin.syncData.encrypted = { files: {}, manifestSha: newManifestSha };
    for (const [path, record] of Object.entries(manifest.files)) {
      if (!record.deleted) {
        const stat = localStatForRecord(plugin, path, record);
        plugin.syncData.encrypted.files[path] = {
          plaintextSha256: record.plaintextSha256,
          objectPath: record.objectPath,
          remoteSha: record.remoteSha,
          storage: record.storage,
          chunks: record.chunks,
          packId: record.packId,
          manifestUpdatedAt: manifest.updatedAt,
          size: stat.size,
          mtime: stat.mtime,
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

export async function encryptedSync(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  return enqueue(plugin, () => encryptedSyncImpl(plugin, options));
}

async function encryptedModifyImpl(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
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
    if (!eventEnter && existing && !existing.deleted && cached?.plaintextSha256 === existing.plaintextSha256 && cached.size === file.stat.size && cached.mtime === file.stat.mtime) return;

    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    if (await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, existing, cached, file, plaintext)) return;
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

export async function encryptedModify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedModifyImpl(file, plugin, eventEnter));
}

async function encryptedDeleteImpl(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", file.path)) return;
  try {
    const { store, key, manifest, manifestSha } = await loadStore(plugin);
    const path = normalizeVaultPath(file.path);
    const record = manifest.files[path];
    const state = ensureEncryptedState(plugin);
    if (await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, record, state.files[path], null)) return;
    if (record) {
      record.deleted = true;
      record.deletedAt = Date.now();
      await store.save(manifest, key, manifestSha);
      delete state.files[path];
      await plugin.saveSyncData();
    }
  } catch (error) {
    reportSyncError("localChange", error, file.path);
  }
}

export async function encryptedDelete(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedDeleteImpl(file, plugin, eventEnter));
}

async function encryptedRenameImpl(file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", file.path)) return;
  if (!shouldSyncEncryptedFile(file, configuredIgnoreRules(plugin)) || !plugin.githubClient) return;
  try {
    const { store, key, manifest, manifestSha } = await loadStore(plugin);
    const oldPath = normalizeVaultPath(oldfile);
    const newPath = normalizeVaultPath(file.path);
    if (oldPath === newPath) {
      await encryptedModifyImpl(file, plugin, eventEnter);
      return;
    }

    const oldRecord = manifest.files[oldPath];
    const state = ensureEncryptedState(plugin);
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    const oldRemoteChanged = await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, oldPath, oldRecord, state.files[oldPath], null);
    const shouldKeepOldRemote = oldRemoteChanged;
    let newRecord;
    if (oldRecord && !oldRecord.deleted && oldRecord.storage !== "pack" && oldRecord.plaintextSha256 === plaintextSha256) {
      if (!shouldKeepOldRemote) {
        oldRecord.deleted = true;
        oldRecord.deletedAt = Date.now();
      }
      newRecord = { ...oldRecord, path: newPath, plaintextSha256, size: file.stat.size, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    } else {
      if (oldRecord && !shouldKeepOldRemote) {
        oldRecord.deleted = true;
        oldRecord.deletedAt = Date.now();
      }
      const reusableExisting = shouldKeepOldRemote || oldRecord?.storage === "pack" ? undefined : oldRecord;
      const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
      const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
      newRecord = { ...uploaded, path: newPath, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    }
    manifest.files[newPath] = newRecord;
    const newManifestSha = await store.save(manifest, key, manifestSha);
    state.manifestSha = newManifestSha;
    delete state.files[oldPath];
    state.files[newPath] = { plaintextSha256, objectPath: newRecord.objectPath, remoteSha: newRecord.remoteSha, storage: newRecord.storage, chunks: newRecord.chunks, packId: newRecord.packId, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
    await plugin.saveSyncData();
  } catch (error) {
    reportSyncError("localChange", error, file.path);
  }
}

export async function encryptedRename(file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedRenameImpl(file, oldfile, plugin, eventEnter));
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const [path, record] of Object.entries(manifest.files)) {
    if (record.deleted || record.storage === "pack") continue;
    const localState = state.files[path];
    if (!force && localState?.plaintextSha256 === record.plaintextSha256) continue;
    const plaintext = await downloadEncryptedFileObject(plugin.githubClient, key, record);
    const localFile = plugin.app.vault.getAbstractFileByPath(path);
    if (!force && localFile instanceof TFile) {
      const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
      const localChanged = localState ? localState.plaintextSha256 !== localHash : localHash !== record.plaintextSha256;
      if (localChanged) {
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

async function pushEncryptedForceLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>): Promise<{ changed: boolean; packsToDeleteAfterSave: EncryptedPackManifestRecord[] }> {
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
  const totalBytes = localFiles.reduce((sum, file) => sum + file.stat.size, 0);
  const mode = chooseEncryptedStorageMode({ fileCount: localFiles.length, totalBytes });
  const previousPacks = Object.values(manifest.packs ?? {});
  if (mode === "pack") return { changed: await pushEncryptedPackLocalChanges(plugin, key, manifest, localFiles), packsToDeleteAfterSave: previousPacks };
  manifest.files = {};
  manifest.packs = {};
  return { changed: await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, true), packsToDeleteAfterSave: previousPacks };
}

async function pushEncryptedAutoLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>): Promise<{ changed: boolean; packsToDeleteAfterSave: EncryptedPackManifestRecord[] }> {
  const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
  const totalBytes = localFiles.reduce((sum, file) => sum + file.stat.size, 0);
  const previousPacks = Object.values(manifest.packs ?? {});
  if (chooseEncryptedStorageMode({ fileCount: localFiles.length, totalBytes }) === "pack") {
    if (canSkipPackUpload(plugin, manifest, localFiles)) return { changed: false, packsToDeleteAfterSave: [] };
    return { changed: await pushEncryptedPackLocalChanges(plugin, key, manifest, localFiles), packsToDeleteAfterSave: previousPacks };
  }
  return { changed: await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, false), packsToDeleteAfterSave: [] };
}

async function deleteObsoleteRemotePacks(plugin: FastSync, previousPacks: EncryptedPackManifestRecord[], manifest: EncryptedManifest): Promise<void> {
  const currentPackPaths = new Set(Object.values(manifest.packs ?? {}).map(pack => pack.objectPath));
  for (const pack of previousPacks) {
    if (pack.remoteSha && !currentPackPaths.has(pack.objectPath)) await plugin.githubClient.deleteFile(pack.objectPath, pack.remoteSha);
  }
}

async function pushEncryptedPackLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, localFiles: TFile[]): Promise<boolean> {
  const previousFiles = manifest.files;
  const previousPacks = manifest.packs ?? {};
  const state = ensureEncryptedState(plugin);
  const packFiles = localFiles.filter(file => file.stat.size <= ENCRYPTED_PACK_PLAINTEXT_BYTES);
  const objectFiles = localFiles.filter(file => file.stat.size > ENCRYPTED_PACK_PLAINTEXT_BYTES);
  const plan = planEncryptedPacks(packFiles.map(file => ({ path: normalizeVaultPath(file.path), size: file.stat.size, mtime: file.stat.mtime })));
  const filesByPath = new Map(localFiles.map(file => [normalizeVaultPath(file.path), file] as const));
  manifest.files = {};
  manifest.packs = {};

  for (const pack of plan.packs) {
    const reusablePack = previousPacks[pack.id];
    const canReusePack = !!reusablePack && pack.files.every(entry => {
      const previous = previousFiles[entry.path];
      const cached = state.files[entry.path];
      return previous && cached && !previous.deleted && previous.storage === "pack" && previous.packId === pack.id && previous.size === entry.size && previous.mtime === entry.mtime && cached.plaintextSha256 === previous.plaintextSha256 && cached.size === entry.size && cached.mtime === entry.mtime;
    });
    if (canReusePack) {
      manifest.packs[pack.id] = reusablePack;
      for (const entry of pack.files) manifest.files[entry.path] = { ...previousFiles[entry.path], deleted: false, deletedAt: undefined };
      continue;
    }

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
    manifest.packs[pack.id] = await uploadEncryptedPack(plugin.githubClient, key, pack.id, archiveFiles, previousPacks[pack.id]);
  }

  for (const file of objectFiles) {
    const path = normalizeVaultPath(file.path);
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    const existing = previousFiles[path];
    const reusableExisting = existing?.storage === "pack" ? undefined : existing;
    const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
  }
  return true;
}

function packRecordsFor(manifest: EncryptedManifest, packId: string): Array<[string, EncryptedManifest["files"][string]]> {
  return Object.entries(manifest.files).filter(([, record]) => !record.deleted && record.storage === "pack" && record.packId === packId);
}

function canSkipPackDownload(plugin: FastSync, manifest: EncryptedManifest, packId: string, force: boolean): boolean {
  if (force) return false;
  const records = packRecordsFor(manifest, packId);
  if (records.length === 0) return false;
  const state = ensureEncryptedState(plugin);
  return records.every(([path, record]) => state.files[path]?.plaintextSha256 === record.plaintextSha256);
}

function canSkipPackUpload(plugin: FastSync, manifest: EncryptedManifest, localFiles: TFile[]): boolean {
  if (!manifest.packs || Object.keys(manifest.packs).length === 0) return false;
  const activeRecords = Object.entries(manifest.files).filter(([, record]) => !record.deleted);
  if (activeRecords.length !== localFiles.length) return false;
  const recordsByPath = new Map(activeRecords.map(([path, record]) => [path, record] as const));
  const state = ensureEncryptedState(plugin);
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const record = recordsByPath.get(path);
    const cached = state.files[path];
    if (!record || record.storage !== "pack" || !cached) return false;
    if (cached.plaintextSha256 !== record.plaintextSha256) return false;
    if (cached.size !== file.stat.size || cached.mtime !== file.stat.mtime) return false;
  }
  return true;
}
async function pullEncryptedPackChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  for (const pack of Object.values(manifest.packs ?? {})) {
    if (canSkipPackDownload(plugin, manifest, pack.id, force)) continue;
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
      if (!force && localFile instanceof TFile) {
        const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
        const localChanged = localState ? localState.plaintextSha256 !== localHash : localHash !== record.plaintextSha256;
        if (localChanged) {
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
      cacheEncryptedStateForRecord(plugin, file.path, record);
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
      if (!force && await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, record, state.files[path], null)) continue;
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
    if (!force && await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, existing, cached, file, plaintext)) continue;
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
