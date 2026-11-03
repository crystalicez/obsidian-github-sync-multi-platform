import { Plugin, setIcon, Modal, Notice, TFile, TFolder, Platform } from "obsidian";

import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";
import { GitHubClient } from "./lib/github-api";
import { assertPluginSettingsRuntimeSafe } from "./lib/plugin-settings-validation";
import { V4RateLimitCooldownStore } from "./lib/v4/rate-limit-cooldown";
import { selectV4GitHubSchedulerSleep } from "./lib/v4/desktop-transport-timer";
import { normalizeScheduledSyncIntervalSeconds, shouldRunScheduledSync, shouldRunStartupSync } from "./lib/sync-policy";
import { hydrateV4SecretsReadOnly, migrateV4Secrets, sanitizeV4SettingsForPersistence, storeV4Secrets } from "./lib/v4/secrets";
import { assertV4ReencryptionSyncFenceClear } from "./lib/v4/reencryption-sync-fence";
import { V4PluginRuntime } from "./lib/v4/runtime";
import { persistV4FencedDestinationSettings, type V4FencedPluginSettingsCutoverReport } from "./lib/v4/reencryption-persisted-settings-cutover";
import type { V4FencedPendingCommitPreflightInput } from "./lib/v4/reencryption-fenced-pending-commit-preflight";
import { createIdleV4Progress } from "./lib/v4/progress";
import { formatV4ActiveSyncStatus } from "./lib/v4/status";
import { V4SyncCenterView, V4_SYNC_CENTER_VIEW } from "./views/sync-center";
import { V4ReencryptionWizardModal } from "./views/reencryption-wizard";


// Obsidian initializes these fields in onload(), not in the Plugin constructor.
export default class FastSync extends Plugin {
  settingTab!: SettingTab
  settings!: PluginSettings
  githubClient!: GitHubClient
  v4Runtime!: V4PluginRuntime

  isSyncInProgress: boolean = false
  clipboardReadTip: string = ""

  ribbonIcon!: HTMLElement
  statusBarItem: HTMLElement | null = null
  saveNoticeTimeout: number | null = null
  isWatchEnabled: boolean = true
  ignoredFiles: Set<string> = new Set()
  scheduledSyncTimer: number | null = null
  startupSyncTimeout: number | null = null
  secretsMigrated: boolean = false
  private settingsSaveInProgress = false

  /** Synchronously checked by the Re-encryption arming gate before disk I/O. */
  isSettingsSaveInProgress(): boolean { return this.settingsSaveInProgress }
  private unloaded = false
  private statusDisplaySignature: string | undefined
  private cooldownStore?: V4RateLimitCooldownStore

  /**
   * UI and host timers do not await callback Promises. Observe unexpected
   * errors without repeating a Sync whose remote outcome may be unknown.
   * Normal V4 runtime failures already display their own status and Notice.
   */
  runSyncFromUi(operation: () => Promise<unknown>): void {
    if (this.unloaded) return
    const reportUnexpectedFailure = () => {
      if (this.unloaded) return
      try {
        new Notice("GitHub Sync: Sync stopped unexpectedly. Review Sync status before retrying manually.")
      } catch { /* Do not throw again from a detached event callback. */ }
    }
    try {
      void operation().catch(reportUnexpectedFailure)
    } catch {
      reportUnexpectedFailure()
    }
  }

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


