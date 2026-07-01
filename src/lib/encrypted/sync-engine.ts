import { Modal, Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_OBJECTS_ROOT, ENCRYPTED_PACK_PLAINTEXT_BYTES, ENCRYPTED_PACKS_ROOT, ENCRYPTED_ROOT, OBJECT_ID_BYTES } from "./constants";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { compileIgnorePathRegex } from "./ignore";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { planEncryptedPacks } from "./pack-planner";
import { downloadEncryptedPack, uploadEncryptedPack } from "./pack-sync";
import { chooseEncryptedStorageMode } from "./scale-policy";
import { EncryptedManifestStore } from "./manifest-store";
import { EncryptedSnapshotStore, SnapshotHeadCasError, V2_HEAD_PATH, V2_ROOT, V2_SNAPSHOTS_ROOT } from "./snapshot-store";
import { classifyRemoteRepo } from "./remote-state";
import { conflictPathFor, normalizeVaultPath } from "./paths";
import { reportSyncError } from "./sync-errors";
import { ConflictPolicy, EncryptedLocalFileState, EncryptedManifest, EncryptedObjectRecord, EncryptedPackManifestRecord, EncryptedSyncOperation } from "./types";
import type { EncryptedSnapshotFileRecord, EncryptedSnapshotManifest, EncryptedSnapshotPackRecord } from "./snapshot-types";
import { effectiveConflictPolicy } from "./settings-policy";
import { deleteVaultFileIfExists, listEncryptedSyncCandidates, readVaultFileBytes, readVaultFileText, shouldSyncEncryptedFile, writeVaultFileBytes } from "./vault";
import { randomBytes, sha256Hex, toBase64Url } from "./bytes";
import { syncConsoleLog } from "../debug";

const syncQueues = new WeakMap<FastSync, Promise<any>>();
const ENCRYPTED_LOOSE_DELTA_MAX_FILES = 32;
const ENCRYPTED_LOOSE_DELTA_MAX_BYTES = 64 * 1024 * 1024;
const ENCRYPTED_LOOSE_DELTA_COMPACT_AFTER_FILES = 256;

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

function isCasRetryableOperation(operation: EncryptedSyncOperation): boolean {
  return operation === "normal" || operation === "manual" || operation === "localChange";
}

function markEncryptedSyncFailure(plugin: FastSync, operation: EncryptedSyncOperation, error: unknown): void {
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "fail",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime,
      errorMessage: (error as Error).message
    };
  }
  syncConsoleLog(plugin.settings, "warn", "encrypted sync failed", { operation, error });
  reportSyncError(operation, error);
}

function ensureEncryptedState(plugin: FastSync): { files: { [path: string]: EncryptedLocalFileState }; manifestSha?: string } {
  if (!plugin.syncData.encrypted) plugin.syncData.encrypted = { files: {} };
  return plugin.syncData.encrypted;
}


async function getRemoteHeadShaIfAvailable(plugin: FastSync): Promise<string | null> {
  const getter = (plugin.githubClient as { getRemoteHeadSha?: () => Promise<string | null> }).getRemoteHeadSha;
  if (typeof getter !== "function") return null;
  try {
    return await getter.call(plugin.githubClient);
  } catch (error) {
    syncConsoleLog(plugin.settings, "warn", "remote HEAD lookup failed; falling back to full encrypted sync", { error });
    return null;
  }
}

function encryptedLocalStateMatchesCache(plugin: FastSync, localFiles: TFile[]): boolean {
  const state = ensureEncryptedState(plugin);
  const cachedPaths = new Set(Object.keys(state.files));
  if (cachedPaths.size !== localFiles.length) return false;
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const cached = state.files[path];
    if (!cached || cached.size !== file.stat.size || cached.mtime !== file.stat.mtime) return false;
    cachedPaths.delete(path);
  }
  return cachedPaths.size === 0;
}

function localFilesByPath(localFiles: TFile[]): Map<string, TFile> {
  return new Map(localFiles.map(file => [normalizeVaultPath(file.path), file] as const));
}

function detectLocallyDirtyPackedPaths(plugin: FastSync, manifest: EncryptedManifest, localFiles: TFile[]): Set<string> {
  const state = ensureEncryptedState(plugin);
  const dirtyPaths = new Set<string>();
  const activePaths = new Set(Object.entries(manifest.files).filter(([, record]) => !record.deleted).map(([path]) => path));
  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    activePaths.delete(path);
    const record = manifest.files[path];
    const cached = state.files[path];
    if (!record || record.deleted || !cached) {
      dirtyPaths.add(path);
      continue;
    }
    if (cached.plaintextSha256 !== record.plaintextSha256) continue;
    if (cached.size !== file.stat.size || cached.mtime !== file.stat.mtime) dirtyPaths.add(path);
  }
  for (const path of activePaths) {
    const record = manifest.files[path];
    const cached = state.files[path];
    if (record && !record.deleted && cached?.plaintextSha256 === record.plaintextSha256) dirtyPaths.add(path);
  }
  return dirtyPaths;
}

