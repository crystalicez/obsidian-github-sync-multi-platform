import { Notice, TAbstractFile, TFile } from "obsidian";
import type FastSync from "../../main";
import { syncConsoleLog } from "../debug";
import { compileIgnorePathRegex } from "../encrypted/ignore";
import { listEncryptedSyncCandidates, readVaultFileBytes, writeVaultFileBytes, deleteVaultFileIfExists, shouldSyncEncryptedFile } from "../encrypted/vault";
import { utf8ToBytes } from "../encrypted/bytes";
import { deriveEncryptedV3Keyring } from "./keyring";
import { createEmptyV3LocalIndex, loadV3LocalIndex, type V3LocalIndex, type V3LocalIndexAdapter } from "./local-index";
import { EncryptedV3SyncSession, type EncryptedV3Vault } from "./sync-session";
import { normalizeV3VaultPath } from "./paths";
import { EncryptedV3ChangeBatcher, type EncryptedV3QueuedChange } from "./change-batcher";
import { effectiveConflictPolicy } from "../encrypted/settings-policy";

const V3_INDEX_ROOT = "encrypted-v3-index";
const V3_WATCH_FLUSH_DELAY_MS = 350;
const fallbackIndexStores = new WeakMap<object, Map<string, string>>();
const pendingChangeBatches = new WeakMap<object, PendingV3ChangeBatch>();

interface PendingV3ChangeBatch {
  batcher: EncryptedV3ChangeBatcher;
  timer?: ReturnType<typeof setTimeout>;
  flushing?: Promise<void>;
}

function encryptedV3Enabled(plugin: FastSync): boolean {
  if ((plugin as FastSync & { isTesting?: boolean }).isTesting
    && (plugin.settings as { encryptedProtocolVersion?: "v2" | "v3" }).encryptedProtocolVersion === "v2") {
    return false;
  }
  return plugin.settings.encryptionMode === "encrypted";
}

export function shouldUseEncryptedV3(plugin: FastSync): boolean {
  return encryptedV3Enabled(plugin);
}

function createPluginIndexAdapter(plugin: FastSync): V3LocalIndexAdapter {
  const vault = plugin.app.vault as FastSync["app"]["vault"] & {
    configDir?: string;
    adapter?: {
      read(path: string): Promise<string>;
      write(path: string, data: string): Promise<void>;
      exists(path: string): Promise<boolean>;
      mkdir(path: string): Promise<void>;
    };
  };
  const adapter = vault.adapter;
  if (!adapter) return createMemoryIndexAdapter(plugin as object);
  const configDir = vault.configDir || ".obsidian";
  const pluginId = (plugin as FastSync & { manifest?: { id?: string } }).manifest?.id || "encrypted-github-sync-multi-platform";
  const base = `${configDir}/plugins/${pluginId}`;
  const resolvePath = (path: string) => `${base}/${path.replace(/^\/+/u, "")}`;
  return {
    async read(path: string) {
      return adapter.read(resolvePath(path));
    },
    async write(path: string, data: string) {
      await adapter.write(resolvePath(path), data);
    },
    async exists(path: string) {
      return adapter.exists(resolvePath(path));
    },
    async mkdir(path: string) {
      await adapter.mkdir(resolvePath(path));
    },
  };
}

function createMemoryIndexAdapter(owner: object): V3LocalIndexAdapter {
  let store = fallbackIndexStores.get(owner);
  if (!store) {
    store = new Map<string, string>();
    fallbackIndexStores.set(owner, store);
  }
  return {
    async read(path: string) {
      const value = store.get(path);
      if (value === undefined) throw new Error(`Missing encrypted v3 local index file: ${path}`);
      return value;
    },
    async write(path: string, data: string) {
      store.set(path, data);
    },
    async exists(path: string) {
      return store.has(path);
    },
    async mkdir(_path: string) {},
  };
}

function repoId(plugin: FastSync): string {
  return `${plugin.settings.githubOwner}/${plugin.settings.githubRepo}#${plugin.settings.githubBranch || "main"}`;
}

async function loadRuntimeIndex(plugin: FastSync, adapter: V3LocalIndexAdapter): Promise<V3LocalIndex> {
  const loaded = await loadV3LocalIndex(adapter, V3_INDEX_ROOT);
  const id = repoId(plugin);
  if (loaded.repoId) return loaded;
  return createEmptyV3LocalIndex({ repoId: id, deviceId: plugin.settings.vault || "defaultVault" });
}

