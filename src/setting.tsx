import { App, Modal, PluginSettingTab, Notice, Setting, Platform } from "obsidian";
import { KofiImage } from "./lib/icons";
import { $ } from "./lang/lang";
import FastSync from "./main";
import { dump } from "./lib/helps";
import { encryptedForcePull, encryptedForcePush, encryptedManualSync } from "./lib/encrypted/sync-engine";
import { createDebugPayload } from "./lib/debug";
import { StartupFullNotesSync } from "./lib/fs";

export interface PluginSettings {
  //是否自动上传
  syncEnabled: boolean
  // GitHub 配置
  githubOwner: string
  githubRepo: string
  githubBranch: string
  githubToken: string
  encryptionMode: "plaintext" | "encrypted"
  encryptionPassphrase: string
  syncOnStartup: boolean
  syncOnLocalChange: boolean
  scheduledSyncEnabled: boolean
  scheduledSyncIntervalSeconds: number
  ignorePathRegex: string
  conflictPolicy: "copy" | "newer" | "merge" | "ask"
  encryptedForcePushRequired: boolean
  statusBarStatusEnabled: boolean

  vault: string
  lastSyncTime: number
  //  [propName: string]: any;
  clipboardReadTip: string
}

/**
 *

![这是图片](https://markdown.com.cn/assets/img/philly-magic-garden.9c0b4415.jpg)

 */