function encryptedLocalFilesStorageMode(localFiles: TFile[]): ReturnType<typeof chooseEncryptedStorageMode> {
  const totalBytes = localFiles.reduce((sum, file) => sum + file.stat.size, 0);
  return chooseEncryptedStorageMode({ fileCount: localFiles.length, totalBytes });
}

function encryptedStateNeedsPackMigration(plugin: FastSync, localFiles: TFile[]): boolean {
  if (encryptedLocalFilesStorageMode(localFiles) !== "pack") return false;
  const state = ensureEncryptedState(plugin);
  return localFiles.some(file => state.files[normalizeVaultPath(file.path)]?.storage !== "pack");
}
function encryptedCachedStateSuggestsPackSync(plugin: FastSync): boolean {
  const cached = Object.values(ensureEncryptedState(plugin).files);
  if (cached.some(file => file.storage === "pack")) return true;
  const totalBytes = cached.reduce((sum, file) => sum + (file.size ?? 0), 0);
  return chooseEncryptedStorageMode({ fileCount: cached.length, totalBytes }) === "pack";
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

async function loadKey(plugin: FastSync, allowForeignInit: boolean = false) {
  const store = new EncryptedManifestStore(plugin.githubClient, requireEncryptedPassphrase(plugin), allowForeignInit);
  return store.loadOrCreateKey();
}

function snapshotStorageForRecord(record: EncryptedObjectRecord): EncryptedSnapshotFileRecord["storage"] {
  if (record.storage === "pack") return "pack";
  if (record.storage === "chunked") return "chunked";
  return "object";
}

function snapshotRecordFromManifestRecord(record: EncryptedObjectRecord): EncryptedSnapshotFileRecord {
  return {
    path: record.path,
    objectId: record.id,
    storage: snapshotStorageForRecord(record),
    objectPath: record.objectPath,
    remoteSha: record.remoteSha,
    plaintextSha256: record.plaintextSha256,
    size: record.size,
    mtime: record.mtime,
    packId: record.packId,
    chunkIds: record.chunks?.map(chunk => `${record.id}:${chunk.index}`),
    chunks: record.chunks,
    deleted: record.deleted,
    deletedAt: record.deletedAt,
  };
}

function manifestPackToSnapshotPack(pack: EncryptedPackManifestRecord): EncryptedSnapshotPackRecord {
  return { ...pack };
}

function snapshotPackToManifestPack(pack: EncryptedSnapshotPackRecord): EncryptedPackManifestRecord {
  return { ...pack };
}

function snapshotRecordToManifestRecord(record: EncryptedSnapshotFileRecord): EncryptedObjectRecord {
  return {
    id: record.objectId,
    path: record.path,
    objectPath: record.objectPath ?? "",
    plaintextSha256: record.plaintextSha256,
    remoteSha: record.remoteSha,
    storage: record.storage === "object" ? "single" : record.storage,
    chunks: record.chunks,
    packId: record.packId,
    size: record.size,
    mtime: record.mtime,
    deleted: record.deleted,
    deletedAt: record.deletedAt,
  };
}

function manifestToSnapshot(manifest: EncryptedManifest, previousHead: { head: { snapshotId: string; generation: number } } | null): EncryptedSnapshotManifest {
  const now = Date.now();
  const packs = manifest.packs ? Object.fromEntries(Object.entries(manifest.packs).map(([id, pack]) => [id, manifestPackToSnapshotPack(pack)])) : undefined;
  return {
    formatVersion: 2,
    snapshotId: toBase64Url(randomBytes(18)),
    parentSnapshotIds: previousHead ? [previousHead.head.snapshotId] : [],
    generation: (previousHead?.head.generation ?? 0) + 1,
    createdAt: now,
    files: Object.fromEntries(Object.entries(manifest.files).map(([path, record]) => [path, snapshotRecordFromManifestRecord(record)])),
    packs,
  };
}

function snapshotToManifest(snapshot: EncryptedSnapshotManifest): EncryptedManifest {
  const packs = snapshot.packs ? Object.fromEntries(Object.entries(snapshot.packs).map(([id, pack]) => [id, snapshotPackToManifestPack(pack)])) : undefined;
  return {
    formatVersion: 1,
    indexMode: "single",
    updatedAt: snapshot.createdAt,
    files: Object.fromEntries(Object.entries(snapshot.files).map(([path, record]) => [path, snapshotRecordToManifestRecord(record)])),
    packs,
  };
}

async function saveEncryptedSnapshotFromManifest(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, options: { requireHeadCas?: boolean } = {}): Promise<string | undefined> {
  const snapshotStore = new EncryptedSnapshotStore(plugin.githubClient, key);
  const previousHead = await snapshotStore.loadHead();
  const snapshot = manifestToSnapshot(manifest, previousHead);
  const head = { formatVersion: 2 as const, snapshotId: snapshot.snapshotId, generation: snapshot.generation, updatedAt: Date.now() };
  const expectedHeadSha = options.requireHeadCas === false ? undefined : previousHead?.sha;
  const written = await snapshotStore.writeSnapshotAndHeadAtomic(snapshot, head, expectedHeadSha);
  return written.headSha;
}

function emptyEncryptedManifest(): EncryptedManifest {
  return { formatVersion: 1, indexMode: "single", updatedAt: Date.now(), files: {}, packs: {} };
}

async function loadEncryptedSnapshotManifest(plugin: FastSync, key: CryptoKey, options: { tolerateMissingSnapshot?: boolean } = {}): Promise<EncryptedManifest | null> {
  const snapshotStore = new EncryptedSnapshotStore(plugin.githubClient, key);
  const head = await snapshotStore.loadHead();
  if (!head) return null;
  const snapshot = await snapshotStore.loadSnapshot(head.head.snapshotId);
  if (!snapshot) {
    if (options.tolerateMissingSnapshot) return null;
    throw new Error("Encrypted snapshot head points to a missing snapshot.");
  }
  return snapshotToManifest(snapshot);
}

async function pullEncryptedSnapshotIfAvailable(plugin: FastSync, key: CryptoKey, ignoreRules: ReturnType<typeof compileIgnorePathRegex>): Promise<EncryptedManifest | null> {
  const snapshotStore = new EncryptedSnapshotStore(plugin.githubClient, key);
  const head = await snapshotStore.loadHead();
  if (!head) return null;
  const snapshot = await snapshotStore.loadSnapshot(head.head.snapshotId);
  if (!snapshot) throw new Error("Encrypted snapshot head points to a missing snapshot.");
  const manifest = snapshotToManifest(snapshot);
  if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, true);
  await pullEncryptedChanges(plugin, key, manifest, true);
  await deleteLocalFilesMissingFromRemote(plugin, manifest, ignoreRules);
  return manifest;
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

  if (!record || record.deleted) {
    return false;
  }
  if (localState?.plaintextSha256 === record.plaintextSha256) {
    return false;
  }
  if (localFile || localBytes) {
    const bytes = localBytes ?? await readVaultFileBytes(plugin.app.vault, localFile as TFile);
    const localHash = await sha256Hex(bytes);
    if (localHash === record.plaintextSha256) {
      return false;
    }
  }
  const remoteBytes = await downloadManifestRecordBytes(plugin, key, manifest, record);
  const resolution = await chooseConflictResolution(plugin, configuredConflictPolicy(plugin), path, localFile, record.mtime);
  if (resolution === "keep-local") return false;
  if (resolution === "use-remote") {
    await writeIgnoredVaultBytes(plugin, path, remoteBytes);
    return true;
  }
  if (resolution === "merged" && localFile) {
    const localText = localBytes ? new TextDecoder().decode(localBytes) : await readVaultFileText(plugin.app.vault, localFile);
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
  if (plugin.isSyncInProgress) {
    new Notice("Sync is already in progress. Please wait.");
    return;
  }
  if (!plugin.githubClient) return;
  if (blockIfEncryptedForcePushRequired(plugin, options.operation)) return;

  for (const timer of plugin.debounceTimers.values()) {
    globalThis.clearTimeout(timer);
  }
  plugin.debounceTimers.clear();

  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "syncing",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
  }
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  try {
    const ignoreRules = configuredIgnoreRules(plugin);
    let remoteHeadBeforeSync: string | null = null;
    let locallyDirtyPaths = new Set<string>();
    let preflightLocalFiles: TFile[] | null = null;
    if (options.operation === "normal" || options.operation === "manual") {
      const localFiles = listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
      preflightLocalFiles = localFiles;
      remoteHeadBeforeSync = await getRemoteHeadShaIfAvailable(plugin);
      syncConsoleLog(plugin.settings, "debug", "encrypted sync preflight", {
        operation: options.operation,
        localFileCount: localFiles.length,
        remoteHeadBeforeSync,
        cachedRemoteHead: plugin.syncData.lastRemoteHeadSha,
      });
      if (remoteHeadBeforeSync && plugin.syncData.lastRemoteHeadSha === remoteHeadBeforeSync && encryptedLocalStateMatchesCache(plugin, localFiles) && !encryptedStateNeedsPackMigration(plugin, localFiles)) {
        if (plugin.syncProgress) {
          plugin.syncProgress = {
            status: "success",
            pushCount: 0,
            totalPush: 0,
            pullCount: 0,
            totalPull: 0,
            lastSyncTime: plugin.syncProgress.lastSyncTime ?? Date.now()
          };
        }
        if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
        syncConsoleLog(plugin.settings, "info", "encrypted sync skipped: no local or remote changes", {
          operation: options.operation,
          localFileCount: localFiles.length,
          remoteHeadBeforeSync,
        });
        new Notice("Encrypted sync skipped: no local or remote changes");
        return;
      }
    }

    if (!await confirmForeignRemoteBeforeForcePush(plugin, options.operation)) {
      new Notice("Force push cancelled");
      return;
    }
    const { key } = await loadKey(plugin, options.operation === "forcePush");

    let manifest = await loadEncryptedSnapshotManifest(plugin, key, { tolerateMissingSnapshot: options.operation === "forcePush" }) ?? emptyEncryptedManifest();
    if (options.operation !== "forcePull" && options.operation !== "forcePush") {
      const localFiles = preflightLocalFiles ?? listEncryptedSyncCandidates(plugin.app.vault, ignoreRules);
      locallyDirtyPaths = detectLocallyDirtyPackedPaths(plugin, manifest, localFiles);
      syncConsoleLog(plugin.settings, "debug", "encrypted sync local dirty paths detected", {
        operation: options.operation,
        dirtyPathCount: locallyDirtyPaths.size,
      });
    }
    let manifestChanged = false;
    let packsToDeleteAfterSave: EncryptedPackManifestRecord[] = [];
    let objectsToDeleteAfterSave: Array<EncryptedManifest["files"][string]> = [];
    if (options.operation === "forcePull") {
      const pulledManifest = await pullEncryptedSnapshotIfAvailable(plugin, key, ignoreRules);
      if (!pulledManifest) throw new Error("No encrypted v2 snapshot found on remote. Run Force push to initialize encrypted sync.");
      manifest = pulledManifest;
    } else if (options.operation === "forcePush") {
      const previousPacks = Object.values(manifest.packs ?? {});
      objectsToDeleteAfterSave = Object.values(manifest.files ?? {});
      manifest = emptyEncryptedManifest();
      const forcePushResult = await pushEncryptedForceLocalChanges(plugin, key, manifest, ignoreRules);
      manifestChanged = forcePushResult.changed;
      packsToDeleteAfterSave = previousPacks.length > 0 ? previousPacks : forcePushResult.packsToDeleteAfterSave;
      await saveEncryptedSnapshotFromManifest(plugin, key, manifest, { requireHeadCas: false });
    } else {
      if (manifest.packs && Object.keys(manifest.packs).length > 0) await pullEncryptedPackChanges(plugin, key, manifest, ignoreRules, false, locallyDirtyPaths);
      await pullEncryptedChanges(plugin, key, manifest, false);
      const pushResult = await pushEncryptedAutoLocalChanges(plugin, key, manifest, ignoreRules);
      manifestChanged = pushResult.changed;
      packsToDeleteAfterSave = pushResult.packsToDeleteAfterSave;
      syncConsoleLog(plugin.settings, "debug", "encrypted sync local changes evaluated", {
        operation: options.operation,
        manifestChanged,
        fileCount: Object.keys(manifest.files).length,
        packCount: Object.keys(manifest.packs ?? {}).length,
      });
      if (manifestChanged || !(await loadEncryptedSnapshotManifest(plugin, key))) await saveEncryptedSnapshotFromManifest(plugin, key, manifest);
    }

    if (packsToDeleteAfterSave.length > 0) await deleteObsoleteRemotePacks(plugin, packsToDeleteAfterSave, manifest);
    if (objectsToDeleteAfterSave.length > 0) await deleteObsoleteRemoteObjects(plugin, objectsToDeleteAfterSave, manifest);
    const encryptedHead = await new EncryptedSnapshotStore(plugin.githubClient, key).loadHead();
    if (options.operation === "forcePush" && encryptedHead) await pruneEncryptedRemoteAfterForcePush(plugin, manifest, encryptedHead.head.snapshotId);
    plugin.syncData.encrypted = { files: {}, manifestSha: encryptedHead?.sha };
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
    plugin.syncData.lastRemoteHeadSha = options.operation === "forcePush" || manifestChanged
      ? (await getRemoteHeadShaIfAvailable(plugin) ?? plugin.syncData.lastRemoteHeadSha)
      : (remoteHeadBeforeSync ?? plugin.syncData.lastRemoteHeadSha);
    await plugin.saveSyncData();
    syncConsoleLog(plugin.settings, "info", "encrypted sync completed", {
      operation: options.operation,
      manifestChanged,
      fileCount: Object.keys(manifest.files).length,
      packCount: Object.keys(manifest.packs ?? {}).length,
      lastRemoteHeadSha: plugin.syncData.lastRemoteHeadSha,
      pushCount: plugin.syncProgress?.pushCount,
      totalPush: plugin.syncProgress?.totalPush,
      pullCount: plugin.syncProgress?.pullCount,
      totalPull: plugin.syncProgress?.totalPull,
    });
    new Notice(`Encrypted ${options.operation} completed`);
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: plugin.syncProgress.pushCount,
        totalPush: plugin.syncProgress.totalPush,
        pullCount: plugin.syncProgress.pullCount,
        totalPull: plugin.syncProgress.totalPull,
        lastSyncTime: Date.now()
      };
    }
  } catch (error) {
    if (error instanceof SnapshotHeadCasError && isCasRetryableOperation(options.operation)) {
      syncConsoleLog(plugin.settings, "warn", "encrypted sync snapshot head changed; will retry with fresh remote state", {
        operation: options.operation,
        error,
      });
      throw error;
    }
    markEncryptedSyncFailure(plugin, options.operation, error);
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

async function runEncryptedSyncWithCasRetry(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  const maxAttempts = isCasRetryableOperation(options.operation) ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      syncConsoleLog(plugin.settings, "info", "encrypted sync attempt started", { operation: options.operation, attempt, maxAttempts });
      await encryptedSyncImpl(plugin, options);
      if (plugin.syncProgress?.status !== "fail") syncConsoleLog(plugin.settings, "info", "encrypted sync attempt completed", { operation: options.operation, attempt });
      return;
    } catch (error) {
      if (error instanceof SnapshotHeadCasError && attempt < maxAttempts) {
        syncConsoleLog(plugin.settings, "warn", "encrypted sync CAS conflict; retrying full attempt", {
          operation: options.operation,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          error,
        });
        continue;
      }
      markEncryptedSyncFailure(plugin, options.operation, error);
      return;
    }
  }
}

