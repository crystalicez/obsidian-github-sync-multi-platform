import { Plugin, setIcon, Modal, Notice, TFile } from "obsidian";

import { NoteModify, NoteDelete, NoteRename, StartupFullNotesForceOverSync, StartupFullNotesSync, overrideLocalAllFilesImpl } from "./lib/fs";
import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";
import { GitHubClient } from "./lib/github-api";
import { $, moment } from "./lang/lang";
import { calculateWordCount } from "./lib/helps";
import { encryptedForcePush, encryptedForcePull } from "./lib/encrypted/sync-engine";
import type { EncryptedLocalFileState } from "./lib/encrypted/types";
import { normalizeScheduledSyncIntervalSeconds, shouldRunScheduledSync, shouldRunStartupSync } from "./lib/encrypted/settings-policy";


interface SyncSkipFiles {
  [key: string]: string
}
interface EditorChangeTimeout {
  [key: string]: unknown
}

export interface FileState {
  sha: string;
  lastSync: number;
  hash?: string; // Cache the content hash
  size?: number;
  mtime?: number;
}

export interface SyncData {
  files: { [path: string]: FileState };
  lastRemoteHeadSha?: string;
  encrypted?: {
    files: { [path: string]: EncryptedLocalFileState };
    manifestSha?: string;
  };
}

export default class FastSync extends Plugin {
  settingTab: SettingTab
  settings: PluginSettings
  githubClient: GitHubClient
  syncData: SyncData = { files: {} }
  
  isSyncInProgress: boolean = false
  debounceTimers: Map<string, number> = new Map()
  
  syncSkipFiles: SyncSkipFiles = {}
  syncSkipDelFiles: SyncSkipFiles = {}
  syncSkipModifyFiles: SyncSkipFiles = {}
  clipboardReadTip: string = ""

  editorChangeTimeout: EditorChangeTimeout = {}

  ribbonIcon: HTMLElement
  ribbonIconStatus: boolean = false
  statusBarItem: HTMLElement | null = null
  saveNoticeTimeout: number | null = null
  syncProgress: {
    status: "idle" | "syncing" | "success" | "fail" | "waiting"
    pushCount: number
    totalPush: number
    pullCount: number
    totalPull: number
    lastSyncTime: number
    errorMessage?: string
  } = {
    status: "idle",
    pushCount: 0,
    totalPush: 0,
    pullCount: 0,
    totalPull: 0,
    lastSyncTime: 0
  }

  isWatchEnabled: boolean = true
  ignoredFiles: Set<string> = new Set()
  scheduledSyncTimer: number | null = null

  enableWatch() {
    this.isWatchEnabled = true
  }

  disableWatch() {
    this.isWatchEnabled = false
  }

  addIgnoredFile(path: string) {
    this.ignoredFiles.add(path)
  }

  removeIgnoredFile(path: string) {
    this.ignoredFiles.delete(path)
  }


  async onload() {
    this.syncSkipFiles = {}

    await this.loadSettings()
    await this.loadSyncData()
    
    this.settingTab = new SettingTab(this.app, this)
    this.addSettingTab(this.settingTab)
    
    this.initGitHubClient()
    this.registerScheduledSync()

    // Initialize status bar widget
    this.updateStatusBar()

    // Create Ribbon Icons
    this.ribbonIcon = this.addRibbonIcon("loader-circle", "GitHub Sync: Sync", () => {
      StartupFullNotesSync(this)
    })

    this.addRibbonIcon("arrow-up-circle", "GitHub Sync: Force Push", () => {
      void this.showForceConfirm("forcePush")
    })

    this.addRibbonIcon("arrow-down-circle", "GitHub Sync: Force Pull", () => {
      void this.showForceConfirm("forcePull")
    })

    this.updateRibbonIcon(!!(this.settings.githubToken && this.settings.githubOwner && this.settings.githubRepo))

    // 注册文件事件（只监听 md 和图片，过滤其他类型在 performSync 内完成）
    // 启动时先禁用 watch，防止 vault 索引触发大量文件事件并发打 API 被 GitHub 限速（422）
    this.disableWatch()
    this.registerEvent(this.app.vault.on("create", (file) => NoteModify(file, this, true)))
    this.registerEvent(this.app.vault.on("modify", (file) => NoteModify(file, this, true)))
    this.registerEvent(this.app.vault.on("delete", (file) => NoteDelete(file, this, true)))
    this.registerEvent(this.app.vault.on("rename", (file, oldfile) => NoteRename(file, oldfile, this, true)))

    // 注册命令
    this.addCommand({
      id: "init-all-files",
      name: "GitHub Sync: Force Push (Overwrite Remote)",
      callback: () => StartupFullNotesForceOverSync(this),
    })

    this.addCommand({
      id: "sync-all-files",
      name: "GitHub Sync: Sync",
      callback: () => StartupFullNotesSync(this),
    })

    // 布局加载完成后统一执行启动同步，完成后再开启实时 watch
    this.app.workspace.onLayoutReady(() => {
      if (shouldRunStartupSync(this.settings)) {
        // 延迟 1.5 秒，等待 Obsidian 初始化完成
        setTimeout(() => {
          // syncAllFilesImpl 内部完成后会调用 enableWatch()
          StartupFullNotesSync(this);
        }, 1500);
      } else {
        // 未配置则直接开启 watch
        this.enableWatch();
      }
    });
  }