function runtimeVault(plugin: FastSync): EncryptedV3Vault {
  return {
    async listFiles() {
      const ignoreRules = compileIgnorePathRegex(plugin.settings.ignorePathRegex ?? "");
      return listEncryptedSyncCandidates(plugin.app.vault, ignoreRules).map(file => ({
        path: normalizeV3VaultPath(file.path),
        size: file.stat.size,
        mtime: file.stat.mtime,
      }));
    },
    async read(path: string) {
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`);
      return readVaultFileBytes(plugin.app.vault, file);
    },
    async write(path: string, bytes: Uint8Array) {
      await writeVaultFileBytes(plugin.app.vault, path, bytes);
    },
    async delete(path: string) {
      await deleteVaultFileIfExists(plugin.app.vault, path);
    },
  };
}

async function createSession(plugin: FastSync): Promise<EncryptedV3SyncSession> {
  const passphrase = plugin.settings.encryptionPassphrase?.trim();
  if (!passphrase) throw new Error("Encryption passphrase is required for encrypted v3 sync.");
  const adapter = createPluginIndexAdapter(plugin);
  const index = await loadRuntimeIndex(plugin, adapter);
  const keys = await deriveEncryptedV3Keyring({ passphrase, repoId: index.repoId, salt: utf8ToBytes(index.repoId) });
  return new EncryptedV3SyncSession({
    github: plugin.githubClient,
    vault: runtimeVault(plugin),
    adapter,
    indexRoot: V3_INDEX_ROOT,
    index,
    keyMaterial: keys.masterKey,
    conflictPolicy: effectiveConflictPolicy(plugin.settings.conflictPolicy),
  });
}

async function runV3(plugin: FastSync, label: string, operation: () => Promise<{ phaseSummary: string; changedFiles: number; changedBytes: number; mode: string }>): Promise<void> {
  if (!plugin.githubClient) return;
  plugin.isSyncInProgress = true;
  if (plugin.syncProgress) {
    plugin.syncProgress = { status: "syncing", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: plugin.syncProgress.lastSyncTime };
  }
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  try {
    const result = await operation();
    syncConsoleLog(plugin.settings, "info", `encrypted v3 ${label} completed`, result);
    if (plugin.syncProgress) {
      plugin.syncProgress = { status: "success", pushCount: result.changedFiles, totalPush: result.changedFiles, pullCount: 0, totalPull: 0, lastSyncTime: Date.now() };
    }
  } catch (error) {
    syncConsoleLog(plugin.settings, "warn", `encrypted v3 ${label} failed`, { error });
    new Notice(`Encrypted v3 ${label} failed: ${(error as Error).message}`);
    if (plugin.syncProgress) {
      plugin.syncProgress = { status: "fail", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: plugin.syncProgress.lastSyncTime, errorMessage: (error as Error).message };
    }
  } finally {
    plugin.isSyncInProgress = false;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

function getPendingBatch(plugin: FastSync): PendingV3ChangeBatch {
  let state = pendingChangeBatches.get(plugin as object);
  if (!state) {
    state = { batcher: new EncryptedV3ChangeBatcher() };
    pendingChangeBatches.set(plugin as object, state);
  }
  return state;
}

function schedulePendingFlush(plugin: FastSync): void {
  const state = getPendingBatch(plugin);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void flushEncryptedV3PendingChanges(plugin);
  }, V3_WATCH_FLUSH_DELAY_MS);
}

function enqueuePendingChange(plugin: FastSync, change: EncryptedV3QueuedChange): void {
  const state = getPendingBatch(plugin);
  state.batcher.enqueue(change);
  if (plugin.syncProgress) {
    plugin.syncProgress = {
      ...plugin.syncProgress,
      status: "pending",
      totalPush: state.batcher.size,
      pushCount: 0,
    };
  }
  if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  schedulePendingFlush(plugin);
}

export async function flushEncryptedV3PendingChanges(plugin: FastSync): Promise<void> {
  const state = getPendingBatch(plugin);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (state.flushing) {
    await state.flushing;
    if (state.batcher.size === 0) return;
  }
  const changes = state.batcher.flush();
  if (changes.length === 0) return;
  state.flushing = runV3(plugin, "local batch", async () => (await createSession(plugin)).flushLocalChanges(changes))
    .finally(() => {
      state.flushing = undefined;
      if (state.batcher.size > 0) schedulePendingFlush(plugin);
    });
  await state.flushing;
}

export async function encryptedV3FullSync(plugin: FastSync): Promise<void> {
  await flushEncryptedV3PendingChanges(plugin);
  await runV3(plugin, "sync", async () => (await createSession(plugin)).sync({ operation: "normal" }));
}

export async function encryptedV3ForcePush(plugin: FastSync): Promise<void> {
  await flushEncryptedV3PendingChanges(plugin);
  await runV3(plugin, "force push", async () => (await createSession(plugin)).sync({ operation: "forcePush" }));
}

export async function encryptedV3ForcePull(plugin: FastSync): Promise<void> {
  await runV3(plugin, "force pull", async () => (await createSession(plugin)).sync({ operation: "forcePull" }));
}

export async function encryptedV3Modify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!shouldSyncEncryptedFile(file, compileIgnorePathRegex(plugin.settings.ignorePathRegex ?? ""))) return;
  if (eventEnter) {
    enqueuePendingChange(plugin, { type: "modify", path: file.path, mtime: file.stat.mtime });
    return;
  }
  await runV3(plugin, "local change", async () => (await createSession(plugin)).flushLocalChanges([{ type: "modify", path: file.path, mtime: file.stat.mtime }]));
}

export async function encryptedV3Delete(fileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
  if (eventEnter) {
    enqueuePendingChange(plugin, { type: "delete", path, mtime: Date.now() });
    return;
  }
  await runV3(plugin, "local delete", async () => (await createSession(plugin)).flushLocalChanges([{ type: "delete", path, mtime: Date.now() }]));
}

export async function encryptedV3Rename(newFileOrPath: string | TAbstractFile, oldFileOrPath: string | TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  const path = typeof newFileOrPath === "string" ? newFileOrPath : newFileOrPath.path;
  const oldPath = typeof oldFileOrPath === "string" ? oldFileOrPath : oldFileOrPath.path;
  const change: EncryptedV3QueuedChange = { type: "rename", oldPath, path, mtime: Date.now() };
  if (eventEnter) {
    enqueuePendingChange(plugin, change);
    return;
  }
  await runV3(plugin, "local rename", async () => (await createSession(plugin)).flushLocalChanges([change]));
}