export async function encryptedSync(plugin: FastSync, options: EncryptedSyncOptions): Promise<void> {
  return enqueue(plugin, () => runEncryptedSyncWithCasRetry(plugin, options));
}

async function encryptedModifyImpl(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  const ignoreRules = configuredIgnoreRules(plugin);
  if (!shouldSyncEncryptedFile(file, ignoreRules) || !plugin.githubClient) return;
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", file.path)) return;
  if (plugin.isSyncInProgress) return;
  if (encryptedCachedStateSuggestsPackSync(plugin)) {
    await runEncryptedSyncWithCasRetry(plugin, { operation: "localChange" });
    return;
  }
  plugin.isSyncInProgress = true;
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "syncing",
      pushCount: 0,
      totalPush: 1,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
  try {
    const { key } = await loadKey(plugin);
    const manifest = await loadEncryptedSnapshotManifest(plugin, key) ?? emptyEncryptedManifest();
    const path = normalizeVaultPath(file.path);
    const state = ensureEncryptedState(plugin);
    const existing = manifest.files[path];
    const cached = state.files[path];
    if (!eventEnter && existing && !existing.deleted && cached?.plaintextSha256 === existing.plaintextSha256 && cached.size === file.stat.size && cached.mtime === file.stat.mtime) {
      if (plugin.syncProgress) {
        plugin.syncProgress.status = "success";
      }
      return;
    }

    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    if (await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, existing, cached, file, plaintext)) {
      if (plugin.syncProgress) {
        plugin.syncProgress = {
          status: "success",
          pushCount: 1,
          totalPush: 1,
          pullCount: 0,
          totalPull: 0,
          lastSyncTime: Date.now()
        };
      }
      return;
    }
    if (existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) {
      state.files[path] = { ...cached, plaintextSha256, objectPath: existing.objectPath, remoteSha: existing.remoteSha, storage: existing.storage, chunks: existing.chunks, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
      await plugin.saveSyncData();
      if (plugin.syncProgress) {
        plugin.syncProgress = {
          status: "success",
          pushCount: 1,
          totalPush: 1,
          pullCount: 0,
          totalPull: 0,
          lastSyncTime: Date.now()
        };
      }
      return;
    }

    const reusableExisting = existing?.storage === "pack" ? undefined : existing;
    const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
    const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    state.manifestSha = await saveEncryptedSnapshotFromManifest(plugin, key, manifest);
    state.files[path] = { plaintextSha256, objectPath: manifest.files[path].objectPath, remoteSha: manifest.files[path].remoteSha, storage: manifest.files[path].storage, chunks: manifest.files[path].chunks, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
    await plugin.saveSyncData();

    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: 1,
        totalPush: 1,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: Date.now()
      };
    }
  } catch (error) {
    reportSyncError("localChange", error, file.path);
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "fail",
        pushCount: 0,
        totalPush: 0,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: plugin.syncProgress.lastSyncTime,
        errorMessage: (error as Error).message
      };
    }
  } finally {
    plugin.isSyncInProgress = false;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

export async function encryptedModify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedModifyImpl(file, plugin, eventEnter));
}

