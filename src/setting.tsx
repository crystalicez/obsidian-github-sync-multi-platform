import { App, Modal, PluginSettingTab, Notice, Setting, Platform } from "obsidian";
import { KofiImage } from "./lib/icons";
import { $ } from "./lang/lang";
import FastSync from "./main";
import { dump } from "./lib/helps";
import { encryptedForcePull, encryptedForcePush, encryptedManualSync } from "./lib/encrypted/sync-engine";
import { createDebugPayload } from "./lib/debug";

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
  // 剪贴板读取提示
  clipboardReadTip: "",
}

export class SettingTab extends PluginSettingTab {
  plugin: FastSync

  constructor(app: App, plugin: FastSync) {
    super(app, plugin)
    this.plugin = plugin
    this.plugin.clipboardReadTip = ""
  }

  async confirmForce(title: string, message: string, operation: "forcePush" | "forcePull"): Promise<void> {
    await new Promise<void>((resolve) => {
      const modal = new Modal(this.app)
      const repo = `${this.plugin.settings.githubOwner}/${this.plugin.settings.githubRepo}`
      const branch = this.plugin.settings.githubBranch || "main"
      const localFileCount = this.app.vault.getFiles().filter(file => !file.path.startsWith(`${this.app.vault.configDir}/`)).length
      const confirmPhrase = `${operation === "forcePush" ? "push" : "pull"} ${repo} ${branch}`
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
        if (operation === "forcePush") void encryptedForcePush(this.plugin)
        else void encryptedForcePull(this.plugin)
        resolve()
      }
      modal.open()
    })
  }

  hide(): void {
    // 不再需要 React root.unmount()
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
          this.plugin.settings.githubOwner = parsed.githubOwner || parsed.owner
          this.plugin.settings.githubRepo = parsed.githubRepo || parsed.repo
          this.plugin.settings.githubBranch = parsed.githubBranch || parsed.branch || "main"
          this.plugin.settings.githubToken = parsed.githubToken || parsed.token
          await this.plugin.saveSettings()
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

    // new Setting(set).setName("Fast Note Sync").setDesc($("Fast sync")).setHeading()

    new Setting(set)
      .setName($("启用同步"))
      .setDesc($("关闭后您的笔记将不做任何同步"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncEnabled).onChange(async (value) => {
          if (value != this.plugin.settings.syncEnabled) {
            this.plugin.settings.syncEnabled = value
            this.display()
            await this.plugin.saveSettings()
          }
        })
      )

    new Setting(set)
      .setName("| " + $("远端"))
      .setHeading()
      .setClass("obsidian-github-sync-multi-platform-settings-tag")

    // 用 Obsidian 原生 API 替换 React 组件（移除 react-dom 依赖）
    new Setting(set)
      .setName($("GitHub 同步配置"))
      .setDesc($("使用 GitHub API 进行同步"))

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
    row.createEl("td", { text: $("使用 GitHub 仓库存储和同步笔记") })
    const linkTd = row.createEl("td")
    linkTd.createEl("a", { text: "GitHub PAT Settings", href: "https://github.com/settings/tokens" })

    // 粘贴配置按鈕
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
          .setValue(this.plugin.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.settings.githubOwner = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(set)
      .setName($("GitHub 仓库名"))
      .setDesc($("输入您的 GitHub 仓库名"))
      .addText((text) =>
        text
          .setPlaceholder($("输入您的 GitHub 仓库名"))
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(set)
      .setName($("GitHub 分支名"))
      .setDesc($("输入您的 GitHub 分支名"))
      .addText((text) =>
        text
          .setPlaceholder($("输入您的 GitHub 分支名"))
          .setValue(this.plugin.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.settings.githubBranch = value
            await this.plugin.saveSettings()
          })
      )

    new Setting(set)
      .setName($("GitHub 访问令牌"))
      .setDesc($("用于访问 GitHub API 的 Personal Access Token"))
      .addText((text) => {
        text.inputEl.type = "password"  // C4: mask 显示，防止 Token 明文泄露
        text
          .setPlaceholder($("输入您的 GitHub 访问令牌"))
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.settings.githubToken = value
            await this.plugin.saveSettings()
          })
      })

    new Setting(set)
      .setName("Encrypted sync")
      .setDesc("Encrypt file contents, filenames, and folder structure before uploading to GitHub")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.encryptionMode === "encrypted").onChange(async value => {
          if (value && this.plugin.settings.encryptionMode !== "encrypted") this.plugin.settings.encryptedForcePushRequired = true
          this.plugin.settings.encryptionMode = value ? "encrypted" : "plaintext"
          await this.plugin.saveSettings()
          this.display()
        })
      )

    if (this.plugin.settings.encryptionMode === "encrypted") {
      new Setting(set)
        .setName("Encryption passphrase")
        .setDesc("Enter the same passphrase on every device. Losing it means the encrypted repo cannot be decrypted.")
        .addText(text => {
          text.inputEl.type = "password"
          text.setValue(this.plugin.settings.encryptionPassphrase).onChange(async value => {
            this.plugin.settings.encryptionPassphrase = value
            await this.plugin.saveSettings()
          })
        })
    }
    new Setting(set).setName("Manual sync").setDesc("Sync encrypted vault with the remote repository now.").addButton(button =>
      button.setButtonText("Sync now").onClick(() => void encryptedManualSync(this.plugin))
    )

    new Setting(set).setName("Force push local to remote").setDesc("Overwrite the encrypted remote state with this local vault.").addButton(button =>
      button.setWarning().setButtonText("Force push").onClick(() => void this.confirmForce("Force push local vault to remote?", "Remote encrypted files not present locally may be deleted.", "forcePush"))
    )

    new Setting(set).setName("Force pull remote to local").setDesc("Overwrite this local vault with the encrypted remote state.").addButton(button =>
      button.setWarning().setButtonText("Force pull").onClick(() => void this.confirmForce("Force pull remote vault to local?", "Local synced files not present remotely will be deleted.", "forcePull"))
    )

    new Setting(set)
      .setName("Sync when Obsidian opens")
      .setDesc("Run encrypted sync after the workspace is ready.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async value => {
        this.plugin.settings.syncOnStartup = value
        await this.plugin.saveSettings()
      }))

    new Setting(set)
      .setName("Sync when local files change")
      .setDesc("Sync when a local file is created, modified, deleted, or renamed.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.syncOnLocalChange).onChange(async value => {
        this.plugin.settings.syncOnLocalChange = value
        await this.plugin.saveSettings()
      }))

    new Setting(set)
      .setName("Scheduled sync")
      .setDesc("Run encrypted sync repeatedly at the configured interval.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.scheduledSyncEnabled).onChange(async value => {
        this.plugin.settings.scheduledSyncEnabled = value
        await this.plugin.saveSettings()
        this.display()
      }))

    new Setting(set)
      .setName("Scheduled sync interval")
      .setDesc("Interval in seconds between scheduled sync attempts.")
      .addText(text => text.setPlaceholder("300").setValue(String(this.plugin.settings.scheduledSyncIntervalSeconds)).onChange(async value => {
        const seconds = Number(value)
        this.plugin.settings.scheduledSyncIntervalSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 300
        await this.plugin.saveSettings()
      }))

    new Setting(set)
      .setName("Regex of path to ignore")
      .setDesc("One regex per line, matched against plaintext vault paths before encryption. Examples: ^Archive/ ignores a folder, (^|/)\\.DS_Store$ ignores .DS_Store, \\.tmp$ ignores .tmp files.")
      .addTextArea(text => text.setPlaceholder("^Archive/\n(^|/)\\.DS_Store$\n\\.tmp$").setValue(this.plugin.settings.ignorePathRegex).onChange(async value => {
        this.plugin.settings.ignorePathRegex = value
        await this.plugin.saveSettings()
      }))

    new Setting(set)
      .setName("File conflict policy")
      .setDesc("Choose what to do when both local and remote changed since last sync.")
      .addDropdown(dropdown => dropdown
        .addOption("copy", "Copy policy")
        .addOption("newer", "Newer")
        .addOption("merge", "Merge text")
        .addOption("ask", "Always ask")
        .setValue(this.plugin.settings.conflictPolicy)
        .onChange(async value => {
          this.plugin.settings.conflictPolicy = value as "copy" | "newer" | "merge" | "ask"
          await this.plugin.saveSettings()
        }))
    new Setting(set)
      .setName($("远端仓库名"))
      .setDesc($("远端仓库名"))
      .addText((text) =>
        text
          .setPlaceholder($("远端仓库名"))
          .setValue(this.plugin.settings.vault)
          .onChange(async (value) => {
            this.plugin.settings.vault = value
            await this.plugin.saveSettings()
          })
      )

    const debugDiv = set.createDiv()
    debugDiv.addClass("obsidian-github-sync-multi-platform-settings-debug")

    const debugButton = debugDiv.createEl("button")
    debugButton.setText($("复制 Debug 信息"))
    debugButton.onclick = async () => {
      await window.navigator.clipboard.writeText(
        JSON.stringify(
          createDebugPayload(this.plugin.settings as unknown as Record<string, unknown>, this.plugin.manifest.version),
          null,
          4
        )
      )
      new Notice($("将调试信息复制到剪贴板, 可能包含敏感信!"))
    }

    if (Platform.isDesktopApp) {
      const info = debugDiv.createDiv()
      info.setText($("通过快捷键打开控制台，你可以看到这个插件和其他插件的日志"))

      const keys = debugDiv.createDiv()
      keys.addClass("custom-shortcuts")
      if (Platform.isMacOS === true) {
        keys.createEl("kbd", { text: $("console_mac") })
      } else {
        keys.createEl("kbd", { text: $("console_windows") })
      }
    }

    // Support section
    new Setting(set).setName($("支持")).setHeading()
    const supportDiv = set.createDiv("github-sync-support-section")

    // Add donation title
    new Setting(supportDiv).setName($("捐赠")).setHeading()

    // Add donation text
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
