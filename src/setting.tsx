import { App, PluginSettingTab, Notice, Setting, Platform } from "obsidian";
import { KofiImage } from "./lib/icons";

import FastSync from "./main";
import { dump } from "./lib/helps";
import { createDebugPayload } from "./lib/debug";

export interface PluginSettings {
  // Whether auto-upload is enabled
  syncEnabled: boolean
  // GitHub configuration
  githubOwner: string
  githubRepo: string
  githubBranch: string
  githubToken: string
  githubTokenSecretId: string
  encryptionMode: "plaintext" | "encrypted"
  encryptionPassphrase: string
  encryptionPassphraseSecretId: string
  syncOnStartup: boolean
  syncOnLocalChange: boolean
  scheduledSyncEnabled: boolean
  scheduledSyncIntervalSeconds: number
  ignorePathRegex: string
  syncObsidianConfig: boolean
  syncBookmarks: boolean
  syncPlugins: boolean
  abortChangePercent: number
  conflictPolicy: "copy" | "newer" | "merge" | "ask"
  statusBarStatusEnabled: boolean
  consoleLoggingEnabled: boolean

  vault: string
  lastSyncTime: number
  clipboardReadTip: string
}

/**
 * @see https://github.com/settings/tokens for PAT setup
 */

// Default plugin settings
export const DEFAULT_SETTINGS: PluginSettings = {
  // Whether auto-upload is enabled
  syncEnabled: true,
  // GitHub defaults
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubToken: "",
  githubTokenSecretId: "",
  encryptionMode: "plaintext",
  encryptionPassphrase: "",
  encryptionPassphraseSecretId: "",
  syncOnStartup: true,
  syncOnLocalChange: true,
  scheduledSyncEnabled: false,
  scheduledSyncIntervalSeconds: 300,
  ignorePathRegex: "",
  syncObsidianConfig: false,
  syncBookmarks: false,
  syncPlugins: false,
  abortChangePercent: 0,
  conflictPolicy: "copy",
  lastSyncTime: 0,
  vault: "defaultVault",
  statusBarStatusEnabled: true,
  consoleLoggingEnabled: false,
  // Clipboard read tip message
  clipboardReadTip: "",
}

export class SettingTab extends PluginSettingTab {
  plugin: FastSync
  tempSettings: PluginSettings | null = null
  bannerEl: HTMLElement | null = null

  constructor(app: App, plugin: FastSync) {
    super(app, plugin)
    this.plugin = plugin
    this.plugin.clipboardReadTip = ""
  }

  isDirty(): boolean {
    if (!this.tempSettings) return false
    return JSON.stringify(this.tempSettings) !== JSON.stringify(this.plugin.settings)
  }

  updateDirtyState(): void {
    if (!this.bannerEl) return
    this.bannerEl.empty()
    if (this.isDirty()) {
      this.bannerEl.addClass("is-dirty")
      const banner = this.bannerEl.createDiv("github-sync-settings-dirty-banner")
      banner.createEl("span", { text: "You have unsaved changes!", cls: "github-sync-settings-dirty-text" })
      
      const btnContainer = banner.createDiv("github-sync-settings-dirty-buttons")
      const saveBtn = btnContainer.createEl("button", { text: "Save changes", cls: "mod-cta" })
      saveBtn.onclick = async () => {
        if (this.tempSettings) {
          this.plugin.settings = JSON.parse(JSON.stringify(this.tempSettings))
          await this.plugin.saveSettings()
          this.plugin.initGitHubClient()
          this.plugin.updateStatusBar()
          new Notice("GitHub Sync: Settings saved")
          this.display()
        }
      }

      const discardBtn = btnContainer.createEl("button", { text: "Discard", cls: "mod-warning" })
      discardBtn.onclick = () => {
        this.tempSettings = JSON.parse(JSON.stringify(this.plugin.settings))
        this.display()
      }
    } else {
      this.bannerEl.removeClass("is-dirty")
    }
  }

  hide(): void {
    this.tempSettings = null
  }

