import { Plugin, setIcon, Modal, Notice, TFile, TFolder, moment } from "obsidian";

import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";
import { GitHubClient } from "./lib/github-api";
import { normalizeScheduledSyncIntervalSeconds, shouldRunScheduledSync, shouldRunStartupSync } from "./lib/sync-policy";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence, storeV4Secrets } from "./lib/v4/secrets";
import { V4PluginRuntime } from "./lib/v4/runtime";
import { V4SyncCenterView, V4_SYNC_CENTER_VIEW } from "./views/sync-center";


export default class FastSync extends Plugin {
  settingTab: SettingTab
  settings: PluginSettings
  githubClient: GitHubClient
  v4Runtime: V4PluginRuntime

  isSyncInProgress: boolean = false
  clipboardReadTip: string = ""

  ribbonIcon: HTMLElement
  statusBarItem: HTMLElement | null = null
  saveNoticeTimeout: number | null = null
  syncProgress: {
    status: "idle" | "pending" | "syncing" | "success" | "fail" | "waiting"
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
  secretsMigrated: boolean = false

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
    await this.loadSettings()
    if (this.secretsMigrated) await this.persistData()

    this.settingTab = new SettingTab(this.app, this)
    this.addSettingTab(this.settingTab)

    this.initGitHubClient()
    this.v4Runtime = new V4PluginRuntime(this)
    this.registerView(V4_SYNC_CENTER_VIEW, leaf => new V4SyncCenterView(leaf, this))
    this.registerScheduledSync()

    // Initialize status bar widget
    this.updateStatusBar()

    // Create Ribbon Icons
    this.ribbonIcon = this.addRibbonIcon("loader-circle", "GitHub Sync: Sync", () => {
      void this.v4Runtime.manualSync()
    })

    this.addRibbonIcon("arrow-up-circle", "GitHub Sync: Force Push", () => {
      void this.showForceConfirm("forcePush")
    })

    this.addRibbonIcon("arrow-down-circle", "GitHub Sync: Force Pull", () => {
      void this.showForceConfirm("forcePull")
    })

    this.addRibbonIcon("history", "GitHub Sync: Open Sync Center", () => {
      void this.openSyncCenter()
    })

    this.updateRibbonIcon(!!(this.settings.githubToken && this.settings.githubOwner && this.settings.githubRepo))

    // Register every vault file event; the V4 scope policy applies exclusions and .obsidian options.
    // Disable watch on startup to prevent vault indexing from triggering many concurrent API calls
    // that could hit the GitHub rate limit (422)
    this.disableWatch()
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.v4Runtime.enqueueModify(file.path, file.stat.mtime)
    }))
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.v4Runtime.enqueueModify(file.path, file.stat.mtime)
    }))
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) this.v4Runtime.enqueueDelete(file.path)
      else if (file instanceof TFolder) this.v4Runtime.enqueueRescan()
    }))
    this.registerEvent(this.app.vault.on("rename", (file, oldfile) => {
      if (file instanceof TFile) this.v4Runtime.enqueueRename(oldfile, file.path)
      else if (file instanceof TFolder) this.v4Runtime.enqueueRescan()
    }))

    // Register commands
    this.addCommand({
      id: "init-all-files",
      name: "GitHub Sync: Force Push (Overwrite Remote)",
      callback: () => void this.showForceConfirm("forcePush"),
    })

    this.addCommand({
      id: "sync-all-files",
      name: "GitHub Sync: Sync",
      callback: () => void this.v4Runtime.manualSync(),
    })

    this.addCommand({
      id: "force-pull-all-files",
      name: "GitHub Sync: Force Pull (Overwrite Local)",
      callback: () => void this.showForceConfirm("forcePull"),
    })

    this.addCommand({
      id: "open-sync-center",
      name: "GitHub Sync: Open Sync Center",
      callback: () => void this.openSyncCenter(),
    })

    // After the workspace layout is ready, run the startup sync once, then enable real-time watch
    this.app.workspace.onLayoutReady(() => {
      if (shouldRunStartupSync(this.settings)) {
        // Delay 1.5 s to let Obsidian finish initialising
        setTimeout(() => {
          void this.v4Runtime.startupSync();
        }, 1500);
      } else {
        // Not configured – enable watch immediately
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
    } else this.githubClient = undefined as unknown as GitHubClient
  }

  onunload() {
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
    this.v4Runtime?.dispose()
  }

  registerScheduledSync() {
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
    if (!shouldRunScheduledSync(this.settings)) return;
    const seconds = normalizeScheduledSyncIntervalSeconds(this.settings.scheduledSyncIntervalSeconds);
    this.scheduledSyncTimer = window.setInterval(() => {
      void this.v4Runtime.scheduledSync()
    }, seconds * 1000);
  }

  updateRibbonIcon(status: boolean) {
    if (status) {
      setIcon(this.ribbonIcon, "rotate-cw")
      this.ribbonIcon.setAttribute("aria-label", "Encrypted GitHub Sync (Multi-Platform): Sync all notes (Configured)")
    } else {
      setIcon(this.ribbonIcon, "loader-circle")
      this.ribbonIcon.setAttribute("aria-label", "Encrypted GitHub Sync (Multi-Platform): Sync all notes (Not Configured)")
    }
  }

  /** Persist only current V4 settings; the V4 local index uses its own sharded adapter storage. */
  async persistData() {
    await this.saveData({
      settings: sanitizeV4SettingsForPersistence(this.settings),
    });
  }

  async openSyncCenter(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(V4_SYNC_CENTER_VIEW)[0]
    const leaf = existing ?? this.app.workspace.getRightLeaf(false)
    if (!leaf) {
      return
    }
    if (!existing) await leaf.setViewState({ type: V4_SYNC_CENTER_VIEW, active: true })
    await this.app.workspace.revealLeaf(leaf)
  }

  private createSecretId(prefix: string): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`
  }

  async loadSettings() {
    const data = await this.loadData() ?? {};
    // Backward compatibility: older versions stored settings fields directly at the top level
    const savedSettings = data.settings ?? data;
    const merged = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    const result = migrateV4Secrets(
      merged,
      this.app.secretStorage,
      prefix => this.createSecretId(prefix),
    )
    this.settings = result.settings as PluginSettings
    this.secretsMigrated = result.migrated
  }

  async saveSettings() {
    storeV4Secrets(this.settings, this.app.secretStorage)
    this.initGitHubClient()
    this.registerScheduledSync()
    this.updateRibbonIcon(!!(this.settings.githubToken && this.settings.githubOwner && this.settings.githubRepo))
    await this.persistData()
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

    if (status === "pending") {
      text = `⏳ GH Sync (queued ${totalPush})`;
      title = `GitHub Sync: ${totalPush} local change(s) queued for the next sync.`;
      cls += " is-syncing";
    } else if (status === "waiting") {
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
        void this.v4Runtime.manualSync()
      }
    };
  }

  async showForceConfirm(operation: "forcePush" | "forcePull"): Promise<void> {
    await new Promise<void>((resolve) => {
      const modal = new Modal(this.app)
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      modal.onClose = finish
      const repo = `${this.settings.githubOwner}/${this.settings.githubRepo}`
      const branch = this.settings.githubBranch || "main"
      const localFileCount = this.app.vault.getFiles().filter(file => !file.path.startsWith(`${this.app.vault.configDir}/`)).length

      const title = operation === "forcePush" ? "Force push local vault to remote?" : "Force pull remote vault to local?";
      const message = operation === "forcePush"
        ? "Make the remote repository exactly match this local vault. Remote files not present locally will be deleted."
        : "Make this local vault exactly match the remote repository. Local synced files not present remotely will be deleted.";

      modal.titleEl.setText(title)
      modal.contentEl.createEl("p", { text: message })
      modal.contentEl.createEl("p", { text: `Repository: ${repo}` })
      modal.contentEl.createEl("p", { text: `Branch: ${branch}` })
      modal.contentEl.createEl("p", { text: `Local vault files: ${localFileCount}` })
      modal.contentEl.createEl("p", { text: "Drag the confirmation control fully to the right, then click the unlocked action button." })

      const slider = modal.contentEl.createDiv({ cls: "github-sync-force-confirm-slider" })
      const fill = slider.createDiv({ cls: "github-sync-force-confirm-fill" })
      const handle = slider.createDiv({ cls: "github-sync-force-confirm-handle" })
      const sliderLabel = handle.createEl("span", { text: operation === "forcePush" ? "Slide to unlock force push" : "Slide to unlock force pull" })
      const unlockMessage = modal.contentEl.createEl("p", { text: "Unlocked. Review the target above, then click the force action button." })
      unlockMessage.addClass("github-sync-force-confirm-unlocked")
      unlockMessage.style.display = "none"

      const buttons = modal.contentEl.createDiv()
      buttons.createEl("button", { text: "Cancel" }).onclick = () => {
        modal.close()
        finish()
      }
      const confirmButton = buttons.createEl("button", { text: operation === "forcePush" ? "Force push" : "Force pull" })
      confirmButton.addClass("mod-warning")
      confirmButton.style.display = "none"

      let dragging = false
      let unlocked = false
      let resolved = false
      const resetSlider = () => {
        fill.style.width = "0%"
        handle.style.transform = "translateX(0)"
      }
      const unlockConfirmButton = () => {
        if (unlocked) return
        unlocked = true
        fill.style.width = "100%"
        slider.addClass("is-complete")
        sliderLabel.setText("Unlocked")
        confirmButton.style.display = ""
        unlockMessage.style.display = ""
      }
      const runConfirmedOperation = () => {
        if (resolved || !unlocked) return
        resolved = true
        modal.close()
        if (operation === "forcePush") void this.v4Runtime.forcePush()
        else void this.v4Runtime.forcePull()
        finish()
      }
      confirmButton.onclick = runConfirmedOperation
      const setProgress = (clientX: number) => {
        const rect = slider.getBoundingClientRect()
        const progress = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
        fill.style.width = `${progress * 100}%`
        handle.style.transform = `translateX(${progress * Math.max(0, rect.width - handle.offsetWidth)}px)`
        if (progress >= 0.97) unlockConfirmButton()
      }
      slider.onpointerdown = (event: PointerEvent) => {
        if (unlocked) return
        dragging = true
        slider.setPointerCapture?.(event.pointerId)
        setProgress(event.clientX)
      }
      slider.onpointermove = (event: PointerEvent) => {
        if (dragging && !unlocked) setProgress(event.clientX)
      }
      slider.onpointerup = (event: PointerEvent) => {
        if (!dragging) return
        dragging = false
        slider.releasePointerCapture?.(event.pointerId)
        if (!unlocked) resetSlider()
      }
      slider.onpointercancel = () => {
        dragging = false
        if (!unlocked) resetSlider()
      }
      modal.open()
    })
  }
}