async function encryptedDeleteImpl(fileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  const filePath = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", filePath)) return;
  if (plugin.isSyncInProgress) return;
  plugin.isSyncInProgress = true;
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "syncing",
      pushCount: 0,
      totalPush: 1,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
  try {
    const { key } = await loadKey(plugin);
    const manifest = await loadEncryptedSnapshotManifest(plugin, key) ?? emptyEncryptedManifest();
    const path = normalizeVaultPath(filePath);
    const record = manifest.files[path];
    const state = ensureEncryptedState(plugin);
    if (await resolveRemoteChangedBeforeLocalMutation(plugin, key, manifest, path, record, state.files[path], null)) {
      if (plugin.syncProgress) {
        plugin.syncProgress = {
          status: "success",
          pushCount: 1,
          totalPush: 1,
          pullCount: 0,
          totalPull: 0,
          lastSyncTime: Date.now()
        };
      }
      return;
    }
    if (record) {
      record.deleted = true;
      record.deletedAt = Date.now();
      state.manifestSha = await saveEncryptedSnapshotFromManifest(plugin, key, manifest);
      delete state.files[path];
      await plugin.saveSyncData();
    }
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: 1,
        totalPush: 1,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: Date.now()
      };
    }
  } catch (error) {
    reportSyncError("localChange", error, filePath);
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "fail",
        pushCount: 0,
        totalPush: 0,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: plugin.syncProgress.lastSyncTime,
        errorMessage: (error as Error).message
      };
    }
  } finally {
    plugin.isSyncInProgress = false;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

export async function encryptedDelete(fileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedDeleteImpl(fileOrPath, plugin, eventEnter));
}

