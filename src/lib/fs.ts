import { TFile, TAbstractFile, Notice, requestUrl } from "obsidian";

import { hashContent, dump } from "./helps";
import FastSync, { FileState } from "../main";
import { GitHubClient, GitHubTreeNode } from "./github-api";
import { encryptedDelete, encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "./encrypted/sync-engine";
import { shouldHandleEncryptedLocalChange } from "./encrypted/settings-policy";
import { conflictPathFor, detectCaseInsensitiveCollisions } from "./encrypted/paths";
import { compileIgnorePathRegex, isIgnoredPath } from "./encrypted/ignore";
import { readVaultFileBinary, readVaultFileText } from "./encrypted/vault";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ENCRYPTED_MODIFY_DEBOUNCE_MS = 5000;


type PlaintextSyncEntry = FileState & { size?: number; mtime?: number };

function cachedPlaintextStatMatches(file: TFile, entry?: PlaintextSyncEntry): boolean {
  return entry?.size === file.stat.size && entry?.mtime === file.stat.mtime;
}

function plaintextSyncEntry(sha: string, file: TFile, hash: string, lastSync: number = Date.now()): PlaintextSyncEntry {
  return { sha, lastSync, hash, size: file.stat.size, mtime: file.stat.mtime };
}


async function getRemoteHeadShaIfAvailable(plugin: FastSync): Promise<string | null> {
  const getter = (plugin.githubClient as GitHubClient & { getRemoteHeadSha?: () => Promise<string | null> }).getRemoteHeadSha;
  if (typeof getter !== "function") return null;
  try {
    return await getter.call(plugin.githubClient);
  } catch (error) {
    console.warn("Remote HEAD lookup failed; falling back to full sync", error);
    return null;
  }
}

function isPlaintextSyncPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (ext === "md" || IMAGE_EXTENSIONS.includes(ext)) && !path.includes(".sync-conflict-");
}

function shouldSyncPlaintextPath(plugin: FastSync, path: string): boolean {
  if (!isPlaintextSyncPath(path)) return false;
  const rules = compileIgnorePathRegex((plugin.settings as { ignorePathRegex?: string }).ignorePathRegex ?? "");
  return !isIgnoredPath(path, rules);
}

function plaintextLocalStateMatchesCache(plugin: FastSync, files: TFile[]): boolean {
  const localPaths = new Set(files.map(file => file.path));
  for (const file of files) {
    const cached = plugin.syncData.files[file.path];
    if (!cached?.hash || !cachedPlaintextStatMatches(file, cached)) return false;
  }
  for (const cachedPath of Object.keys(plugin.syncData.files)) {
    if (isPlaintextSyncPath(cachedPath) && !localPaths.has(cachedPath)) return false;
  }
  return true;
}
function shouldSyncPlaintextFile(file: TFile, plugin?: FastSync): boolean {
  if (!isPlaintextSyncPath(file.path) || file.stat.size > MAX_FILE_SIZE) return false;
  if (!plugin) return true;
  return shouldSyncPlaintextPath(plugin, file.path);
}

function throwIfPlaintextPathCollisions(files: TFile[]): void {
  const collisions = detectCaseInsensitiveCollisions(files.map(file => file.path));
  if (collisions.length > 0) {
    throw new Error(`Case-insensitive path collision: ${collisions.map(pair => pair.join(" <-> ")).join(", ")}`);
  }
}

function assertNoPlaintextPathCollisions(plugin: FastSync): void {
  throwIfPlaintextPathCollisions(plugin.app.vault.getFiles().filter(file => shouldSyncPlaintextFile(file, plugin)));
}

function listPlaintextSyncCandidates(plugin: FastSync): TFile[] {
  const files = plugin.app.vault.getFiles().filter(file => shouldSyncPlaintextFile(file, plugin));
  throwIfPlaintextPathCollisions(files);
  return files;
}

async function ensureVaultFolder(plugin: FastSync, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) await plugin.app.vault.createFolder(current);
  }
}

async function writePlaintextConflictCopy(plugin: FastSync, path: string, content: string | ArrayBuffer): Promise<void> {
  const conflictPath = conflictPathFor(path, Date.now(), "remote");
  const folderPath = conflictPath.split("/").slice(0, -1).join("/");
  await ensureVaultFolder(plugin, folderPath);
  if (typeof content === "string") await plugin.app.vault.create(conflictPath, content);
  else await plugin.app.vault.createBinary(conflictPath, content);
}

