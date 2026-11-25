import { Plugin, setIcon, Modal, Notice, TFile, TFolder, Platform } from "obsidian";

import { SettingTab, PluginSettings, DEFAULT_SETTINGS } from "./setting";
import { GitHubClient } from "./lib/github-api";
import { assertPluginSettingsRepairableOnLoad, assertPluginSettingsSavable } from "./lib/plugin-settings-validation";
import { V4RateLimitCooldownStore } from "./lib/v4/rate-limit-cooldown";
import { selectV4GitHubSchedulerSleep } from "./lib/v4/desktop-transport-timer";
import { hasGitHubSyncConfig, missingGitHubSyncConfigFields, normalizeScheduledSyncIntervalSeconds, shouldRunScheduledSync, shouldRunStartupSync } from "./lib/sync-policy";
import { hydrateV4SecretsReadOnly, migrateV4Secrets, sanitizeV4SettingsForPersistence, storeV4Secrets } from "./lib/v4/secrets";
import { assertV4ReencryptionSyncFenceClear } from "./lib/v4/reencryption-sync-fence";
import { V4PluginRuntime } from "./lib/v4/runtime";
import { createV4ScopePredicate } from "./lib/v4/scope";
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
  private savedGitHubRoutingNeedsRepair = false
  private secretStorageReadUnavailable = false
  private settingsSaveInProgress = false
  // Monotonic in-memory epoch: even a failed or no-op save can race
  // an in-flight migration preflight. Never reset it on completion.
  private settingsSaveAttemptGeneration = 0

  /** Synchronously checked by the Re-encryption arming gate before disk I/O. */
  isSettingsSaveInProgress(): boolean { return this.settingsSaveInProgress }
  get settingsSaveGeneration(): number { return this.settingsSaveAttemptGeneration }
  private unloaded = false
  private recoveryReadOnlyCommandInProgress = false
  private stagedRecoveryModal: Modal | null = null
  private recoveryReadOnlyEpoch = 0
  private statusDisplaySignature: string | undefined
  private cooldownStore?: V4RateLimitCooldownStore

  private requireConfiguredGitHubForUi(): boolean {
    const missing = missingGitHubSyncConfigFields(this.settings)
    if (missing.length === 0) return true
    new Notice(`GitHub Sync: Configure ${missing.join(", ")} in Settings and Save changes before syncing.`)
    return false
  }

  runManualSyncFromUi(): void {
    if (this.unloaded) return
    if (this.settingsSaveInProgress || this.settingTab?.isDirty()) {
      new Notice("GitHub Sync: Save or discard pending settings changes before syncing.")
      return
    }
    this.runSyncFromUi(() => this.v4Runtime.manualSync())
  }

  /**
   * UI and host timers do not await callback Promises. Observe unexpected
   * errors without repeating a Sync whose remote outcome may be unknown.
   * Normal V4 runtime failures already display their own status and Notice.
   */
  runSyncFromUi(operation: () => Promise<unknown>): void {
    if (this.unloaded || !this.requireConfiguredGitHubForUi()) return
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
    this.recoveryReadOnlyEpoch++
    this.recoveryReadOnlyCommandInProgress = false
    await this.loadSettings()
    if (this.secretStorageReadUnavailable) {
      new Notice("GitHub Sync: Obsidian SecretStorage is unavailable. Sync cannot run or save Settings; restore secure storage and restart Obsidian.", 12000)
    } else if (this.settings.githubOwner && this.settings.githubRepo) {
      if (this.settings.githubTokenSecretId && !this.settings.githubToken) {
        new Notice("GitHub Sync: Saved GitHub token is unavailable after restart. Re-enter the token in Settings before Sync.")
      }
      if (this.settings.encryptionMode === "encrypted"
        && this.settings.encryptionPassphraseSecretId && !this.settings.encryptionPassphrase) {
        new Notice("GitHub Sync: Saved encryption passphrase is unavailable after restart. Re-enter it in Settings before encrypted Sync.")
      }
    }
    if (this.savedGitHubRoutingNeedsRepair) {
      const fields = missingGitHubSyncConfigFields(this.settings)
        .filter(field => field === "GitHub owner" || field === "GitHub repository"
          || field === "GitHub branch")
      new Notice(`GitHub Sync: Saved GitHub routing needs repair (${fields.join(", ")}). Correct it in Settings and Save changes; Sync stays disabled.`, 12000)
    }
    if (!this.settings.githubBranch.trim()) {
      new Notice("GitHub Sync: Saved GitHub branch is empty. Enter the branch name in Settings and Save changes before syncing.")
    }
    if (!this.settings.vault.trim()) {
      new Notice("GitHub Sync: Saved Device ID is empty. Enter a unique Device ID in Settings and Save changes before syncing.")
    }
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
      this.runManualSyncFromUi()
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

    this.updateRibbonIcon(hasGitHubSyncConfig(this.settings))

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
      callback: () => this.runManualSyncFromUi(),
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
        if (this.unloaded || this.recoveryReadOnlyCommandInProgress) return
        const runtime = this.v4Runtime
        const epoch = this.recoveryReadOnlyEpoch
        const current = () => !this.unloaded
          && this.recoveryReadOnlyEpoch === epoch && this.v4Runtime === runtime
        this.recoveryReadOnlyCommandInProgress = true
        void (async () => {
          try {
            const backup = await runtime.verifyFencedReencryptionAuthenticatedWal()
            if (!current()) return
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
            const refs = await runtime.inspectFencedReencryptionCandidateGitRefs()
            if (!current()) return
            new Notice(refs?.destinationOrphanTopologyObserved
              ? (backup.completeDestinationContentsReverified && backup.recoveryLeaseReverified
                ? "GitHub Sync: Backup/Destination Git ref identities also match the saved candidate. Full Recovery/Cutover is not authorized, and Sync remains paused."
                : "GitHub Sync: GitHub Backup/Destination branch and commit identities match the saved candidate. This does NOT verify Destination contents or authorize full Recovery. Sync stays paused.")
              : "GitHub Sync: Destination GitHub ref topology is unavailable or differs from the saved candidate. Preserve both passphrases; Manual Recovery may be needed. Sync stays paused.",
            12000)
          } catch {
            if (current()) new Notice(
              "GitHub Sync: Read-only Backup/WAL verification unavailable. Sync stays paused; review Manual Recovery.",
              10000,
            )
          } finally {
            if (this.recoveryReadOnlyEpoch === epoch) this.recoveryReadOnlyCommandInProgress = false
          }
        })()
      },
    })

    this.addCommand({
      id: "verify-reencryption-complete-recovery-read-only",
      name: "GitHub Sync: Verify Complete Re-encryption Recovery (Read-only)",
      callback: () => {
        if (this.unloaded || this.recoveryReadOnlyCommandInProgress) return
        const runtime = this.v4Runtime
        const epoch = this.recoveryReadOnlyEpoch
        const current = () => !this.unloaded
          && this.recoveryReadOnlyEpoch === epoch && this.v4Runtime === runtime
        this.recoveryReadOnlyCommandInProgress = true
        void (async () => {
          try {
            new Notice(
              "GitHub Sync: Checking Old Backup, encrypted WAL and Destination (read-only). This may take time; no Cutover or Sync will run.",
              8000,
            )
            const report = await runtime.inspectFencedReencryptionCompleteRecovery()
            if (!current()) return
            if (report?.observation === "authenticated-complete-recovery-evidence-still-fenced"
              && report.integrityScope === "read-only-original-backup-encrypted-wal-complete-destination"
              && (report.isolation === "desktop-os-cooperative-wal-lock"
                || report.isolation === "mobile-cooperative-best-effort-only")
              && report.originalKeyAuthenticated && report.completeOldBackupReverified
              && report.walReceiptsBoundToDestination && report.completeDestinationContentsReverified
              && report.powerLossDurabilityProven === false
              && report.mobileOsLockProven === false
              && report.installedObsidianAcceptanceProven === false
              && report.commitDecisionAuthorized === false
              && report.localCutoverAuthorized === false
              && report.resumeSyncAuthorized === false
              && report.rollbackAuthorized === false
              && report.remoteWritesAuthorized === false
              && report.oldPassphraseCleanupAuthorized === false) {
              new Notice(
                report.isolation === "mobile-cooperative-best-effort-only"
                  ? "GitHub Sync: Old Backup, encrypted WAL and full Destination verified in a read-only Mobile scan. Mobile exclusion is best-effort only; no OS lock or power-loss durability is proven. Cutover and Sync stay blocked."
                  : "GitHub Sync: Old Backup, encrypted WAL and full Destination verified in a read-only Desktop scan with a cooperative WAL lock. Cutover, Sync restart and multi-device safety are not authorized.",
                12000,
              )
            } else {
              new Notice(
                "GitHub Sync: Complete Re-encryption Recovery could not be independently verified. Keep both passphrases and all recovery files; use Manual Recovery. Sync stays paused.",
                12000,
              )
            }
          } catch {
            if (current()) new Notice(
              "GitHub Sync: Read-only Complete Recovery check unavailable. Keep both passphrases; Sync stays paused.",
              12000,
            )
          } finally {
            if (this.recoveryReadOnlyEpoch === epoch) this.recoveryReadOnlyCommandInProgress = false
          }
        })()
      },
    })

    this.addCommand({
      id: "recover-staged-reencryption-key",
      name: "GitHub Sync: Recover staged Re-encryption key",
      callback: () => { void this.openStagedReencryptionKeyRecovery() },
    })

    // After the workspace layout is ready, run the startup sync once, then enable real-time watch
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return
      if (shouldRunStartupSync(this.settings)) {
        const startupSettings = this.settings
        const startupSettingsGeneration = this.settingsSaveAttemptGeneration
        // Delay 1.5 s to let Obsidian finish initialising.
        this.startupSyncTimeout = window.setTimeout(() => {
          this.startupSyncTimeout = null
          if (this.unloaded) return
          if (this.settingsSaveInProgress || this.settingsSaveAttemptGeneration !== startupSettingsGeneration
            || this.settings !== startupSettings || !shouldRunStartupSync(this.settings)) {
            this.enableWatch()
            return
          }
          const runtime = this.v4Runtime
          if (runtime) this.runSyncFromUi(() => runtime.startupSync())
        }, 1500)
      } else {
        this.enableWatch()
      }
    })
  }

  initGitHubClient() {
    // Never create a client for incomplete saved Settings or silently target main.
    if (hasGitHubSyncConfig(this.settings) && this.settings.githubBranch?.trim()
      && this.settings.vault?.trim()) {
      this.githubClient = new GitHubClient({
        token: this.settings.githubToken,
        owner: this.settings.githubOwner,
        repo: this.settings.githubRepo,
        branch: this.settings.githubBranch,
      }, {
        cooldownStore: this.cooldownStore,
        sleep: selectV4GitHubSchedulerSleep(Platform.isDesktopApp === true),
      });
    } else this.githubClient = undefined as unknown as GitHubClient
  }

  /** Installed recovery entry point. No branch/commit input from the user;
   * an authenticated missing slot is the only repairable state. */
  private async openStagedReencryptionKeyRecovery(): Promise<void> {
    if (this.unloaded || this.recoveryReadOnlyCommandInProgress) return
    const runtime = this.v4Runtime
    const epoch = this.recoveryReadOnlyEpoch
    const current = () => !this.unloaded && this.v4Runtime === runtime && this.recoveryReadOnlyEpoch === epoch
    this.recoveryReadOnlyCommandInProgress = true
    let modalOpened = false
    const release = () => {
      if (this.recoveryReadOnlyEpoch === epoch) this.recoveryReadOnlyCommandInProgress = false
    }
    try {
      new Notice("GitHub Sync: Checking staged Re-encryption recovery. Sync stays paused.", 8000)
      const inspected = await runtime.inspectInstalledStagedRecoveryFromDisk()
      if (!current()) return
      if (inspected?.report.observation === "authenticated-pre-cutover-destination-still-fenced"
        && inspected.report.stagedSecretReverified) {
        new Notice("GitHub Sync: Staged key and Destination verified. Cutover is not authorized; Sync stays paused.", 10000)
        return
      }
      if (!inspected?.report.stagedSecretMissing) {
        new Notice("GitHub Sync: Staged recovery could not be verified. Keep both passphrases and recovery files; use Manual Recovery. Sync stays paused.", 12000)
        return
      }
      const modal = new Modal(this.app)
      this.stagedRecoveryModal = modal
      let submitting = false
      modal.titleEl.setText("Recover staged Re-encryption key")
      modal.contentEl.addClass("github-sync-staged-secret-recovery")
      modal.contentEl.createEl("p", { text: "The new staged key is missing from SecretStorage. Enter the new passphrase used for this migration. The Destination must verify before the missing key is restored. Your old key and Settings remain unchanged; Sync stays paused." })
      const field = modal.contentEl.createEl("input", { type: "password", attr: { "aria-label": "New migration passphrase", autocomplete: "off" } })
      const button = modal.contentEl.createEl("button", { text: "Verify and restore missing key" })
      button.disabled = true
      field.addEventListener("input", () => { button.disabled = !field.value || submitting })
      modal.onClose = () => {
        field.value = ""
        modal.contentEl.empty()
        if (this.stagedRecoveryModal === modal) this.stagedRecoveryModal = null
        if (!submitting) release()
      }
      button.addEventListener("click", () => {
        if (!current() || submitting || this.stagedRecoveryModal !== modal || !field.value) return
        submitting = true
        button.disabled = true
        const passphrase = field.value
        field.value = ""
        modal.close()
        void (async () => {
          try {
            new Notice("GitHub Sync: Verifying the new passphrase against the frozen migration. Sync stays paused.", 8000)
            const report = await runtime.restoreInstalledStagedSecretFromDisk({
              expectedLocatorDigest: inspected.locatorDigest, newPassphrase: passphrase,
            })
            if (!current()) return
            new Notice(report?.stagedSecretRestored && report.stagedSecretReverified
              ? "GitHub Sync: Missing staged key restored and Destination verified. Keep both passphrases; Cutover is not authorized and Sync stays paused."
              : "GitHub Sync: Could not restore the missing staged key. Check the new passphrase and keep the recovery files. Sync stays paused.", 12000)
          } catch {
            if (current()) new Notice("GitHub Sync: Staged key recovery unavailable. Sync stays paused.", 10000)
          } finally { release() }
        })()
      })
      modal.open()
      modalOpened = true
    } catch {
      if (current()) new Notice("GitHub Sync: Staged key recovery unavailable. Keep the recovery files; Sync stays paused.", 10000)
    } finally {
      if (!modalOpened) release()
    }
  }

  override onunload() {
    this.unloaded = true
    this.recoveryReadOnlyEpoch++
    this.stagedRecoveryModal?.close()
    this.stagedRecoveryModal = null
    this.recoveryReadOnlyCommandInProgress = false
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
    const seconds = normalizeScheduledSyncIntervalSeconds(this.settings.scheduledSyncIntervalSeconds)
    const scheduledSettings = this.settings
    const scheduledGeneration = this.settingsSaveAttemptGeneration
    this.scheduledSyncTimer = window.setInterval(() => {
      if (this.unloaded || this.settingsSaveInProgress || this.settingsSaveAttemptGeneration !== scheduledGeneration
        || this.settings !== scheduledSettings || !shouldRunScheduledSync(this.settings)) return
      this.runSyncFromUi(() => this.v4Runtime.scheduledSync())
    }, seconds * 1000)
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
    const persisted = await this.loadData();
    const data = persisted ?? {};
    // Backward compatibility: older versions stored settings fields directly at the top level.
    const savedSettings = data.settings ?? data;
    const merged = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    // Only a genuinely new installation receives a unique local identity.
    // Preserve every existing (including legacy defaultVault) ID to avoid
    // splitting an established device's local index and conflict history.
    // The generated ID is persisted on the user's first normal Settings Save.
    if (persisted == null) merged.vault = this.createSecretId("device");
    // Preserve malformed legacy GitHub routing only for explicit user repair.
    // Every other persisted field remains strictly validated before secrets.
    const unsafeLegacyRouting = assertPluginSettingsRepairableOnLoad(merged)
    this.savedGitHubRoutingNeedsRepair = unsafeLegacyRouting
    this.secretStorageReadUnavailable = false
    let storageUnavailable = false
    const storage = this.app.secretStorage
    const observedStorage = {
      getSecret: (id: string) => {
        try { return storage.getSecret(id) }
        catch (error) { storageUnavailable = true; throw error }
      },
      setSecret: (id: string, value: string) => {
        try { storage.setSecret(id, value) }
        catch (error) { storageUnavailable = true; throw error }
      },
    }
    try {
      if (unsafeLegacyRouting || !await this.canMigrateStartupSecrets()) {
        // Fenced startup must not overwrite existing SecretStorage values.
        this.settings = hydrateV4SecretsReadOnly(merged, observedStorage) as PluginSettings
        this.secretsMigrated = false
        return
      }
      const result = migrateV4Secrets(
        merged, observedStorage, prefix => this.createSecretId(prefix),
      )
      this.settings = result.settings as PluginSettings
      this.secretsMigrated = result.migrated
    } catch (error) {
      if (!storageUnavailable) throw error
      // Keep persisted IDs and legacy values unchanged. Never use unverified
      // credentials or allow a Settings save to scrub them during this session.
      this.settings = { ...merged, githubToken: "", encryptionPassphrase: "",
        githubTokenSecretId: merged.githubTokenSecretId || "",
        encryptionPassphraseSecretId: merged.encryptionPassphraseSecretId || "" } as PluginSettings
      this.secretsMigrated = false
      this.secretStorageReadUnavailable = true
    }
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
    // A Cutover must not silently overwrite concurrent in-memory settings
    // edits (ignore rules, conflict policy, schedules, etc.), even when the
    // six Source connection fields remain unchanged. Keep a complete snapshot
    // in memory only; never log it because it includes credentials.
    const originalSettingsSnapshot = JSON.stringify(original)
    const assertOwner = () => {
      if (this.unloaded || !this.settingsSaveInProgress || this.isSyncInProgress
        || this.v4Runtime !== runtime || this.app.vault.adapter !== backing
        || this.settings !== original
        || JSON.stringify(this.settings) !== originalSettingsSnapshot) {
        throw new Error("Re-encryption Settings Cutover lost plugin/Settings ownership.")
      }
    }
    this.settingsSaveAttemptGeneration++
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
    assertPluginSettingsSavable(nextSettings)
    if (this.secretStorageReadUnavailable) throw new Error("GitHub Sync: SecretStorage unavailable. Restart Obsidian after restoring secure storage before saving Settings.")
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
    assertPluginSettingsSavable(prepared)
    const newTokenId = prepared.githubTokenSecretId !== previous.githubTokenSecretId
      ? prepared.githubTokenSecretId : ""
    const newPassphraseId = prepared.encryptionPassphraseSecretId !== previous.encryptionPassphraseSecretId
      ? prepared.encryptionPassphraseSecretId : ""
    const storage = this.app.secretStorage
    this.settingsSaveAttemptGeneration++
    this.settingsSaveInProgress = true
    let saveCommitted = false
    try {
      // Pause old-target local debounces before the first awaited Settings write.
      settingsRuntime?.settingsSaveStarted?.()
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
      saveCommitted = true
      // In-progress sessions pin their original settings and GitHub client.
      // The next session must not reuse a derived key after credential changes.
      this.v4Runtime?.credentialsChanged()
      if (!this.unloaded) {
        this.initGitHubClient()
        this.registerScheduledSync()
        this.updateRibbonIcon(hasGitHubSyncConfig(prepared))
        for (const leaf of this.app.workspace?.getLeavesOfType?.(V4_SYNC_CENTER_VIEW) ?? []) {
          if (leaf.view instanceof V4SyncCenterView) leaf.view.onSettingsSaved()
        }
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
      // An ambiguous Save failure cannot rearm unattended GitHub writes.
      settingsRuntime?.settingsSaveFinished?.(saveCommitted)
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
        this.runManualSyncFromUi()
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
    if (this.unloaded) return
    if (this.settingsSaveInProgress || this.settingTab?.isDirty()) {
      new Notice("GitHub Sync: Save or discard pending settings changes before syncing.")
      return
    }
    if (!this.requireConfiguredGitHubForUi()) return
    await new Promise<void>((resolve) => {
      const confirmedSettings = { ...this.settings }
      const confirmedGithubClient = this.githubClient
      const confirmedRuntime = this.v4Runtime
      const confirmedVault = this.app.vault
      const confirmedConfigDir = confirmedVault.configDir || ".obsidian"
      const confirmedPluginId = this.manifest.id
      const confirmedSaveGeneration = this.settingsSaveGeneration
      // Force approval must cover the SAME scope as Sync, including eligible
      // .obsidian files selected by Bookmarks, Plugins and Config toggles.
      let inForceScope: (path: string) => boolean
      try {
        inForceScope = createV4ScopePredicate({
          configDir: confirmedConfigDir,
          pluginId: confirmedPluginId,
          ignorePathRegex: confirmedSettings.ignorePathRegex,
          syncObsidianConfig: confirmedSettings.syncObsidianConfig,
          syncBookmarks: confirmedSettings.syncBookmarks,
          syncPlugins: confirmedSettings.syncPlugins,
        })
      } catch {
        new Notice("GitHub Sync: Cannot inspect configured Sync scope. Review Settings before Force.")
        resolve()
        return
      }
      // Bind approval to scoped paths and file metadata, not just the count.
      // Background edits can change notes while the modal is open.
      const visibleVaultFiles = () => confirmedVault.getFiles()
        .filter(file => inForceScope(file.path))
        .map(file => {
          const { size, mtime } = file.stat
          if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtime)) {
            throw new Error("Invalid local file metadata.")
          }
          return { path: file.path, size, mtime }
        })
        .sort((a, b) => a.path.localeCompare(b.path))
      let confirmedLocalFiles: ReturnType<typeof visibleVaultFiles>
      try {
        confirmedLocalFiles = visibleVaultFiles()
      } catch {
        new Notice("GitHub Sync: Could not inspect local vault files. Force confirmation is unavailable until the vault can be read.")
        resolve()
        return
      }
      const modal = new Modal(this.app)
      // A same-size rewrite can retain its mtime (e.g. editor replace/restore).
      // Invalidate the one-time destructive approval on Obsidian Vault events,
      // even when a second inventory scan cannot distinguish the contents.
      // Keep the metadata scan as a separate safety check for missed events.
      let visibleVaultChanged = false
      // An unexpected malformed event path must fail closed, not crash the
      // listener or accidentally authorize a destructive operation.
      const isVisible = (path: string): boolean => {
        try { return inForceScope(path) }
        catch { return true }
      }
      const onFileChange = (file: { path: string }) => {
        if (isVisible(file.path)) visibleVaultChanged = true
      }
      const changeRefs = [
        confirmedVault.on("create", onFileChange),
        confirmedVault.on("modify", onFileChange),
        confirmedVault.on("delete", onFileChange),
        confirmedVault.on("rename", (file, oldPath) => {
          if (isVisible(file.path) || isVisible(oldPath)) visibleVaultChanged = true
        }),
      ]
      let listenersReleased = false
      const releaseChangeListeners = () => {
        if (listenersReleased) return
        listenersReleased = true
        for (const ref of changeRefs) confirmedVault.offref(ref)
      }
      const sameVisibleVaultInventory = (): boolean => {
        try {
          const currentFiles = visibleVaultFiles()
          return currentFiles.length === confirmedLocalFiles.length
            && currentFiles.every((file, index) => {
              const confirmed = confirmedLocalFiles[index]
              return confirmed !== undefined && file.path === confirmed.path
                && file.size === confirmed.size && file.mtime === confirmed.mtime
            })
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
        && this.settingsSaveGeneration === confirmedSaveGeneration
        && !visibleVaultChanged
        && this.v4Runtime === confirmedRuntime
        && this.app.vault === confirmedVault
        && (confirmedVault.configDir || ".obsidian") === confirmedConfigDir
        && this.manifest.id === confirmedPluginId
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
        releaseChangeListeners()
        resolved = true
        finish()
      }
      const repo = `${confirmedSettings.githubOwner}/${confirmedSettings.githubRepo}`
      const branch = confirmedSettings.githubBranch
      const localFileCount = confirmedLocalFiles.length

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
            new Notice("GitHub Sync: Force confirmation expired because Sync settings or local vault files changed. Review the current target and confirm again.")
          }
          return
        }
        resolved = true
        modal.close()
        if (operation === "forcePush") this.runSyncFromUi(() => confirmedRuntime.forcePush())
        else this.runSyncFromUi(() => confirmedRuntime.forcePull())
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