async function encryptedRenameImpl(newFileOrPath: string | TAbstractFile, oldFileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  const oldfile = typeof oldFileOrPath === "string" ? oldFileOrPath : oldFileOrPath.path;
  const newfile = typeof newFileOrPath === "string" ? newFileOrPath : newFileOrPath.path;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (blockIfEncryptedForcePushRequired(plugin, "localChange", newfile)) return;
  if (!plugin.githubClient) return;

  const file = plugin.app.vault.getAbstractFileByPath(newfile);
  if (!(file instanceof TFile)) return;
  if (!shouldSyncEncryptedFile(file, configuredIgnoreRules(plugin))) return;

  if (plugin.isSyncInProgress) return;
  plugin.isSyncInProgress = true;
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "syncing",
      pushCount: 0,
      totalPush: 2,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
  try {
    const { key } = await loadKey(plugin);
    const manifest = await loadEncryptedSnapshotManifest(plugin, key) ?? emptyEncryptedManifest();
    const oldPath = normalizeVaultPath(oldfile);
    const newPath = normalizeVaultPath(newfile);
    if (oldPath === newPath) {
      plugin.isSyncInProgress = false;
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
    state.manifestSha = await saveEncryptedSnapshotFromManifest(plugin, key, manifest);
    delete state.files[oldPath];
    state.files[newPath] = { plaintextSha256, objectPath: newRecord.objectPath, remoteSha: newRecord.remoteSha, storage: newRecord.storage, chunks: newRecord.chunks, packId: newRecord.packId, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
    await plugin.saveSyncData();

    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: 2,
        totalPush: 2,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: Date.now()
      };
    }
  } catch (error) {
    reportSyncError("localChange", error, newfile);
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "fail",
        pushCount: 0,
        totalPush: 0,
        pullCount: 0,
        totalPull: 0,
        lastSyncTime: plugin.syncProgress.lastSyncTime,
        errorMessage: (error as Error).message
      };
    }
  } finally {
    plugin.isSyncInProgress = false;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

export async function encryptedRename(newFileOrPath: string | TAbstractFile, oldFileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  return enqueue(plugin, () => encryptedRenameImpl(newFileOrPath, oldFileOrPath, plugin, eventEnter));
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, force: boolean): Promise<void> {
  const state = ensureEncryptedState(plugin);
  const candidateEntries = Object.entries(manifest.files).filter(([_, record]) => !record.deleted && record.storage !== "pack");

  for (const [path, record] of candidateEntries) {
    let countedPull = false;
    try {
      const localState = state.files[path];
      if (!force && localState?.plaintextSha256 === record.plaintextSha256) continue;

      const localFile = plugin.app.vault.getAbstractFileByPath(path);
      let localHash: string | undefined;
      let localBytes: Uint8Array | undefined;

      if (!force && localFile instanceof TFile) {
        localBytes = await readVaultFileBytes(plugin.app.vault, localFile);
        localHash = await sha256Hex(localBytes);
        if (localHash === record.plaintextSha256) continue;
      }

      if (plugin.syncProgress) {
        plugin.syncProgress.totalPull++;
        countedPull = true;
      }
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
      const plaintext = await downloadEncryptedFileObject(plugin.githubClient, key, record);

      if (!force && localFile instanceof TFile && localHash !== undefined) {
        const localChanged = localState ? localState.plaintextSha256 !== localHash : localHash !== record.plaintextSha256;
        if (localChanged) {
          const resolution = await chooseConflictResolution(plugin, configuredConflictPolicy(plugin), path, localFile, record.mtime);
          if (resolution === "keep-local") continue;
          if (resolution === "copy-remote") {
            await writeVaultFileBytes(plugin.app.vault, conflictPathFor(path, Date.now(), "remote"), plaintext);
            continue;
          }
          if (resolution === "merged") {
            const localText = localBytes ? new TextDecoder().decode(localBytes) : await readVaultFileText(plugin.app.vault, localFile);
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
    } finally {
      if (countedPull && plugin.syncProgress) plugin.syncProgress.pullCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
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
  const remoteAlreadyPacked = previousPacks.length > 0 || Object.values(manifest.files).some(record => !record.deleted && record.storage === "pack");
  if (remoteAlreadyPacked || chooseEncryptedStorageMode({ fileCount: localFiles.length, totalBytes }) === "pack") {
    const looseDeltaResult = await pushEncryptedLooseDeltaLocalChanges(plugin, key, manifest, localFiles);
    if (looseDeltaResult) return looseDeltaResult;
    if (canSkipPackUpload(plugin, manifest, localFiles)) return { changed: false, packsToDeleteAfterSave: [] };
    return { changed: await pushEncryptedPackLocalChanges(plugin, key, manifest, localFiles), packsToDeleteAfterSave: previousPacks };
  }
  return { changed: await pushEncryptedLocalChanges(plugin, key, manifest, ignoreRules, false), packsToDeleteAfterSave: [] };
}

async function pushEncryptedLooseDeltaLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, localFiles: TFile[]): Promise<{ changed: boolean; packsToDeleteAfterSave: EncryptedPackManifestRecord[] } | null> {
  const state = ensureEncryptedState(plugin);
  const filesByPath = localFilesByPath(localFiles);
  const localPaths = new Set(filesByPath.keys());
  const dirtyFiles: TFile[] = [];
  const deletedPaths: string[] = [];
  let dirtyBytes = 0;

  for (const file of localFiles) {
    const path = normalizeVaultPath(file.path);
    const record = manifest.files[path];
    const cached = state.files[path];
    if (record && !record.deleted && cached?.plaintextSha256 === record.plaintextSha256 && cached.size === file.stat.size && cached.mtime === file.stat.mtime) continue;
    dirtyFiles.push(file);
    dirtyBytes += file.stat.size;
  }

  for (const [path, record] of Object.entries(manifest.files)) {
    if (!record.deleted && !localPaths.has(path) && state.files[path]?.plaintextSha256 === record.plaintextSha256) deletedPaths.push(path);
  }

  const existingLooseRecords = Object.values(manifest.files).filter(record => !record.deleted && record.storage !== "pack").length;
  const deltaCount = dirtyFiles.length + deletedPaths.length;
  if (deltaCount === 0) return { changed: false, packsToDeleteAfterSave: [] };
  if (deltaCount > ENCRYPTED_LOOSE_DELTA_MAX_FILES || dirtyBytes > ENCRYPTED_LOOSE_DELTA_MAX_BYTES || existingLooseRecords + dirtyFiles.length > ENCRYPTED_LOOSE_DELTA_COMPACT_AFTER_FILES) {
    syncConsoleLog(plugin.settings, "info", "encrypted sync using pack compaction instead of loose delta", {
      deltaCount,
      dirtyBytes,
      existingLooseRecords,
      maxDeltaFiles: ENCRYPTED_LOOSE_DELTA_MAX_FILES,
      maxDeltaBytes: ENCRYPTED_LOOSE_DELTA_MAX_BYTES,
    });
    return null;
  }

  if (plugin.syncProgress) plugin.syncProgress.totalPush += dirtyFiles.length;
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  syncConsoleLog(plugin.settings, "info", "encrypted sync using loose delta", { dirtyFileCount: dirtyFiles.length, deletedPathCount: deletedPaths.length, dirtyBytes });

  for (const file of dirtyFiles) {
    try {
      const path = normalizeVaultPath(file.path);
      const existing = manifest.files[path];
      const plaintext = await readVaultFileBytes(plugin.app.vault, file);
      const plaintextSha256 = await sha256Hex(plaintext);
      if (existing && !existing.deleted && existing.plaintextSha256 === plaintextSha256) {
        state.files[path] = { ...state.files[path], plaintextSha256, objectPath: existing.objectPath, remoteSha: existing.remoteSha, storage: existing.storage, chunks: existing.chunks, packId: existing.packId, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
        continue;
      }
      const reusableExisting = existing && existing.storage !== "pack" ? existing : undefined;
      const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
      const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
      manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
      state.files[path] = { plaintextSha256, objectPath: manifest.files[path].objectPath, remoteSha: manifest.files[path].remoteSha, storage: manifest.files[path].storage, chunks: manifest.files[path].chunks, manifestUpdatedAt: manifest.updatedAt, size: file.stat.size, mtime: file.stat.mtime };
    } finally {
      if (plugin.syncProgress) plugin.syncProgress.pushCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
    }
  }

  for (const path of deletedPaths) {
    const previous = manifest.files[path];
    manifest.files[path] = { ...previous, deleted: true, deletedAt: Date.now() };
    delete state.files[path];
  }

  return { changed: true, packsToDeleteAfterSave: [] };
}

async function deleteObsoleteRemotePacks(plugin: FastSync, previousPacks: EncryptedPackManifestRecord[], manifest: EncryptedManifest): Promise<void> {
  const currentPackPaths = new Set(Object.values(manifest.packs ?? {}).map(pack => pack.objectPath));
  for (const pack of previousPacks) {
    if (pack.remoteSha && !currentPackPaths.has(pack.objectPath)) await plugin.githubClient.deleteFile(pack.objectPath, pack.remoteSha);
  }
}

async function deleteObsoleteRemoteObjects(plugin: FastSync, previousRecords: Array<EncryptedManifest["files"][string]>, manifest: EncryptedManifest): Promise<void> {
  const currentObjectPaths = new Set<string>();
  for (const record of Object.values(manifest.files)) {
    if (record.deleted || record.storage === "pack") continue;
    if (record.storage === "chunked") {
      for (const chunk of record.chunks ?? []) currentObjectPaths.add(chunk.path);
    } else {
      currentObjectPaths.add(record.objectPath);
    }
  }

  for (const record of previousRecords) {
    if (record.deleted || record.storage === "pack") continue;
    if (record.storage === "chunked") {
      for (const chunk of record.chunks ?? []) {
        if (chunk.remoteSha && !currentObjectPaths.has(chunk.path)) await plugin.githubClient.deleteFile(chunk.path, chunk.remoteSha);
      }
      continue;
    }
    if (record.remoteSha && !currentObjectPaths.has(record.objectPath)) await plugin.githubClient.deleteFile(record.objectPath, record.remoteSha);
  }
}

function encryptedLiveRemotePaths(manifest: EncryptedManifest, currentSnapshotId: string): Set<string> {
  const paths = new Set<string>([
    ENCRYPTED_CONFIG_PATH,
    V2_HEAD_PATH,
    `${V2_SNAPSHOTS_ROOT}/${currentSnapshotId}.enc`,
  ]);
  for (const pack of Object.values(manifest.packs ?? {})) paths.add(pack.objectPath);
  for (const record of Object.values(manifest.files)) {
    if (record.deleted) continue;
    if (record.storage === "chunked") {
      for (const chunk of record.chunks ?? []) paths.add(chunk.path);
    } else if (record.storage !== "pack") {
      paths.add(record.objectPath);
    }
  }
  return paths;
}

async function pruneEncryptedRemoteAfterForcePush(plugin: FastSync, manifest: EncryptedManifest, currentSnapshotId: string): Promise<void> {
  const livePaths = encryptedLiveRemotePaths(manifest, currentSnapshotId);
  const remoteTree = await plugin.githubClient.getTree();
  if (remoteTree.truncated) throw new Error("GitHub tree response was truncated; encrypted force push cannot safely mirror this repository.");
  for (const remote of remoteTree.tree) {
    if (remote.type !== "blob") continue;
    const path = remote.path;
    const isEncryptedPluginPath = path.startsWith(`${ENCRYPTED_ROOT}/`) || path.startsWith(`${V2_ROOT}/`);
    const isManagedDataPath = path.startsWith(`${ENCRYPTED_OBJECTS_ROOT}/`) || path.startsWith(`${ENCRYPTED_PACKS_ROOT}/`) || isEncryptedPluginPath;
    if (!isManagedDataPath || livePaths.has(path)) continue;
    await plugin.githubClient.deleteFile(path, remote.sha);
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

  if (plugin.syncProgress) plugin.syncProgress.totalPush += plan.packs.length + objectFiles.length;
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();

  for (const pack of plan.packs) {
    try {
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
    } finally {
      if (plugin.syncProgress) plugin.syncProgress.pushCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
    }
  }

  for (const file of objectFiles) {
    try {
      const path = normalizeVaultPath(file.path);
      const plaintext = await readVaultFileBytes(plugin.app.vault, file);
      const plaintextSha256 = await sha256Hex(plaintext);
      const existing = previousFiles[path];
      const reusableExisting = existing?.storage === "pack" ? undefined : existing;
      const objectId = reusableExisting?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
      const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, objectId, plaintext, reusableExisting);
      manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime, deleted: false, deletedAt: undefined };
    } finally {
      if (plugin.syncProgress) plugin.syncProgress.pushCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
    }
  }
  return true;
}

function packRecordsFor(manifest: EncryptedManifest, packId: string): Array<[string, EncryptedManifest["files"][string]]> {
  return Object.entries(manifest.files).filter(([, record]) => !record.deleted && record.storage === "pack" && record.packId === packId);
}

async function canSkipPackDownload(plugin: FastSync, manifest: EncryptedManifest, packId: string, force: boolean, locallyDirtyPaths: Set<string> = new Set()): Promise<boolean> {
  if (force) return false;
  const records = packRecordsFor(manifest, packId);
  if (records.length === 0) return false;
  const state = ensureEncryptedState(plugin);
  for (const [path, record] of records) {
    if (state.files[path]?.plaintextSha256 === record.plaintextSha256) continue;
    if (locallyDirtyPaths.has(path) && state.files[path]?.plaintextSha256 === record.plaintextSha256) continue;
    const localFile = plugin.app.vault.getAbstractFileByPath(path);
    if (!(localFile instanceof TFile)) return false;
    const localHash = await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile));
    if (localHash !== record.plaintextSha256) return false;
  }
  return true;
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
async function pullEncryptedPackChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest, ignoreRules: ReturnType<typeof compileIgnorePathRegex>, force: boolean, locallyDirtyPaths: Set<string> = new Set()): Promise<void> {
  const state = ensureEncryptedState(plugin);
  const packs = Object.values(manifest.packs ?? {});

  for (const pack of packs) {
    let countedPull = false;
    try {
      if (await canSkipPackDownload(plugin, manifest, pack.id, force, locallyDirtyPaths)) continue;
      if (plugin.syncProgress) {
        plugin.syncProgress.totalPull++;
        countedPull = true;
      }
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
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
              const localText = await readVaultFileText(plugin.app.vault, localFile);
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
    } finally {
      if (countedPull && plugin.syncProgress) plugin.syncProgress.pullCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
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
  if (plugin.syncProgress) plugin.syncProgress.totalPush += localFiles.length;
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  for (const file of localFiles) {
    try {
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
    } finally {
      if (plugin.syncProgress) plugin.syncProgress.pushCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
    }
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