  initGitHubClient() {
    if (this.settings.githubToken && this.settings.githubOwner && this.settings.githubRepo) {
      this.githubClient = new GitHubClient({
        token: this.settings.githubToken,
        owner: this.settings.githubOwner,
        repo: this.settings.githubRepo,
        branch: this.settings.githubBranch || "main",
      });
    }
  }

  onunload() {
    // 清理所有防抖计时器，防止插件卸载后仍有回调触发（内存泄漏）
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
  }

  registerScheduledSync() {
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
    if (!shouldRunScheduledSync(this.settings)) return;
    const seconds = normalizeScheduledSyncIntervalSeconds(this.settings.scheduledSyncIntervalSeconds);
    this.scheduledSyncTimer = window.setInterval(() => {
      if (!this.isSyncInProgress) StartupFullNotesSync(this);
    }, seconds * 1000);
  }

  updateRibbonIcon(status: boolean) {
    if (status) {
      setIcon(this.ribbonIcon, "rotate-cw")
      this.ribbonIcon.setAttribute("aria-label", "Encrypted GitHub Sync (Multi-Platform): " + $("同步全部笔记") + " (Configured)")
    } else {
      setIcon(this.ribbonIcon, "loader-circle")
      this.ribbonIcon.setAttribute("aria-label", "Encrypted GitHub Sync (Multi-Platform): " + $("同步全部笔记") + " (Not Configured)")
    }
  }

  /**
   * 统一持久化入口：settings 和 syncData 始终存储在同一个对象中，
   * 避免 saveSettings / saveSyncData 互相覆盖对方的数据。
   */
  async persistData() {
    await this.saveData({
      settings: this.settings,
      syncData: this.syncData,
    });
  }

  async loadSettings() {
    const data = await this.loadData() ?? {};
    // 兼容旧版本：旧版直接把 settings 字段铺在顶层
    const savedSettings = data.settings ?? data;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
  }

  async saveSettings() {
    this.initGitHubClient()
    this.registerScheduledSync()
    this.updateRibbonIcon(!!(this.settings.githubToken && this.settings.githubOwner && this.settings.githubRepo))
    this.registerScheduledSync()
    await this.persistData()
  }

  async loadSyncData() {
    const data = await this.loadData() ?? {};
    this.syncData = data.syncData ?? { files: {} };
    if (!this.syncData.encrypted) this.syncData.encrypted = { files: {} };
  }

  async saveSyncData() {
    await this.persistData();
  }

  async updateStats() {
    if (this.settings.encryptionMode === "encrypted") return;
    if (!this.githubClient) return;

    const stats: { [month: string]: number } = {};
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const wordCount = calculateWordCount(content);
      const month = moment(file.stat.mtime).format("YYYY-MM");
      stats[month] = (stats[month] || 0) + wordCount;
    }

    const statsJson = JSON.stringify({
      lastUpdate: Date.now(),
      monthlyStats: stats
    }, null, 2);