  override async onload() {
    this.unloaded = false
    await this.loadSettings()
    if (this.secretsMigrated) {
      if (await this.canMigrateStartupSecrets()) await this.persistData()
      else this.secretsMigrated = false
    }

    // Keep retry deadlines in two checksummed, private plugin-data slots.
    // A new client (or next Obsidian start) inherits the same token quota.
    const vault = this.app.vault as typeof this.app.vault & {
      configDir?: string
      adapter?: {
        exists(path: string): Promise<boolean>
        read(path: string): Promise<string>
        write(path: string, data: string): Promise<void>
      }
    }
    if (vault.adapter) {
      this.cooldownStore = new V4RateLimitCooldownStore(
        vault.adapter,
        `${vault.configDir || ".obsidian"}/plugins/${this.manifest.id}`,
      )
    }

    this.settingTab = new SettingTab(this.app, this)
    this.addSettingTab(this.settingTab)

    this.initGitHubClient()
    this.v4Runtime = this.createV4Runtime()
    // D234: detect a restarted Settings cutover without allowing Sync.
    const recoveredRoute = await this.v4Runtime.inspectFencedReencryptionIndexRoute?.()
    if (recoveredRoute && recoveredRoute.observation !== "no-routing-artifact"
      && recoveredRoute.observation !== "fenced-before-routing-intent") {
      new Notice(
        "GitHub Sync: Re-encryption recovery pending. Sync stays paused; keep both passphrases and review Manual Recovery before changing branches.",
        10000,
      )
    }
    this.register(this.v4Runtime.subscribeProgress(() => this.updateStatusBar()))
    this.registerView(V4_SYNC_CENTER_VIEW, leaf => new V4SyncCenterView(leaf, this))
    this.registerScheduledSync()

    // Create Ribbon Icons
    this.ribbonIcon = this.addRibbonIcon("loader-circle", "GitHub Sync: Sync", () => {
      this.runSyncFromUi(() => this.v4Runtime.manualSync())
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
      else if (file instanceof TFolder) this.v4Runtime.enqueueFolderDelete(file.path)
    }))
    this.registerEvent(this.app.vault.on("rename", (file, oldfile) => {
      if (file instanceof TFile) this.v4Runtime.enqueueRename(oldfile, file.path)
      else if (file instanceof TFolder) this.v4Runtime.enqueueFolderRename(oldfile, file.path)
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
      callback: () => this.runSyncFromUi(() => this.v4Runtime.manualSync()),
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

    this.addCommand({
      id: "verify-reencryption-recovery-read-only",
      name: "GitHub Sync: Verify Re-encryption Recovery (Read-only)",
      callback: () => {
        void (async () => {
          try {
            const backup = await this.v4Runtime.verifyFencedReencryptionAuthenticatedWal()
            if (this.unloaded) return
            if (!backup?.originalKeyAuthenticated || !backup.completeBackupContentsReverified
              || !backup.coldStartWalReverified) {
              new Notice(
                "GitHub Sync: Frozen Backup, encrypted WAL and Destination ciphertext receipt verification is incomplete. Full Recovery unverified; keep both passphrases and review Manual Recovery. Sync stays paused.",
                12000,
              )
              return
            }
            new Notice(
              backup.completeDestinationContentsReverified && backup.recoveryLeaseReverified
                ? "GitHub Sync: Old Frozen Backup, encrypted WAL and ALL new-key Destination file plaintext verified within one owner-held read-only recovery scope. Mobile is cooperative best-effort only. D248 full Recovery, multi-device Cutover and Sync restart are still UNVERIFIED. Sync stays paused."
                : backup.destinationCiphertextReceiptsReverified
                ? (backup.destinationNewKeyHeadAuthenticated && backup.sourceShadowSnapshotsReverified
                  ? "GitHub Sync: Old Backup, AES-GCM WAL and listed Destination Git ciphertext receipts verified; Source/Shadow snapshots match and new-key Destination HEAD decrypted. File plaintext, full Recovery and Cutover are UNVERIFIED. Sync stays paused."
                  : "GitHub Sync: Old key, Frozen Backup and AES-GCM WAL authenticated; Destination Git blobs match WAL SHA-1/size receipts only. New-key HEAD and full Recovery are UNVERIFIED. Sync stays paused.")
                : "GitHub Sync: Original key, Frozen Backup and AES-GCM WAL authenticated; no nonempty Destination ciphertext receipt proof. Complete Recovery remains unverified. Sync stays paused.",
              12000,
            )
            const refs = await this.v4Runtime.inspectFencedReencryptionCandidateGitRefs()
            if (this.unloaded) return
            new Notice(refs?.destinationOrphanTopologyObserved
              ? (backup.completeDestinationContentsReverified && backup.recoveryLeaseReverified
                ? "GitHub Sync: Backup/Destination Git ref identities also match the saved candidate. Full Recovery/Cutover is not authorized, and Sync remains paused."
                : "GitHub Sync: GitHub Backup/Destination branch and commit identities match the saved candidate. This does NOT verify Destination contents or authorize full Recovery. Sync stays paused.")
              : "GitHub Sync: Destination GitHub ref topology is unavailable or differs from the saved candidate. Preserve both passphrases; Manual Recovery may be needed. Sync stays paused.",
            12000)
          } catch {
            if (!this.unloaded) new Notice(
              "GitHub Sync: Read-only Backup/WAL verification unavailable. Sync stays paused; review Manual Recovery.",
              10000,
            )
          }
        })()
      },
    })

    // After the workspace layout is ready, run the startup sync once, then enable real-time watch
    this.app.workspace.onLayoutReady(() => {
      if (shouldRunStartupSync(this.settings)) {
        // Delay 1.5 s to let Obsidian finish initialising
        this.startupSyncTimeout = window.setTimeout(() => {
          this.startupSyncTimeout = null;
          const runtime = this.v4Runtime;
          if (runtime) this.runSyncFromUi(() => runtime.startupSync());
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
      }, {
        cooldownStore: this.cooldownStore,
        sleep: selectV4GitHubSchedulerSleep(Platform.isDesktopApp === true),
      });
    } else this.githubClient = undefined as unknown as GitHubClient
  }

  override onunload() {
    this.unloaded = true
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
    if (this.startupSyncTimeout !== null) window.clearTimeout(this.startupSyncTimeout);
    this.startupSyncTimeout = null;
    this.v4Runtime?.dispose()
  }

  protected createV4Runtime(): V4PluginRuntime {
    return new V4PluginRuntime(this)
  }

  registerScheduledSync() {
    if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
    this.scheduledSyncTimer = null;
    if (!shouldRunScheduledSync(this.settings)) return;
    const seconds = normalizeScheduledSyncIntervalSeconds(this.settings.scheduledSyncIntervalSeconds);
    this.scheduledSyncTimer = window.setInterval(() => {
      this.runSyncFromUi(() => this.v4Runtime.scheduledSync())
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
  async persistData(settings: PluginSettings = this.settings) {
    await this.saveData({
      settings: sanitizeV4SettingsForPersistence(settings),
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

  /** Startup runs before V4 runtime exists; inspect the actual vault adapter fence. */
  private async canMigrateStartupSecrets(): Promise<boolean> {
    const vault = this.app?.vault as typeof this.app.vault & {
      configDir?: string
      adapter?: { exists(path: string): Promise<boolean> }
    }
    const adapter = vault?.adapter
    const manifestId = this.manifest?.id
    const configDir = vault?.configDir || ".obsidian"
    if (!adapter || typeof adapter.exists !== "function" || !manifestId) return false
    const root = `${configDir}/plugins/${manifestId}`
    try {
      await assertV4ReencryptionSyncFenceClear({
        exists: path => adapter.exists(`${root}/${path}`),
      })
    } catch {
      return false
    }
    return this.app.vault.adapter === adapter && this.manifest.id === manifestId
      && (this.app.vault.configDir || ".obsidian") === configDir
  }

  async loadSettings() {
    const data = await this.loadData() ?? {};
    // Backward compatibility: older versions stored settings fields directly at the top level
    const savedSettings = data.settings ?? data;
    const merged = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    // Validate persisted runtime data before any legacy secret migration writes.
    assertPluginSettingsRuntimeSafe(merged)
    if (!await this.canMigrateStartupSecrets()) {
      // Fenced startup must not overwrite existing SecretStorage values.
      this.settings = hydrateV4SecretsReadOnly(merged, this.app.secretStorage) as PluginSettings
      this.secretsMigrated = false
      return
    }
    const result = migrateV4Secrets(
      merged,
      this.app.secretStorage,
      prefix => this.createSecretId(prefix),
    )
    this.settings = result.settings as PluginSettings
    this.secretsMigrated = result.migrated
  }

  /**
   * Re-encryption only: native Settings cutover after D232 Selector, with
   * BOTH passphrases kept. Ordinary saveSettings() scrubs the previous key.
   * Not wired to Wizard Run until Runtime Index routing is crash-recoverable.
   */
  async persistFencedReencryptionDestinationSettings(
    input: V4FencedPendingCommitPreflightInput,
  ): Promise<V4FencedPluginSettingsCutoverReport> {
    if (this.unloaded || this.settingsSaveInProgress || this.isSyncInProgress
      || !this.v4Runtime || !this.app.vault.adapter) {
      throw new Error("Re-encryption Settings Cutover needs an idle active plugin; Manual Recovery.")
    }
    const runtime = this.v4Runtime
    const backing = this.app.vault.adapter
    const original = this.settings
    const identity = (settings: PluginSettings) => JSON.stringify({
      githubOwner: settings.githubOwner, githubRepo: settings.githubRepo,
      githubBranch: settings.githubBranch, encryptionMode: settings.encryptionMode,
      encryptionPassphraseSecretId: settings.encryptionPassphraseSecretId,
      vault: settings.vault,
    })
    const originalId = identity(original)
    const assertOwner = () => {
      if (this.unloaded || !this.settingsSaveInProgress || this.isSyncInProgress
        || this.v4Runtime !== runtime || this.app.vault.adapter !== backing
        || this.settings !== original || identity(this.settings) !== originalId) {
        throw new Error("Re-encryption Settings Cutover lost plugin/Settings ownership.")
      }
    }
    this.settingsSaveInProgress = true
    try {
      return await persistV4FencedDestinationSettings({
        ...input,
        readPersistedPluginData: () => this.loadData(),
        writePersistedPluginData: data => this.saveData(data),
        assertLivePluginOwner: assertOwner,
      })
    } finally {
      // A rejected native save may have committed: never revert or scrub.
      this.settingsSaveInProgress = false
    }
  }

  async saveSettings(nextSettings: PluginSettings = this.settings) {
    // Never publish a draft to running syncs or overwrite active credentials
    // before its persisted settings record has committed.
    assertPluginSettingsRuntimeSafe(nextSettings)
    if (this.settingsSaveInProgress) throw new Error("GitHub Sync: Settings save already in progress.")
    const previous = this.settings
    const settingsRuntime = this.v4Runtime
    const assertReencryptionSafe = async (): Promise<void> => {
      if (this.v4Runtime !== settingsRuntime) {
        throw new Error("Re-encryption Settings runtime changed; Manual Recovery required.")
      }
      await settingsRuntime?.assertReencryptionSettingsSaveAllowed?.()
    }
    const prepared = { ...nextSettings }
    if (!prepared.githubTokenSecretId || prepared.githubToken !== previous.githubToken) {
      prepared.githubTokenSecretId = this.createSecretId("github-token")
    }
    if (!prepared.encryptionPassphraseSecretId || prepared.encryptionPassphrase !== previous.encryptionPassphrase) {
      prepared.encryptionPassphraseSecretId = this.createSecretId("encryption-passphrase")
    }
    assertPluginSettingsRuntimeSafe(prepared)
    const newTokenId = prepared.githubTokenSecretId !== previous.githubTokenSecretId
      ? prepared.githubTokenSecretId : ""
    const newPassphraseId = prepared.encryptionPassphraseSecretId !== previous.encryptionPassphraseSecretId
      ? prepared.encryptionPassphraseSecretId : ""
    const storage = this.app.secretStorage
    this.settingsSaveInProgress = true
    try {
      // Preserve the original key and pinned Settings during Manual Recovery.
      await assertReencryptionSafe()
      // Allocate immutable IDs for replacements so failed writes cannot
      // corrupt credentials still referenced by the durable previous record.
      try {
        if (newTokenId || newPassphraseId) {
          storeV4Secrets({
            githubTokenSecretId: newTokenId,
            githubToken: prepared.githubToken,
            encryptionPassphraseSecretId: newPassphraseId,
            encryptionPassphrase: prepared.encryptionPassphrase,
          }, storage)
        }
      } catch (error) {
        // No settings-file write was attempted: only these newly allocated IDs
        // can have changed, so a best-effort scrub is safe.
        for (const id of [newTokenId, newPassphraseId].filter(Boolean)) {
          try { storage.setSecret(id, "") } catch { /* Preserve first error. */ }
        }
        throw error
      }
      try {
        await assertReencryptionSafe()
        await this.persistData(prepared)
      } catch (error) {
        // A rejected saveData() does NOT prove that its disk write failed.
        // Reconcile only when a readback exactly verifies the new durable
        // settings. Otherwise preserve both old and candidate secrets so a
        // restart can safely discover either on-disk outcome.
        let verifiedDurable = false
        try {
          const readback = await this.loadData()
          const record = readback?.settings ?? readback
          verifiedDurable = JSON.stringify(record) ===
            JSON.stringify(sanitizeV4SettingsForPersistence(prepared))
        } catch { /* Inconclusive: never scrub potentially committed keys. */ }
        if (!verifiedDurable) throw error
      }
      // The fence may have appeared during an ambiguous disk write.
      // Never publish changed Settings or clear the old secret in that case.
      await assertReencryptionSafe()
      this.settings = prepared
      // In-progress sessions pin their original settings and GitHub client.
      // The next session must not reuse a derived key after credential changes.
      this.v4Runtime?.credentialsChanged()
      if (!this.unloaded) {
        this.initGitHubClient()
        this.registerScheduledSync()
        this.updateRibbonIcon(!!(prepared.githubToken && prepared.githubOwner && prepared.githubRepo))
      }
      // Scrub old credentials only after the new record is durable.
      for (const [oldId, newId] of [
        [previous.githubTokenSecretId, newTokenId],
        [previous.encryptionPassphraseSecretId, newPassphraseId],
      ]) {
        if (!oldId || !newId || oldId === newId) continue
        try { storage.setSecret(oldId, "") }
        catch {
          if (!this.unloaded) new Notice("GitHub Sync: Settings saved, but an old credential could not be cleared from secure storage.")
        }
      }
    } finally {
      this.settingsSaveInProgress = false
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
      this.statusDisplaySignature = undefined;
      return;
    }

    if (!this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusDisplaySignature = undefined;
    }

    const snapshot = this.v4Runtime?.progressSnapshot ?? createIdleV4Progress();
    const { text, title } = formatV4ActiveSyncStatus(snapshot);
    let cls = "github-sync-status-bar";

    if (snapshot.lifecycle === "waiting" || snapshot.lifecycle === "active") cls += " is-syncing";
    const signature = `${text}\u0000${title}\u0000${cls}`;
    if (signature === this.statusDisplaySignature) return;
    this.statusBarItem.empty();

    const span = this.statusBarItem.createEl("span", { text, cls });
    span.title = title;
    const runtime = this.v4Runtime;
    span.onclick = () => {
      if (runtime && !runtime.isSyncing) {
        if (this.unloaded) return
        this.runSyncFromUi(() => runtime.manualSync())
      }
    };
    this.statusDisplaySignature = signature;
  }

  openReencryptionWizard(): void {
    if (this.settingTab.isDirty()) {
      new Notice("Save or discard pending settings edits before previewing Re-encryption.")
      return
    }
    new V4ReencryptionWizardModal(this).open()
  }

  async showForceConfirm(operation: "forcePush" | "forcePull"): Promise<void> {
    await new Promise<void>((resolve) => {
      const modal = new Modal(this.app)
      const confirmedSettings = { ...this.settings }
      const confirmedGithubClient = this.githubClient
      // File counts alone would miss a delete-and-recreate with a different
      // path. Compare the visible path inventory, not only its total.
      const visibleVaultPaths = () => this.app.vault.getFiles()
        .filter(file => !file.path.startsWith(`${this.app.vault.configDir}/`))
        .map(file => file.path)
        .sort()
      const confirmedLocalPaths = visibleVaultPaths()
      const sameVisibleVaultInventory = (): boolean => {
        try {
          const currentPaths = visibleVaultPaths()
          return currentPaths.length === confirmedLocalPaths.length
            && currentPaths.every((path, index) => path === confirmedLocalPaths[index])
        } catch {
          // Never authorize a destructive operation if the Vault inventory
          // cannot be re-observed at confirmation time.
          return false
        }
      }
      // A confirmation authorizes the displayed target and sync scope, not
      // whichever Settings snapshot may be installed before the button click.
      // Only presentation and automatic scheduling settings are immaterial.
      const presentationOrSchedule = new Set<keyof PluginSettings>([
        "lastSyncTime", "statusBarStatusEnabled", "consoleLoggingEnabled",
        "clipboardReadTip", "syncOnStartup", "syncOnLocalChange",
        "scheduledSyncEnabled", "scheduledSyncIntervalSeconds",
      ])
      const stillConfirmed = () => !this.settingsSaveInProgress
        && this.githubClient === confirmedGithubClient
        && sameVisibleVaultInventory()
        && !this.settingTab?.isDirty()
        && (Object.keys(confirmedSettings) as (keyof PluginSettings)[])
          .every(key => presentationOrSchedule.has(key)
            || confirmedSettings[key] === this.settings[key])
      let settled = false
      let resolved = false

      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      modal.onClose = () => {
        resolved = true
        finish()
      }
      const repo = `${confirmedSettings.githubOwner}/${confirmedSettings.githubRepo}`
      const branch = confirmedSettings.githubBranch || "main"
      const localFileCount = confirmedLocalPaths.length

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
        if (!stillConfirmed() || this.unloaded) {
          resolved = true
          modal.close()
          if (!this.unloaded) {
            new Notice("GitHub Sync: Force confirmation expired because Sync settings changed. Review the current target and confirm again.")
          }
          return
        }
        resolved = true
        modal.close()
        if (operation === "forcePush") this.runSyncFromUi(() => this.v4Runtime.forcePush())
        else this.runSyncFromUi(() => this.v4Runtime.forcePull())
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