// 默认插件设置
export const DEFAULT_SETTINGS: PluginSettings = {
  // 是否自动上传
  syncEnabled: true,
  // GitHub 默认值
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubToken: "",
  encryptionMode: "plaintext",
  encryptionPassphrase: "",
  syncOnStartup: true,
  syncOnLocalChange: true,
  scheduledSyncEnabled: false,
  scheduledSyncIntervalSeconds: 300,
  ignorePathRegex: "",
  conflictPolicy: "copy",
  encryptedForcePushRequired: false,
  lastSyncTime: 0,
  vault: "defaultVault",
  statusBarStatusEnabled: true,
  // 剪贴板读取提示
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
   * 从剪贴板读取 GitHub 配置 JSON 并自动填入设置
   */
  async handleClipboardPaste(tipEl: HTMLElement): Promise<void> {
    const showTip = (msg: string) => {
      tipEl.setText(msg)
      setTimeout(() => tipEl.setText(""), 2000)
    }

    try {
      if (!navigator.clipboard) {
        showTip($("未检测到配置信息!"))
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
          showTip($("接口配置信息已经粘贴到设置中!"))
          return
        }
      }
      showTip($("未检测到配置信息!"))
    } catch (err) {
      dump(err)
      showTip($("未检测到配置信息!"))
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
      .setName($("General Settings"))
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName($("启用同步"))
      .setDesc($("关闭后您的笔记将不做任何同步"))
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.syncEnabled).onChange((value) => {
          this.tempSettings!.syncEnabled = value
          this.updateDirtyState()
        })
      )

    new Setting(set)
      .setName($("Show sync status in status bar"))
      .setDesc($("Display real-time sync progress, last sync time, or errors in the Obsidian status bar. Disable (kill-switch) to save system resources."))
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
      .setName($("GitHub Connection Settings"))
      .setHeading()
      .setClass("github-sync-settings-header")

    const apiInfoDiv = set.createDiv("obsidian-github-sync-multi-platform-settings")
    const table = apiInfoDiv.createEl("table", { cls: "obsidian-github-sync-multi-platform-settings-openapi" })
    const thead = table.createEl("thead")
    const headerRow = thead.createEl("tr")
    headerRow.createEl("th", { text: $("方式") })
    headerRow.createEl("th", { text: $("说明") })
    headerRow.createEl("th", { text: $("详情参考") })
    const tbody = table.createEl("tbody")
    const row = tbody.createEl("tr")
    row.createEl("td", { text: "GitHub" })
    row.createEl("td", { text: $("使用 GitHub 仓库存储และ同步笔记") })
    const linkTd = row.createEl("td")
    linkTd.createEl("a", { text: "GitHub PAT Settings", href: "https://github.com/settings/tokens" })

    const clipboardDiv = set.createDiv("clipboard-read")
    const clipboardBtn = clipboardDiv.createEl("button", {
      text: $("粘贴的远端配置"),
      cls: "clipboard-read-button"
    })
    const clipboardTip = clipboardDiv.createEl("div", { cls: "clipboard-read-description" })
    clipboardTip.setText(this.plugin.clipboardReadTip)
    clipboardBtn.addEventListener("click", () => {
      void this.handleClipboardPaste(clipboardTip)
    })

    new Setting(set)
      .setName($("GitHub 用户名"))
      .setDesc($("输入您的 GitHub 用户名"))
      .addText((text) =>
        text
          .setPlaceholder($("输入您的 GitHub 用户名"))
          .setValue(this.tempSettings!.githubOwner)
          .onChange((value) => {
            this.tempSettings!.githubOwner = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName($("GitHub 仓库名"))
      .setDesc($("输入您的 GitHub 仓库名"))
      .addText((text) =>
        text
          .setPlaceholder($("输入您的 GitHub 仓库名"))
          .setValue(this.tempSettings!.githubRepo)
          .onChange((value) => {
            this.tempSettings!.githubRepo = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName($("GitHub 分支名"))
      .setDesc($("输入您的 GitHub 分支名"))
      .addText((text) =>
        text
          .setPlaceholder($("输入您的 GitHub 分支名"))
          .setValue(this.tempSettings!.githubBranch)
          .onChange((value) => {
            this.tempSettings!.githubBranch = value
            this.updateDirtyState()
          })
      )

    new Setting(set)
      .setName($("GitHub 访问令牌"))
      .setDesc($("用于访问 GitHub API 的 Personal Access Token"))
      .addText((text) => {
        text.inputEl.type = "password"
        text
          .setPlaceholder($("输入您的 GitHub 访问令牌"))
          .setValue(this.tempSettings!.githubToken)
          .onChange((value) => {
            this.tempSettings!.githubToken = value
            this.updateDirtyState()
          })
      })

    new Setting(set)
      .setName($("远端仓库名"))
      .setDesc($("远端仓库名"))
      .addText((text) =>
        text
          .setPlaceholder($("远端仓库名"))
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
      .setName($("Encryption Settings"))
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Encrypted sync")
      .setDesc("Encrypt file contents, filenames, and folder structure before uploading to GitHub")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.encryptionMode === "encrypted").onChange((value) => {
          if (value && this.tempSettings!.encryptionMode !== "encrypted") {
            this.tempSettings!.encryptedForcePushRequired = true
          }
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
      .setName($("Manual & Force Operations"))
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Manual sync")
      .setDesc("Sync encrypted vault with the remote repository now.")
      .addButton((button) =>
        button.setButtonText("Sync now").onClick(() => {
          StartupFullNotesSync(this.plugin)
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
      .setName($("Automation & Exclusions"))
      .setHeading()
      .setClass("github-sync-settings-header")

    new Setting(set)
      .setName("Sync when Obsidian opens")
      .setDesc("Run encrypted sync after the workspace is ready.")
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
      .setDesc("Run encrypted sync repeatedly at the configured interval.")
      .addToggle((toggle) =>
        toggle.setValue(this.tempSettings!.scheduledSyncEnabled).onChange((value) => {
          this.tempSettings!.scheduledSyncEnabled = value
          this.display()
        })
      )

    if (this.tempSettings!.scheduledSyncEnabled) {
      new Setting(set)
        .setName("Scheduled sync interval")
        .setDesc("Interval in seconds between scheduled sync attempts.")
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
      .setName($("Support & Debug"))
      .setHeading()
      .setClass("github-sync-settings-header")

    const debugDiv = set.createDiv()
    debugDiv.addClass("obsidian-github-sync-multi-platform-settings-debug")

    const debugButton = debugDiv.createEl("button")
    debugButton.setText($("复制 Debug 信息"))
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
      new Notice($("将调试信息复制到剪贴板, 可能包含敏感信!"))
    }

    if (Platform.isDesktopApp) {
      const info = debugDiv.createDiv()
      info.setText($("通过快捷键打开控制台，你可以看到这个插件和其他插件의日志"))

      const keys = debugDiv.createDiv()
      keys.addClass("custom-shortcuts")
      if (Platform.isMacOS === true) {
        keys.createEl("kbd", { text: $("console_mac") })
      } else {
        keys.createEl("kbd", { text: $("console_windows") })
      }
    }

    const supportDiv = set.createDiv("github-sync-support-section")

    new Setting(supportDiv).setName($("捐赠")).setHeading()

    supportDiv.createEl("p", {
      text: $("如果您喜欢这个插件，请考虑捐赠以支持继续开发。")
    })

    const kofiLink = supportDiv.createEl("a", {
      href: "https://ko-fi.com/thiter",
    })
    const kofiImg = kofiLink.createEl("img", { cls: "kofi-img" })
    kofiImg.src = KofiImage
  }
}