async function currentPlaintextHash(plugin: FastSync, file: TFile): Promise<string> {
  if (file.extension === "md") return hashContent(await readVaultFileText(plugin.app.vault, file));
  return file.stat.size + "_" + file.stat.mtime;
}

function encryptedDebounceKey(path: string): string {
  return `encrypted:${path}`;
}

function renameDebounceKey(prefix: "rename" | "encrypted-rename", oldPath: string, newPath: string): string {
  return `${prefix}:${JSON.stringify([oldPath, newPath])}`;
}

function parseRenameDebounceKey(key: string, prefix: "rename" | "encrypted-rename"): { oldPath: string; newPath: string } | null {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  const encoded = key.slice(marker.length);
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { oldPath: parsed[0], newPath: parsed[1] };
    }
  } catch (_error) {
    const parts = key.split(":");
    if (parts.length >= 3) return { oldPath: parts[1], newPath: parts.slice(2).join(":") };
  }
  return null;
}

function scheduleEncryptedModify(file: TFile, plugin: FastSync, eventEnter: boolean): void {
  const key = encryptedDebounceKey(file.path);
  if (plugin.debounceTimers.has(key)) globalThis.clearTimeout(plugin.debounceTimers.get(key));

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(async () => {
    plugin.debounceTimers.delete(key);
    await encryptedModify(file, plugin, eventEnter);
  }, ENCRYPTED_MODIFY_DEBOUNCE_MS) as unknown as number;
  plugin.debounceTimers.set(key, timer);
}

function clearEncryptedModify(path: string, plugin: FastSync): void {
  const key = encryptedDebounceKey(path);
  if (!plugin.debounceTimers.has(key)) return;
  globalThis.clearTimeout(plugin.debounceTimers.get(key));
  plugin.debounceTimers.delete(key);
}

/**
 * 核心修改逻辑，包含防抖和哈希校验
 */
export const NoteModify = function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.encryptionMode === "encrypted") {
    if (!plugin.isWatchEnabled && eventEnter) return;
    if (!shouldHandleEncryptedLocalChange(plugin.settings, eventEnter)) return;
    if (!(file instanceof TFile)) return;
    if (eventEnter) scheduleEncryptedModify(file, plugin, eventEnter);
    else void encryptedModify(file, plugin, eventEnter);
    return;
  }
  if (!(file instanceof TFile)) return;
  if (eventEnter && !plugin.settings.syncEnabled) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (plugin.ignoredFiles.has(file.path) && eventEnter) return;
  if (!plugin.githubClient) return;

  // 1. 文件大小限制 (10MB)
  if (file.stat.size > MAX_FILE_SIZE) {
    new Notice(`File too large (>10MB): ${file.path}. Skipped sync.`);
    return;
  }

  // 2. 防抖处理
  const key = file.path;
  if (plugin.debounceTimers.has(key)) {
    globalThis.clearTimeout(plugin.debounceTimers.get(key));
  }

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(() => {
    void (async () => {
      plugin.debounceTimers.delete(key);
      await performSync(file, plugin);
    })();
  }, 5000) as unknown as number; // 5秒防抖

  plugin.debounceTimers.set(key, timer);
};