  /**
   * Read GitHub configuration JSON from the clipboard and populate settings automatically
   */
  async handleClipboardPaste(tipEl: HTMLElement): Promise<void> {
    const showTip = (msg: string) => {
      tipEl.setText(msg)
      setTimeout(() => tipEl.setText(""), 2000)
    }

    try {
      if (!navigator.clipboard) {
        showTip("No configuration detected!")
        return
      }
      const text = await navigator.clipboard.readText()
      const parsed = JSON.parse(text)
      if (typeof parsed === "object" && parsed !== null) {
        const hasOwner = "githubOwner" in parsed || "owner" in parsed
        const hasRepo = "githubRepo" in parsed || "repo" in parsed
        const hasToken = "githubToken" in parsed || "token" in parsed
        if (hasOwner && hasRepo && hasToken) {
          if (this.tempSettings) {
            this.tempSettings.githubOwner = parsed.githubOwner || parsed.owner
            this.tempSettings.githubRepo = parsed.githubRepo || parsed.repo
            this.tempSettings.githubBranch = parsed.githubBranch || parsed.branch || "main"
            this.tempSettings.githubToken = parsed.githubToken || parsed.token
          }
          this.display()
          showTip("Configuration pasted into settings!")
          return
        }
      }
      showTip("No configuration detected!")
    } catch (err) {
      dump(err)
      showTip("No configuration detected!")
    }
  }

  display(): void {
    const { containerEl: set } = this

    set.empty()

    if (!this.tempSettings) {
      this.tempSettings = JSON.parse(JSON.stringify(this.plugin.settings))
    }

    this.bannerEl = set.createDiv()
    this.updateDirtyState()

    // ==========================================
    // Section 1: General Settings
    // ==========================================
    new Setting(set)
      .setName("General Settings")
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Enable synchronization")
      .setDesc("After closing, your notes will not be synced.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncEnabled).onChange((value) => {
          this.tempSettings!.syncEnabled = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Show sync status in status bar")
      .setDesc("Display real-time sync progress, last sync time, or errors in the Obsidian status bar. Disable (kill-switch) to save system resources.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.statusBarStatusEnabled).onChange((value) => {
          this.tempSettings!.statusBarStatusEnabled = value
          this.updateDirtyState()
        })
      )

    // ==========================================
    // Section 2: GitHub Connection Settings
    // ==========================================
    new Setting(set)
      .setName("GitHub Connection Settings")
      .setHeading()
      .setClass("github-sync-settings-header")

    const apiInfoDiv = set.createDiv("obsidian-github-sync-multi-platform-settings")
    const table = apiInfoDiv.createEl("table", { cls: "obsidian-github-sync-multi-platform-settings-openapi" })
    const thead = table.createEl("thead")
    const headerRow = thead.createEl("tr")
    headerRow.createEl("th", { text: "Method" })
    headerRow.createEl("th", { text: "Description" })
    headerRow.createEl("th", { text: "Details" })
    const tbody = table.createEl("tbody")
    const row = tbody.createEl("tr")
    row.createEl("td", { text: "GitHub" })
    row.createEl("td", { text: "Use a GitHub repository to store and sync notes" })
    const linkTd = row.createEl("td")
    linkTd.createEl("a", { text: "GitHub PAT Settings", href: "https://github.com/settings/tokens" })

    const clipboardDiv = set.createDiv("clipboard-read")
    const clipboardBtn = clipboardDiv.createEl("button", {
      text: "Paste remote configuration",
      cls: "clipboard-read-button"
    })
    const clipboardTip = clipboardDiv.createEl("div", { cls: "clipboard-read-description" })
    clipboardTip.setText(this.plugin.clipboardReadTip)
    clipboardBtn.addEventListener("click", () => {
      void this.handleClipboardPaste(clipboardTip)
    })