    const path = `${this.app.vault.configDir}/sync-stats.json`;
    try {
      const existingSha = this.syncData.files[path]?.sha;
      const newSha = await this.githubClient.putFile(path, statsJson, existingSha);
      this.syncData.files[path] = {
        sha: newSha,
        lastSync: Date.now()
      };
      await this.saveSyncData();
    } catch (e) {
      console.error("Failed to update stats on GitHub", e);
    }
  }

  showSavedFeedback() {
    if (this.saveNoticeTimeout) window.clearTimeout(this.saveNoticeTimeout);
    this.saveNoticeTimeout = window.setTimeout(() => {
      new Notice("GitHub Sync: Settings saved");
    }, 800);
  }

  updateStatusBar() {
    if (!this.settings.statusBarStatusEnabled) {
      if (this.statusBarItem) {
        this.statusBarItem.remove();
        this.statusBarItem = null;
      }
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
    }
    this.statusBarItem.empty();

    const { status, pushCount, totalPush, pullCount, totalPull, lastSyncTime, errorMessage } = this.syncProgress;
    let text = "";
    let title = "";
    let cls = "github-sync-status-bar";

    if (status === "waiting") {
      text = `⏳ GH Sync (waiting...)`;
      title = "GitHub Sync: Waiting for local changes to settle...";
      cls += " is-syncing";
    } else if (this.isSyncInProgress || status === "syncing") {
      text = `⏳ GH Sync: ↑${pushCount}/${totalPush} ↓${pullCount}/${totalPull}`;
      title = "GitHub Sync: Syncing in progress...";
      cls += " is-syncing";
    } else if (status === "success") {
      const timeStr = moment(lastSyncTime || Date.now()).format("HH:mm:ss");
      const relativeTime = lastSyncTime ? moment(lastSyncTime).fromNow() : "just now";
      text = `🟢 GH Sync (${relativeTime})`;
      title = `GitHub Sync: Sync completed successfully at ${timeStr}.`;
    } else if (status === "fail") {
      text = "🔴 GH Sync (Failed)";
      title = `GitHub Sync: Last sync failed. Error: ${errorMessage || "Unknown error"}`;
    } else {
      const timeStr = lastSyncTime ? moment(lastSyncTime).format("HH:mm:ss") : "Never";
      const relativeTime = lastSyncTime ? moment(lastSyncTime).fromNow() : "Never";
      text = `🟢 GH Sync (${relativeTime})`;
      title = `GitHub Sync: Idle. Last sync: ${timeStr}.`;
    }

    const span = this.statusBarItem.createEl("span", { text, cls });
    span.title = title;
    span.onclick = () => {
      if (!this.isSyncInProgress) {
        StartupFullNotesSync(this);
      }
    };
  }

  async showForceConfirm(operation: "forcePush" | "forcePull"): Promise<void> {
    await new Promise<void>((resolve) => {
      const modal = new Modal(this.app)
      const repo = `${this.settings.githubOwner}/${this.settings.githubRepo}`
      const branch = this.settings.githubBranch || "main"
      const localFileCount = this.app.vault.getFiles().filter(file => !file.path.startsWith(`${this.app.vault.configDir}/`)).length
      const confirmPhrase = `${operation === "forcePush" ? "push" : "pull"} ${repo} ${branch}`
      
      const title = operation === "forcePush" ? "Force push local vault to remote?" : "Force pull remote vault to local?";
      const message = operation === "forcePush" 
        ? "Overwrite the remote state with this local vault. Remote files not present locally may be deleted." 
        : "Overwrite this local vault with the remote state. Local synced files not present remotely will be deleted.";

      modal.titleEl.setText(title)
      modal.contentEl.createEl("p", { text: message })
      modal.contentEl.createEl("p", { text: `Repository: ${repo}` })
      modal.contentEl.createEl("p", { text: `Branch: ${branch}` })
      modal.contentEl.createEl("p", { text: `Local vault files: ${localFileCount}` })
      modal.contentEl.createEl("p", { text: `Type "${confirmPhrase}" to confirm.` })
      
      const input = modal.contentEl.createEl("input")
      input.type = "text"
      input.placeholder = confirmPhrase
      
      const buttons = modal.contentEl.createDiv()
      buttons.createEl("button", { text: "Cancel" }).onclick = () => {
        modal.close()
        resolve()
      }
      
      const confirmButton = buttons.createEl("button", { text: operation === "forcePush" ? "Force push" : "Force pull" })
      confirmButton.addClass("mod-warning")
      confirmButton.disabled = true
      
      input.oninput = () => {
        confirmButton.disabled = input.value.trim() !== confirmPhrase
      }
      
      confirmButton.onclick = () => {
        if (input.value.trim() !== confirmPhrase) return
        modal.close()
        if (this.settings.encryptionMode === "encrypted") {
          if (operation === "forcePush") void encryptedForcePush(this)
          else void encryptedForcePull(this)
        } else {
          if (operation === "forcePush") void StartupFullNotesForceOverSync(this)
          else void overrideLocalAllFilesImpl(this)
        }
        resolve()
      }
      modal.open()
    })
  }
}