const performSync = async (file: TFile, plugin: FastSync) => {
  if (plugin.isSyncInProgress) {
    dump(`Sync already in progress, skipping performSync for ${file.path}`);
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
    assertNoPlaintextPathCollisions(plugin);
    plugin.addIgnoredFile(file.path);
    const isMarkdown = file.extension === "md";
    const isImage = IMAGE_EXTENSIONS.includes(file.extension.toLowerCase());

    // 只同步 Markdown 笔记和图片，其余类型（.zip .canvas .base 等）跳过
    // 避免向 GitHub API 发送无法处理的文件类型导致 422
    if (!isMarkdown && !isImage) {
      if (plugin.syncProgress) {
        plugin.syncProgress.status = "success";
      }
      return;
    }

    let content: string | ArrayBuffer;
    let currentHash: string;

    if (isMarkdown) {
      content = await readVaultFileText(plugin.app.vault, file);
      currentHash = hashContent(content);
    } else {
      content = await readVaultFileBinary(plugin.app.vault, file);
      // 对二进制文件使用简单的摘要校验
      currentHash = file.stat.size + "_" + file.stat.mtime;
    }

    // 3. 检查内容是否真正变化 (对比缓存的哈希)
    if (plugin.syncData.files[file.path]?.hash === currentHash) {
      dump(`No content change for ${file.path}, skip sync.`);
      if (plugin.syncProgress) {
        plugin.syncProgress.status = "success";
      }
      return;
    }

    const sha = plugin.syncData.files[file.path]?.sha;
    const newSha = await plugin.githubClient.putFile(file.path, content, sha);

    plugin.syncData.files[file.path] = plaintextSyncEntry(newSha, file, currentHash);
    await plugin.saveSyncData();
    dump(`Synced ${file.path} to GitHub`, newSha);

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
    console.error("Sync failed:", error);
    new Notice(`Sync failed for ${file.path}: ${error.message}`);
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
    plugin.removeIgnoredFile(file.path);
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
};

function clearPlaintextTimers(path: string, plugin: FastSync): void {
  const modifyKey = path;
  if (plugin.debounceTimers.has(modifyKey)) {
    globalThis.clearTimeout(plugin.debounceTimers.get(modifyKey));
    plugin.debounceTimers.delete(modifyKey);
  }
  const deleteKey = `delete:${path}`;
  if (plugin.debounceTimers.has(deleteKey)) {
    globalThis.clearTimeout(plugin.debounceTimers.get(deleteKey));
    plugin.debounceTimers.delete(deleteKey);
  }
  for (const key of plugin.debounceTimers.keys()) {
    const rename = parseRenameDebounceKey(key, "rename");
    if (rename) {
      if (rename.oldPath === path || rename.newPath === path) {
        globalThis.clearTimeout(plugin.debounceTimers.get(key));
        plugin.debounceTimers.delete(key);
      }
    }
  }
}

function clearEncryptedTimers(path: string, plugin: FastSync): void {
  const modifyKey = encryptedDebounceKey(path);
  if (plugin.debounceTimers.has(modifyKey)) {
    globalThis.clearTimeout(plugin.debounceTimers.get(modifyKey));
    plugin.debounceTimers.delete(modifyKey);
  }
  const deleteKey = `encrypted-delete:${path}`;
  if (plugin.debounceTimers.has(deleteKey)) {
    globalThis.clearTimeout(plugin.debounceTimers.get(deleteKey));
    plugin.debounceTimers.delete(deleteKey);
  }
  for (const key of plugin.debounceTimers.keys()) {
    const rename = parseRenameDebounceKey(key, "encrypted-rename");
    if (rename) {
      if (rename.oldPath === path || rename.newPath === path) {
        globalThis.clearTimeout(plugin.debounceTimers.get(key));
        plugin.debounceTimers.delete(key);
      }
    }
  }
}

function schedulePlaintextDelete(path: string, plugin: FastSync): void {
  const key = `delete:${path}`;
  if (plugin.debounceTimers.has(key)) globalThis.clearTimeout(plugin.debounceTimers.get(key));

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(async () => {
    plugin.debounceTimers.delete(key);
    await performPlaintextDelete(path, plugin);
  }, 5000) as unknown as number;
  plugin.debounceTimers.set(key, timer);
}

function schedulePlaintextRename(oldPath: string, newPath: string, plugin: FastSync): void {
  const key = renameDebounceKey("rename", oldPath, newPath);
  if (plugin.debounceTimers.has(key)) globalThis.clearTimeout(plugin.debounceTimers.get(key));

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(async () => {
    plugin.debounceTimers.delete(key);
    await performPlaintextRename(oldPath, newPath, plugin);
  }, 5000) as unknown as number;
  plugin.debounceTimers.set(key, timer);
}

function scheduleEncryptedDelete(path: string, plugin: FastSync, eventEnter: boolean): void {
  const key = `encrypted-delete:${path}`;
  if (plugin.debounceTimers.has(key)) globalThis.clearTimeout(plugin.debounceTimers.get(key));

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(async () => {
    plugin.debounceTimers.delete(key);
    await encryptedDelete(path, plugin, eventEnter);
  }, 5000) as unknown as number;
  plugin.debounceTimers.set(key, timer);
}

function scheduleEncryptedRename(newPath: string, oldPath: string, plugin: FastSync, eventEnter: boolean): void {
  const key = renameDebounceKey("encrypted-rename", oldPath, newPath);
  if (plugin.debounceTimers.has(key)) globalThis.clearTimeout(plugin.debounceTimers.get(key));

  if (plugin.syncProgress) {
    plugin.syncProgress = {
      status: "waiting",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress.lastSyncTime
    };
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }

  const timer = globalThis.setTimeout(async () => {
    plugin.debounceTimers.delete(key);
    await encryptedRename(newPath, oldPath, plugin, eventEnter);
  }, 5000) as unknown as number;
  plugin.debounceTimers.set(key, timer);
}

const performPlaintextDelete = async (path: string, plugin: FastSync) => {
  if (plugin.isSyncInProgress) {
    dump(`Sync already in progress, skipping performPlaintextDelete for ${path}`);
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
  plugin.addIgnoredFile(path);
  try {
    const sha = plugin.syncData.files[path]?.sha;
    if (sha) {
      await plugin.githubClient.deleteFile(path, sha);
      delete plugin.syncData.files[path];
      await plugin.saveSyncData();
      dump(`Deleted ${path} from GitHub`);
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
    } else {
      if (plugin.syncProgress) {
        plugin.syncProgress.status = "success";
      }
    }
  } catch (error) {
    console.error("Delete failed:", error);
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
    plugin.removeIgnoredFile(path);
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
};

const performPlaintextRename = async (oldfile: string, newfile: string, plugin: FastSync) => {
  if (plugin.isSyncInProgress) {
    dump(`Sync already in progress, skipping performPlaintextRename for ${oldfile} -> ${newfile}`);
    return;
  }
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
  plugin.addIgnoredFile(newfile);
  try {
    assertNoPlaintextPathCollisions(plugin);
    const oldSha = plugin.syncData.files[oldfile]?.sha;

    const file = plugin.app.vault.getAbstractFileByPath(newfile);
    if (!(file instanceof TFile)) {
      if (plugin.syncProgress) {
        plugin.syncProgress.status = "success";
      }
      return;
    }

    const isMarkdown = file.extension === "md";
    let content: string | ArrayBuffer;
    let currentHash: string;

    if (isMarkdown) {
      content = await readVaultFileText(plugin.app.vault, file);
      currentHash = hashContent(content);
    } else {
      content = await readVaultFileBinary(plugin.app.vault, file);
      currentHash = file.stat.size + "_" + file.stat.mtime;
    }

    const newSha = await plugin.githubClient.putFile(newfile, content);
    plugin.syncData.files[newfile] = plaintextSyncEntry(newSha, file, currentHash);
    if (oldSha) {
      await plugin.githubClient.deleteFile(oldfile, oldSha);
      delete plugin.syncData.files[oldfile];
    }
    await plugin.saveSyncData();
    dump(`Renamed ${oldfile} -> ${newfile}`);

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
    console.error("Rename failed:", error);
    new Notice(`Rename failed for ${newfile}: ${(error as Error).message}`);
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
    plugin.removeIgnoredFile(newfile);
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
};

export const NoteDelete = function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  const isTesting = (plugin as any).isTesting;
  if (plugin.settings.encryptionMode === "encrypted") {
    if (!plugin.isWatchEnabled && eventEnter) return;
    if (!shouldHandleEncryptedLocalChange(plugin.settings, eventEnter)) return;
    clearEncryptedTimers(file.path, plugin);
    if (eventEnter && !isTesting) scheduleEncryptedDelete(file.path, plugin, eventEnter);
    else void encryptedDelete(file.path, plugin, eventEnter);
    return;
  }
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (plugin.ignoredFiles.has(file.path) && eventEnter) return;
  if (!plugin.githubClient) return;

  clearPlaintextTimers(file.path, plugin);

  if (eventEnter && !isTesting) {
    schedulePlaintextDelete(file.path, plugin);
  } else {
    void performPlaintextDelete(file.path, plugin);
  }
};

export const NoteRename = function (file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter: boolean = false) {
  const isTesting = (plugin as any).isTesting;
  if (plugin.settings.encryptionMode === "encrypted") {
    if (!plugin.isWatchEnabled && eventEnter) return;
    if (!shouldHandleEncryptedLocalChange(plugin.settings, eventEnter)) return;
    clearEncryptedTimers(oldfile, plugin);
    clearEncryptedTimers(file.path, plugin);
    if (eventEnter && !isTesting) scheduleEncryptedRename(file.path, oldfile, plugin, eventEnter);
    else void encryptedRename(file.path, oldfile, plugin, eventEnter);
    return;
  }
  clearPlaintextTimers(oldfile, plugin);
  clearPlaintextTimers(file.path, plugin);

  if (!(file instanceof TFile)) return;
  if (eventEnter && !plugin.settings.syncEnabled) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;

  if (eventEnter && !isTesting) {
    schedulePlaintextRename(oldfile, file.path, plugin);
  } else {
    void performPlaintextRename(oldfile, file.path, plugin);
  }
};

/**
 * 初始化与同步逻辑 (保持之前实现的 Full Sync, 稍作修改以适配 hash)
 */

export async function overrideRemoteAllFilesImpl(plugin: FastSync): Promise<void> {
  if (plugin.settings.encryptionMode === "encrypted") {
    await encryptedForcePush(plugin);
    return;
  }
  if (plugin.isSyncInProgress) {
    new Notice("Sync is already in progress. Please wait.");
    return;
  }
  if (!plugin.githubClient) return;

  for (const timer of plugin.debounceTimers.values()) {
    globalThis.clearTimeout(timer);
  }
  plugin.debounceTimers.clear();

  plugin.isSyncInProgress = true;
  plugin.disableWatch();

  try {
    const files = listPlaintextSyncCandidates(plugin);
    for (const file of files) {
       const isMarkdown = file.extension === "md";

       let content: string | ArrayBuffer;
       let currentHash: string;

       if (isMarkdown) {
         content = await readVaultFileText(plugin.app.vault, file);
         currentHash = hashContent(content);
       } else {
         content = await readVaultFileBinary(plugin.app.vault, file);
         currentHash = file.stat.size + "_" + file.stat.mtime;
       }

       const sha = plugin.syncData.files[file.path]?.sha;
       const newSha = await plugin.githubClient.putFile(file.path, content, sha);
       plugin.syncData.files[file.path] = plaintextSyncEntry(newSha, file, currentHash);
    }
    plugin.syncData.lastRemoteHeadSha = await getRemoteHeadShaIfAvailable(plugin) ?? plugin.syncData.lastRemoteHeadSha;

    await plugin.saveSyncData();
    new Notice("All assets synced to GitHub");
  } catch (error) {
    console.error("Force sync failed:", error);
    // B3: 失败时弹出通知，用户可感知
    new Notice(`Sync failed: ${(error as Error).message}`);
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
  }
}

export const StartupFullNotesForceOverSync = (plugin: FastSync): void => {
  void overrideRemoteAllFilesImpl(plugin);
};
export async function overrideLocalAllFilesImpl(plugin: FastSync): Promise<void> {
  if (plugin.settings.encryptionMode === "encrypted") {
    await encryptedForcePull(plugin);
    return;
  }
  if (plugin.isSyncInProgress) {
    new Notice("Sync is already in progress. Please wait.");
    return;
  }
  if (!plugin.githubClient) return;

  for (const timer of plugin.debounceTimers.values()) globalThis.clearTimeout(timer);
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
    const remoteTree = await plugin.githubClient.getTree();
    if (remoteTree.truncated) throw new Error("GitHub tree response was truncated; force pull cannot safely mirror this repository.");

    const remoteFiles = remoteTree.tree.filter((node: GitHubTreeNode) => node.type === "blob" && shouldSyncPlaintextPath(plugin, node.path));
    const remotePaths = new Set(remoteFiles.map((node: GitHubTreeNode) => node.path));
    const localFiles = listPlaintextSyncCandidates(plugin);
    const localFilesMap = new Map(localFiles.map(file => [file.path, file] as [string, TFile]));

    if (plugin.syncProgress) plugin.syncProgress.totalPull = remoteFiles.length;
    for (const remote of remoteFiles) {
      const remoteData = await plugin.githubClient.getFile(remote.path);
      if (!remoteData) continue;
      const ext = remote.path.split(".").pop()?.toLowerCase();
      const isMarkdown = ext === "md";
      const folderPath = remote.path.split("/").slice(0, -1).join("/");
      await ensureVaultFolder(plugin, folderPath);

      let finalContent: string | ArrayBuffer;
      if (!remoteData.content && remoteData.download_url) {
        const downloadRes = await requestUrl({ url: remoteData.download_url, headers: plugin.githubClient.headers });
        finalContent = downloadRes.arrayBuffer;
      } else {
        finalContent = remoteData.content;
      }

      plugin.addIgnoredFile(remote.path);
      try {
        const localFile = localFilesMap.get(remote.path);
        if (isMarkdown) {
          const content = typeof finalContent === "string"
            ? GitHubClient.decodeContent(finalContent)
            : new TextDecoder().decode(finalContent);
          if (localFile) await plugin.app.vault.modify(localFile, content);
          else await plugin.app.vault.create(remote.path, content);
          const written = plugin.app.vault.getAbstractFileByPath(remote.path);
          if (written instanceof TFile) {
            plugin.syncData.files[remote.path] = plaintextSyncEntry(remote.sha, written, hashContent(content));
          } else if (localFile) {
            plugin.syncData.files[remote.path] = plaintextSyncEntry(remote.sha, localFile, hashContent(content));
          } else {
            plugin.syncData.files[remote.path] = {
              sha: remote.sha,
              lastSync: Date.now(),
              hash: hashContent(content),
              size: new TextEncoder().encode(content).byteLength,
              mtime: Date.now()
            };
          }
        } else {
          const buffer = typeof finalContent === "string" ? GitHubClient.decodeContentBytes(finalContent).buffer as ArrayBuffer : finalContent;
          if (localFile) await plugin.app.vault.modifyBinary(localFile, buffer);
          else await plugin.app.vault.createBinary(remote.path, buffer);
          const written = plugin.app.vault.getAbstractFileByPath(remote.path);
          if (written instanceof TFile) {
            plugin.syncData.files[remote.path] = plaintextSyncEntry(remote.sha, written, `${written.stat.size}_${written.stat.mtime}`);
          } else {
            plugin.syncData.files[remote.path] = {
              sha: remote.sha,
              lastSync: Date.now(),
              hash: `${buffer.byteLength}_${Date.now()}`,
              size: buffer.byteLength,
              mtime: Date.now()
            };
          }
        }
      } finally {
        plugin.removeIgnoredFile(remote.path);
      }
      if (plugin.syncProgress) plugin.syncProgress.pullCount++;
      if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
    }

    for (const file of localFiles) {
      if (remotePaths.has(file.path)) continue;
      plugin.addIgnoredFile(file.path);
      try {
        await plugin.app.vault.delete(file);
        delete plugin.syncData.files[file.path];
      } finally {
        plugin.removeIgnoredFile(file.path);
      }
    }

    for (const cachedPath of Object.keys(plugin.syncData.files)) {
      if (isPlaintextSyncPath(cachedPath) && !remotePaths.has(cachedPath)) delete plugin.syncData.files[cachedPath];
    }
    plugin.syncData.lastRemoteHeadSha = await getRemoteHeadShaIfAvailable(plugin) ?? plugin.syncData.lastRemoteHeadSha;
    await plugin.saveSyncData();
    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: 0,
        totalPush: 0,
        pullCount: remoteFiles.length,
        totalPull: remoteFiles.length,
        lastSyncTime: Date.now()
      };
    }
    new Notice("Force pull completed");
  } catch (error) {
    console.error("Force pull failed:", error);
    new Notice(`Force pull failed: ${(error as Error).message}`);
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
    plugin.enableWatch();
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

export async function syncAllFilesImpl(plugin: FastSync): Promise<void> {
  if (plugin.settings.encryptionMode === "encrypted") {
    await encryptedFullSync(plugin);
    return;
  }
  if (plugin.isSyncInProgress) {
    new Notice("Sync is already in progress. Please wait.");
    return;
  }
  if (!plugin.githubClient) return;

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
    const allLocalFiles = listPlaintextSyncCandidates(plugin);
    const remoteHeadBeforeSync = await getRemoteHeadShaIfAvailable(plugin);
    if (remoteHeadBeforeSync && plugin.syncData.lastRemoteHeadSha === remoteHeadBeforeSync && plaintextLocalStateMatchesCache(plugin, allLocalFiles)) {
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
      new Notice("Sync skipped: no local or remote changes");
      return;
    }

    const remoteTree = await plugin.githubClient.getTree();
    if (remoteTree.truncated) {
      throw new Error("GitHub tree response was truncated; plaintext sync cannot safely sync this repository.");
    }
    // 过滤 Markdown 和 图片
    const remoteFiles = remoteTree.tree.filter((node: GitHubTreeNode) => {
      const ext = node.path.split(".").pop()?.toLowerCase();
      return node.type === "blob" && (ext === "md" || IMAGE_EXTENSIONS.includes(ext || "")) && !node.path.includes(".sync-conflict-");
    });
    const remoteFilesMap = new Map<string, string>(remoteFiles.map((f: GitHubTreeNode) => [f.path, f.sha] as [string, string]));
    const localFilesMap = new Map<string, TFile>(allLocalFiles.map(f => [f.path, f]));

    if (plugin.syncProgress) plugin.syncProgress.totalPull = remoteFilesMap.size;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();

    // 1. 下拉远端变更
    let step1Count = 0;
    for (const [path, remoteSha] of Array.from(remoteFilesMap.entries())) {
      try {
        const localFile = localFilesMap.get(path);
        const localState = plugin.syncData.files[path];

        const isLocalFileEmpty = localFile && localFile.stat.size === 0;

        if (!localFile || (localState && localState.sha !== remoteSha) || isLocalFileEmpty) {
          if (plugin.syncProgress) plugin.syncProgress.pullCount++;
          if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
          const remoteData = await plugin.githubClient.getFile(path);
          if (remoteData) {
            const ext = path.split(".").pop()?.toLowerCase();
            const isMarkdown = ext === "md";

            plugin.addIgnoredFile(path);

            const folderPath = path.split("/").slice(0, -1).join("/");
            if (folderPath && !plugin.app.vault.getAbstractFileByPath(folderPath)) {
              await plugin.app.vault.createFolder(folderPath);
            }

            let finalContent: string | ArrayBuffer;
            if (!remoteData.content && remoteData.download_url) {
              const downloadRes = await requestUrl({
                url: remoteData.download_url,
                headers: plugin.githubClient.headers
              });
              finalContent = downloadRes.arrayBuffer;
            } else {
              finalContent = remoteData.content;
            }

            if (isMarkdown) {
              const content = typeof finalContent === "string"
                ? GitHubClient.decodeContent(finalContent)
                : new TextDecoder().decode(finalContent);

              if (localFile && localState && localState.hash && localState.hash !== await currentPlaintextHash(plugin, localFile)) {
                await writePlaintextConflictCopy(plugin, path, content);
                plugin.syncData.files[path] = { sha: remoteSha, lastSync: Date.now(), hash: await currentPlaintextHash(plugin, localFile) };
                step1Count++;
                continue;
              }
              if (localFile) await plugin.app.vault.modify(localFile, content);
              else await plugin.app.vault.create(path, content);

              plugin.syncData.files[path] = {
                sha: remoteSha,
                lastSync: Date.now(),
                hash: hashContent(content)
              };
            } else {
              let buffer: ArrayBuffer;
              if (typeof finalContent === "string") {
                buffer = GitHubClient.decodeContentBytes(finalContent).buffer as ArrayBuffer;
              } else {
                buffer = finalContent;
              }

              if (localFile && localState && localState.hash && localState.hash !== await currentPlaintextHash(plugin, localFile)) {
                await writePlaintextConflictCopy(plugin, path, buffer);
                plugin.syncData.files[path] = { sha: remoteSha, lastSync: Date.now(), hash: await currentPlaintextHash(plugin, localFile) };
                step1Count++;
                continue;
              }
              if (localFile) await plugin.app.vault.modifyBinary(localFile, buffer);
              else await plugin.app.vault.createBinary(path, buffer);

              const newlyCreatedFile = plugin.app.vault.getAbstractFileByPath(path);
              if (newlyCreatedFile instanceof TFile) {
                 plugin.syncData.files[path] = {
                   sha: remoteSha,
                   lastSync: Date.now(),
                   hash: newlyCreatedFile.stat.size + "_" + newlyCreatedFile.stat.mtime
                 };
              }
            }
            plugin.removeIgnoredFile(path);
            step1Count++;
          }
        }
      } catch (fileError) {
        // 单个文件失败不中断整个同步
        console.error(`Step1 failed for ${path}:`, fileError);
      }
    }


    // 2. 推送本地文件：新增文件 + 本地内容有变化的已有文件
    let step2Push = 0, step2Skip = 0, step2Fail = 0;
    const candidateFiles = allLocalFiles.filter(file => shouldSyncPlaintextFile(file, plugin));
    if (plugin.syncProgress) plugin.syncProgress.totalPush = candidateFiles.length;
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();

    for (const file of candidateFiles) {
      const isMarkdown = file.extension === "md";

      try {
        const remoteSha = remoteFilesMap.get(file.path);
        const localState = plugin.syncData.files[file.path];

        if (remoteSha && localState?.sha === remoteSha && localState.hash && cachedPlaintextStatMatches(file, localState)) {
          plugin.syncData.files[file.path] = plaintextSyncEntry(remoteSha, file, localState.hash, localState.lastSync ?? Date.now());
          step2Skip++;
          continue;
        }

        // 计算当前内容 hash
        let content: string | ArrayBuffer;
        let currentHash: string;
        if (isMarkdown) {
          content = await readVaultFileText(plugin.app.vault, file);
          currentHash = hashContent(content);
        } else {
          content = await readVaultFileBinary(plugin.app.vault, file);
          currentHash = file.stat.size + "_" + file.stat.mtime;
        }

        if (!remoteSha) {
          // 远端没有 → 新增文件，直接上传
          const newSha = await plugin.githubClient.putFile(file.path, content);
          plugin.syncData.files[file.path] = plaintextSyncEntry(newSha, file, currentHash);
          step2Push++;
        } else if (!localState || localState.hash !== currentHash) {
          // B2: 远端有、但本地内容发生了变化 → 推送本地改动
          const newSha = await plugin.githubClient.putFile(file.path, content, remoteSha);
          plugin.syncData.files[file.path] = plaintextSyncEntry(newSha, file, currentHash);
          step2Push++;
        } else {
          // 两端内容一致，只更新本地 sha 缓存（防止 performSync 重复触发）
          plugin.syncData.files[file.path] = plaintextSyncEntry(remoteSha, file, currentHash, plugin.syncData.files[file.path]?.lastSync ?? Date.now());
          step2Skip++;
        }
      } catch (fileError) {
        // 单个文件失败不中断整个同步
        console.error(`Step2 failed for ${file.path}:`, fileError);
        step2Fail++;
      } finally {
        if (plugin.syncProgress) plugin.syncProgress.pushCount++;
        if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
      }
    }

    plugin.syncData.lastRemoteHeadSha = step2Push === 0 ? (remoteHeadBeforeSync ?? plugin.syncData.lastRemoteHeadSha) : (remoteHeadBeforeSync ? (await getRemoteHeadShaIfAvailable(plugin) ?? plugin.syncData.lastRemoteHeadSha) : plugin.syncData.lastRemoteHeadSha);

    await plugin.saveSyncData();
    new Notice("Sync completed");

    if (plugin.syncProgress) {
      plugin.syncProgress = {
        status: "success",
        pushCount: step2Push,
        totalPush: candidateFiles.length,
        pullCount: step1Count,
        totalPull: remoteFilesMap.size,
        lastSyncTime: Date.now()
      };
    }
  } catch (error) {
    console.error("Sync failed:", error);
    // B3: 同步失败时弹出通知
    new Notice(`❌ Sync failed: ${(error as Error).message}`);
    plugin.syncProgress = {
      status: "fail",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: plugin.syncProgress?.lastSyncTime ?? 0,
      errorMessage: (error as Error).message
    };
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
    if (typeof plugin.updateStatusBar === "function") plugin.updateStatusBar();
  }
}

export const StartupFullNotesSync = (plugin: FastSync): void => {
  void syncAllFilesImpl(plugin);
};