    new Setting(set)
      .setName("GitHub owner")
      .setDesc("Enter your GitHub username or organization name")
      .addText((text) =>
        text
          .setPlaceholder("Enter your GitHub username or organization name")
          .setValue(this.tempSettings!.githubOwner)
          .onChange((value) => {
            this.tempSettings!.githubOwner = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName("GitHub repo")
      .setDesc("Enter your GitHub repository name")
      .addText((text) =>
        text
          .setPlaceholder("Enter your GitHub repository name")
          .setValue(this.tempSettings!.githubRepo)
          .onChange((value) => {
            this.tempSettings!.githubRepo = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName("GitHub branch")
      .setDesc("Enter your GitHub branch name (e.g., main)")
      .addText((text) =>
        text
          .setPlaceholder("Enter your GitHub branch name (e.g., main)")
          .setValue(this.tempSettings!.githubBranch)
          .onChange((value) => {
            this.tempSettings!.githubBranch = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName("GitHub token")
      .setDesc("Personal Access Token used to access the GitHub API")
      .addText((text) => {
        text.inputEl.type = "password"
        text
          .setPlaceholder("Enter your GitHub personal access token")
          .setValue(this.tempSettings!.githubToken)
          .onChange((value) => {
            this.tempSettings!.githubToken = value
            this.updateDirtyState()
          })
      })

    new Setting(set)
      .setName("Remote repository name")
      .setDesc("Remote repository name")
      .addText((text) =>
        text
          .setPlaceholder("Remote repository name")
          .setValue(this.tempSettings!.vault)
          .onChange((value) => {
            this.tempSettings!.vault = value
            this.updateDirtyState()
          })
      )

    // ==========================================
    // Section 3: Encryption Settings
    // ==========================================
    new Setting(set)
      .setName("Encryption Settings")
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Encrypted sync")
      .setDesc("Encrypted mode hides directory names, filenames, extensions, and content behind stable opaque objects.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.encryptionMode === "encrypted").onChange((value) => {
          this.tempSettings!.encryptionMode = value ? "encrypted" : "plaintext"
          this.display()
        })
      )

    if (this.tempSettings!.encryptionMode === "encrypted") {
      new Setting(set)
        .setName("Encryption passphrase")
        .setDesc("Enter the same passphrase on every device. Losing it means the encrypted repo cannot be decrypted.")
        .addText((text) => {
          text.inputEl.type = "password"
          text.setValue(this.tempSettings!.encryptionPassphrase).onChange((value) => {
            this.tempSettings!.encryptionPassphrase = value
            this.updateDirtyState()
          })
        })
    }

    // ==========================================
    // Section 4: Manual & Force Operations
    // ==========================================
    new Setting(set)
      .setName("Manual & Force Operations")
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Manual sync")
      .setDesc("Pull remote changes, resolve conflicts, then push only the required local changes.")
      .addButton((button) =>
        button.setButtonText("Sync now").onClick(() => {
          void this.plugin.v4Runtime.manualSync()
        })
      )

    new Setting(set)
      .setName("Force push local to remote")
      .setDesc("Overwrite the remote state with this local vault.")
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Force push")
          .onClick(() => void this.plugin.showForceConfirm("forcePush"))
      )

    new Setting(set)
      .setName("Force pull remote to local")
      .setDesc("Overwrite this local vault with the remote state.")
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Force pull")
          .onClick(() => void this.plugin.showForceConfirm("forcePull"))
      )

    // ==========================================
    // Section 5: Automation & Exclusions
    // ==========================================
    new Setting(set)
      .setName("Automation & Exclusions")
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Sync when Obsidian opens")
      .setDesc("Run sync after the workspace is ready.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncOnStartup).onChange((value) => {
          this.tempSettings!.syncOnStartup = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Sync when local files change")
      .setDesc("Sync when a local file is created, modified, deleted, or renamed.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncOnLocalChange).onChange((value) => {
          this.tempSettings!.syncOnLocalChange = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Scheduled sync")
      .setDesc("Run sync repeatedly at the configured interval.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.scheduledSyncEnabled).onChange((value) => {
          this.tempSettings!.scheduledSyncEnabled = value
          this.display()
        })
      )

    if (this.tempSettings!.scheduledSyncEnabled) {
      new Setting(set)
        .setName("Scheduled sync interval")
        .setDesc("Interval in seconds between scheduled sync attempts (minimum 30 seconds).")
        .addText((text) =>
          text
            .setPlaceholder("300")
            .setValue(String(this.tempSettings!.scheduledSyncIntervalSeconds))
            .onChange((value) => {
              const seconds = Number(value)
              this.tempSettings!.scheduledSyncIntervalSeconds =
                Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 300
              this.updateDirtyState()
            })
        )
    }

    new Setting(set)
      .setName("Regex of path to ignore")
      .setDesc(
        "One regex per line, matched against plaintext vault paths before encryption. Examples: ^Archive/ ignores a folder, (^|/)\\.DS_Store$ ignores .DS_Store, \\.tmp$ ignores .tmp files."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("^Archive/\n(^|/)\\.DS_Store$\n\\.tmp$")
          .setValue(this.tempSettings!.ignorePathRegex)
          .onChange((value) => {
            this.tempSettings!.ignorePathRegex = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName("Sync .obsidian configuration")
      .setDesc("Sync eligible files in .obsidian. The sync plugin's own directory is always excluded.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncObsidianConfig).onChange((value) => {
          this.tempSettings!.syncObsidianConfig = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Sync bookmarks")
      .setDesc("Sync .obsidian/bookmarks.json independently of the other .obsidian settings.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncBookmarks).onChange((value) => {
          this.tempSettings!.syncBookmarks = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Sync installed plugins")
      .setDesc("Sync other .obsidian/plugins directories. In plaintext mode these files and settings are visible in GitHub.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncPlugins).onChange((value) => {
          this.tempSettings!.syncPlugins = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName("Abort when too many files change")
      .setDesc("Abort any sync when changed logical files exceed this percentage (1–100). Use 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.tempSettings!.abortChangePercent))
          .onChange((value) => {
            const parsed = Number(value)
            this.tempSettings!.abortChangePercent = Number.isFinite(parsed)
              ? Math.max(0, Math.min(100, Math.floor(parsed)))
              : 0
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName("File conflict policy")
      .setDesc("Choose what to do when both local and remote changed since last sync.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("copy", "Copy policy")
          .addOption("newer", "Newer")
          .addOption("merge", "Merge text")
          .addOption("ask", "Always ask")
          .setValue(this.tempSettings!.conflictPolicy)
          .onChange((value) => {
            this.tempSettings!.conflictPolicy = value as "copy" | "newer" | "merge" | "ask"
            this.updateDirtyState()
          })
      )

    // ==========================================
    // Section 6: Support & Debug
    // ==========================================
    new Setting(set)
      .setName("Support & Debug")
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Verbose console logging")
      .setDesc("Log sync info, debug details, and warnings to the Obsidian developer console. Secrets are hidden before logging.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.consoleLoggingEnabled).onChange((value) => {
          this.tempSettings!.consoleLoggingEnabled = value
          this.updateDirtyState()
        })
      )

    const debugDiv = set.createDiv()
    debugDiv.addClass("obsidian-github-sync-multi-platform-settings-debug")

    const debugButton = debugDiv.createEl("button")
    debugButton.setText("Copy debug information")
    debugButton.onclick = async () => {
      await window.navigator.clipboard.writeText(
        JSON.stringify(
          createDebugPayload(
            this.plugin.settings as unknown as Record<string, unknown>,
            this.plugin.manifest.version
          ),
          null,
          4
        )
      )
      new Notice("Copy debug information to the clipboard, may contain sensitive information!")
    }

    if (Platform.isDesktopApp) {
      const info = debugDiv.createDiv()
      info.setText("Open the console with the shortcut key to see this plugin's logs and other plugin logs.")

      const keys = debugDiv.createDiv()
      keys.addClass("custom-shortcuts")
      if (Platform.isMacOS === true) {
        keys.createEl("kbd", { text: "Cmd (⌘) + option (⌥) + i" })
      } else {
        keys.createEl("kbd", { text: "Ctrl (⌃) + shift (⇧) + i" })
      }
    }

    const supportDiv = set.createDiv("github-sync-support-section")

    new Setting(supportDiv).setName("Donation").setHeading()

    supportDiv.createEl("p", {
      text: "If you like this plugin, please consider donating to support continued development."
    })

    const kofiLink = supportDiv.createEl("a", {
      href: "https://ko-fi.com/thiter",
    })
    const kofiImg = kofiLink.createEl("img", { cls: "kofi-img" })
    kofiImg.src = KofiImage
  }
}
