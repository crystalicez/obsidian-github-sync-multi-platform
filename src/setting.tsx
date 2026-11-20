import { App, PluginSettingTab, Notice, Setting, Platform } from "obsidian";
import { KofiImage } from "./lib/icons";
import { GitHubClient } from "./lib/github-api";
import { decodeV4RemoteConfig, decodeV4RemoteHead } from "./lib/v4/remote-index";
import { V4_CONFIG_PATH, V4_HEAD_PATH, effectiveV4PathLayout, expectedV4PathLayout } from "./lib/v4/protocol-types";

import FastSync from "./main";
import { assertPluginSettingsRuntimeSafe } from "./lib/plugin-settings-validation";
import { createDebugPayload } from "./lib/debug";
import { V4_NETWORK_VAULT_WARNING } from "./lib/v4/network-storage";
import { V4_DEFAULT_PBKDF2_ITERATIONS, V4_MAX_PBKDF2_ITERATIONS, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./lib/v4/kdf-policy";

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
  /** Applies only when initializing a new encrypted V4 repository. */
  newVaultKdfIterations: number
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
  newVaultKdfIterations: V4_DEFAULT_PBKDF2_ITERATIONS,
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
  private settingsSavePending = false
  private connectionCheckGeneration = 0
  private connectionCheckBusy = false
  private connectionCheckResult = ""
  private connectionCheckMessageEl: HTMLElement | null = null
  private connectionCheckButton: { setDisabled(disabled: boolean): unknown } | null = null
  private connectionCheckFields: Readonly<{
    owner: string; repo: string; branch: string; token: string; mode: PluginSettings["encryptionMode"]
  }> | null = null

  private matchesConnectionCheck(fields: NonNullable<SettingTab["connectionCheckFields"]>): boolean {
    const current = this.tempSettings
    return !!current && current.githubOwner === fields.owner
      && current.githubRepo === fields.repo && current.githubBranch === fields.branch
      && current.githubToken === fields.token && current.encryptionMode === fields.mode
  }

  private async existingBranchCheckResult(bytes: Uint8Array | undefined, fields: NonNullable<SettingTab["connectionCheckFields"]>, github: GitHubClient): Promise<string> {
    if (!bytes) {
      return "Existing branch has no V4 configuration. Normal Sync will not overwrite unrelated history. Choose a new empty branch in Settings."
    }
    let remote
    try {
      remote = decodeV4RemoteConfig(bytes)
    } catch {
      return "Existing branch has an invalid or unsupported V4 configuration. Choose a new empty branch in Settings; do not overwrite it."
    }
    if (remote.repoId !== `${fields.owner}/${fields.repo}#${fields.branch}`) {
      return "Existing V4 branch has a different repository identity. Check owner, repository and branch, or choose a new empty branch."
    }
    if (remote.mode !== fields.mode) {
      return `Existing V4 branch uses ${remote.mode} storage, but Settings use ${fields.mode}. Select the matching mode or a new empty branch.`
    }
    if (effectiveV4PathLayout(remote) !== expectedV4PathLayout(remote.mode)) {
      return "Existing V4 branch uses an older path layout. Choose a new empty branch instead of starting normal Sync."
    }
    const head = await github.getFileBytes(V4_HEAD_PATH, fields.branch)
    if (!head) {
      return "Existing V4 branch is incomplete: required V4 head metadata is missing. Use a new empty branch in Settings or restore this branch from a backup; do not Force Push."
    }
    if (remote.mode === "plaintext") {
      try {
        await decodeV4RemoteHead(head.bytes, remote)
      } catch {
        return "Existing V4 branch has invalid head metadata. Use a new empty branch in Settings or restore this branch from a backup; do not Force Push."
      }
    }
    return "Repository and branch are accessible with matching V4 configuration and head metadata. Save changes to use this configuration. This read-only check has not verified write permission, encrypted HEAD integrity or the passphrase."
  }

  private async testGitHubConnection(): Promise<void> {
    if (!this.tempSettings || this.connectionCheckBusy) return
    const fields = {
      owner: this.tempSettings.githubOwner,
      repo: this.tempSettings.githubRepo,
      branch: this.tempSettings.githubBranch,
      token: this.tempSettings.githubToken,
      mode: this.tempSettings.encryptionMode,
    }
    const generation = ++this.connectionCheckGeneration
    this.connectionCheckFields = fields
    this.connectionCheckBusy = true
    this.connectionCheckResult = "Checking repository and branch (read-only)…"
    this.display()

    let result: string
    try {
      if (!fields.owner || !fields.repo || !fields.branch || !fields.token) {
        result = "Enter a GitHub owner, repository, branch and token before testing."
      } else {
        const github = new GitHubClient(fields)
        const identity = await github.getRepositoryIdentity()
        if (generation !== this.connectionCheckGeneration || !this.matchesConnectionCheck(fields)) {
          result = "Connection settings changed during the check. Test again."
        } else if (identity.fullName.toLowerCase() !== `${fields.owner}/${fields.repo}`.toLowerCase()) {
          result = "Repository identity differs from these settings. Check owner and repository."
        } else {
          const ref = await github.getGitRefOrNull()
          if (generation !== this.connectionCheckGeneration || !this.matchesConnectionCheck(fields)) {
            result = "Connection settings changed during the check. Test again."
          } else if (!ref) {
            result = "Configured branch was not found. Repository is accessible. Save changes, then press Sync now to create the branch. This read-only check has not verified write permission."
          } else {
            const config = await github.getFileBytes(V4_CONFIG_PATH, fields.branch)
            result = generation !== this.connectionCheckGeneration || !this.matchesConnectionCheck(fields)
              ? "Connection settings changed during the check. Test again."
              : await this.existingBranchCheckResult(config?.bytes, fields, github)
          }
        }
      }
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status
      if (status === 401) {
        result = "GitHub rejected the token. Check or replace the token."
      } else if (status === 403 || status === 429) {
        result = "GitHub denied the request or applied a rate limit. Check token permissions and try again."
      } else if (status === 404) {
        result = "Repository is not accessible. Check its name and token permissions."
      } else {
        result = "Connection could not be verified. Check owner, repository, branch and network access."
      }
    }
    if (generation !== this.connectionCheckGeneration || !this.tempSettings) return
    this.connectionCheckBusy = false
    this.connectionCheckResult = this.matchesConnectionCheck(fields)
      ? result : "Connection settings changed during the check. Test again."
    this.display()
  }

  constructor(app: App, plugin: FastSync) {
    super(app, plugin)
    this.plugin = plugin
    this.plugin.clipboardReadTip = ""
  }

  isDirty(): boolean {
    if (!this.tempSettings) return false
    return JSON.stringify(this.tempSettings) !== JSON.stringify(this.plugin.settings)
  }

  // A Settings draft is not the active GitHub target. Never run a manual or
  // destructive operation using previously saved credentials while the form
  // shows a different target (or its Save result is still unknown).
  private runSavedSettingsManualAction(action: () => void): void {
    if (!this.tempSettings) return
    if (this.settingsSavePending || this.isDirty()) {
      new Notice("GitHub Sync: Save or discard pending settings changes before syncing.")
      return
    }
    action()
  }

  updateDirtyState(): void {
    if (this.connectionCheckFields && !this.matchesConnectionCheck(this.connectionCheckFields)) {
      // Supersede this request when its credentials change, even if it stalls.
      this.connectionCheckGeneration++
      this.connectionCheckBusy = false
      this.connectionCheckFields = null
      this.connectionCheckResult = "Connection settings changed. Test again."
      this.connectionCheckMessageEl?.setText(this.connectionCheckResult)
      this.connectionCheckButton?.setDisabled(false)
    }
    if (!this.bannerEl) return
    this.bannerEl.empty()
    if (this.isDirty()) {
      this.bannerEl.addClass("is-dirty")
      const banner = this.bannerEl.createDiv("github-sync-settings-dirty-banner")
      banner.createEl("span", { text: "You have unsaved changes!", cls: "github-sync-settings-dirty-text" })
      
      const btnContainer = banner.createDiv("github-sync-settings-dirty-buttons")
      const saveBtn = btnContainer.createEl("button", { text: "Save changes", cls: "mod-cta" })
      saveBtn.disabled = this.settingsSavePending
      saveBtn.onclick = async () => {
        if (!this.tempSettings || this.settingsSavePending) return
        const draft = this.tempSettings
        const draftSnapshot = JSON.stringify(draft)
        const nextSettings = JSON.parse(draftSnapshot) as PluginSettings
        this.settingsSavePending = true
        saveBtn.disabled = true
        discardBtn.disabled = true
        try {
          await this.plugin.saveSettings(nextSettings)
          this.plugin.updateStatusBar()
          new Notice("GitHub Sync: Settings saved")
          // Preserve edits made while an asynchronous save was in progress.
          if (this.tempSettings === draft) {
            if (JSON.stringify(draft) === draftSnapshot) {
              this.tempSettings = JSON.parse(JSON.stringify(this.plugin.settings)) as PluginSettings
            }
            this.display()
          }
        } catch {
          // Secure-storage and persistence errors can contain credential values.
          new Notice("GitHub Sync: Settings not saved. Review the values and secure storage before retrying. If Recovery is active, resolve it first.")
        } finally {
          this.settingsSavePending = false
          this.updateDirtyState()
        }
      }

      const discardBtn = btnContainer.createEl("button", { text: "Discard", cls: "mod-warning" })
      discardBtn.disabled = this.settingsSavePending
      discardBtn.onclick = () => {
        if (this.settingsSavePending) return
        this.tempSettings = JSON.parse(JSON.stringify(this.plugin.settings))
        this.display()
      }
    } else {
      this.bannerEl.removeClass("is-dirty")
    }
  }

  override hide(): void {
    this.connectionCheckGeneration++
    this.connectionCheckBusy = false
    this.connectionCheckResult = ""
    this.connectionCheckFields = null
    this.connectionCheckMessageEl = null
    this.connectionCheckButton = null
    this.plugin.clipboardReadTip = ""
    this.tempSettings = null
  }

  /**
   * Read GitHub configuration JSON from the clipboard and populate settings automatically
   */
  async handleClipboardPaste(tipEl: HTMLElement): Promise<void> {
    const draft = this.tempSettings
    if (!draft || this.settingsSavePending) {
      tipEl.setText("Finish saving Settings before importing a configuration.")
      return
    }
    const draftSnapshot = JSON.stringify(draft)
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        throw new Error("Clipboard unavailable")
      }
      const text = await navigator.clipboard.readText()
      // If the tab closed, a Save completed, or a user edited the draft while
      // waiting for clipboard permission, never apply stale clipboard values.
      if (this.tempSettings !== draft || this.settingsSavePending
        || JSON.stringify(draft) !== draftSnapshot) return
      if (text.length > 65_536) throw new Error("Clipboard configuration too large")
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Clipboard configuration is not an object")
      }
      const fields = parsed as Record<string, unknown>
      const owner = fields["githubOwner"] ?? fields["owner"]
      const repo = fields["githubRepo"] ?? fields["repo"]
      const token = fields["githubToken"] ?? fields["token"]
      const branch = fields["githubBranch"] ?? fields["branch"] ?? "main"
      if (typeof owner !== "string" || !owner.trim()
        || typeof repo !== "string" || !repo.trim()
        || typeof token !== "string" || !token.trim()
        || typeof branch !== "string" || !branch.trim()) {
        throw new Error("Clipboard configuration fields are invalid")
      }
      // Use the same validation as a persisted configuration before replacing
      // the draft; invalid JSON must never render object-valued Settings fields.
      assertPluginSettingsRuntimeSafe({
        ...DEFAULT_SETTINGS, githubOwner: owner, githubRepo: repo,
        githubBranch: branch, githubToken: token,
      })
      this.tempSettings = {
        ...draft, githubOwner: owner, githubRepo: repo,
        githubBranch: branch, githubToken: token,
      }
      this.plugin.clipboardReadTip = "Configuration pasted. Review and Save changes."
      this.display()
    } catch {
      // JSON parse errors may include fragments of clipboard credentials.
      // Never log raw clipboard content or parsing exceptions.
      if (this.tempSettings !== draft) return
      tipEl.setText("No configuration detected!")
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
    if (Platform.isDesktopApp) {
      set.createEl("p", { cls: "setting-item-description", text: V4_NETWORK_VAULT_WARNING })
    }

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
      .setDesc("Enter the branch name (e.g., main). A new branch can be created by your first Sync now after saving Settings.")
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
      .setName("Connection check")
      .setDesc("Checks repository and branch access plus existing V4 configuration and HEAD metadata. Read-only; does not verify write access, encrypted HEAD integrity or the passphrase.")
      .addButton(button => {
        this.connectionCheckButton = button
        button.setButtonText("Test GitHub connection")
          .setDisabled(this.connectionCheckBusy)
          .onClick(() => { void this.testGitHubConnection() })
      })
    this.connectionCheckMessageEl = set.createEl("p", {
      cls: "setting-item-description",
      text: this.connectionCheckResult || "Not checked. Run this before the first Sync.",
    })

    new Setting(set)
      .setName("Device ID (this Obsidian vault)")
      .setDesc("Local identity used for sync history and conflict copies; not the GitHub repository name. Choose a different ID on each device and keep it stable.")
      .addText((text) =>
        text
          .setPlaceholder("Enter a device ID (e.g., laptop-notes)")
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
        .setName("PBKDF2 iterations for new encrypted repositories")
        .setDesc("600,000 by default; maximum 1,200,000. Used only when initializing a NEW encrypted repository. Existing encrypted repositories always use their remote KDF settings. Changing this does NOT re-encrypt or migrate existing data.")
        .addSlider((slider) => slider
          .setLimits(V4_MIN_NEW_PBKDF2_ITERATIONS, V4_MAX_PBKDF2_ITERATIONS, 100_000)
          .setValue(this.tempSettings!.newVaultKdfIterations)
          .setDynamicTooltip()
          .onChange((value) => {
            this.tempSettings!.newVaultKdfIterations = value
            this.updateDirtyState()
          }))
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

    new Setting(set)
      .setName("Create encrypted branch")
      .setDesc("Re-encryption Wizard preview. Requires an existing encrypted V4 branch and will ultimately create a frozen backup branch plus a newly encrypted orphan branch. Source and other devices remain unchanged. Publication is currently disabled until production safety gates pass.")
      .addButton((button) => button
        .setButtonText("Preview wizard")
        .onClick(() => this.plugin.openReencryptionWizard()))

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
          this.runSavedSettingsManualAction(() =>
            this.plugin.runSyncFromUi(() => this.plugin.v4Runtime.manualSync()))
        })
      )

    new Setting(set)
      .setName("Force push local to remote")
      .setDesc("Overwrite the remote state with this local vault.")
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Force push")
          .onClick(() => this.runSavedSettingsManualAction(() => {
            void this.plugin.showForceConfirm("forcePush")
          }))
      )

    new Setting(set)
      .setName("Force pull remote to local")
      .setDesc("Overwrite this local vault with the remote state.")
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("Force pull")
          .onClick(() => this.runSavedSettingsManualAction(() => {
            void this.plugin.showForceConfirm("forcePull")
          }))
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
      .setDesc("When both sides changed, keep this device's local file at its normal path and preserve the remote version as a conflict copy when Copy is selected.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("copy", "Copy (keep local, preserve remote copy)")
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
