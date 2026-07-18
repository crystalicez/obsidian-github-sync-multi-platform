import { Modal, Notice, TFile } from "obsidian"
import type FastSync from "../../main"
import { fromBase64Url, randomBytes, toBase64Url } from "../bytes"
import { readVaultFileBytes, writeVaultFileBytes, deleteVaultFileIfExists } from "../vault"
import { deriveV4Keyring } from "./crypto"
import {
  createEmptyV4LocalIndex,
  loadV4LocalIndex,
  saveV4LocalIndex,
  type V4LocalIndex,
  type V4LocalIndexAdapter,
} from "./local-index"
import { decodeV4RemoteConfig } from "./remote-index"
import { createV4ScopePredicate, isPathInV4SyncScope } from "./scope"
import { assertV4PathLayoutCompatible, V4ChangeGuardError, V4SyncSession, type V4SyncRunState } from "./sync-session"
import type { V4ConflictResolution } from "./conflicts"
import { V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "./sync-coordinator"
import { expectedV4PathLayout, V4_FORMAT_VERSION, V4_CONFIG_PATH, type V4RemoteConfig, type V4StorageMode } from "./protocol-types"
import { V4HistoryService } from "./history-service"
import { V4ProgressStore, type V4SyncProgressSnapshot } from "./progress"

const V4_INDEX_ROOT = "github-sync-v4-index"
const fallbackStores = new WeakMap<object, Map<string, string>>()

export function selectV4RuntimeConfig(discovered: V4RemoteConfig | null, mode: V4StorageMode, repoId: string): V4RemoteConfig {
  if (discovered?.mode === mode) return { ...discovered, repoId, pathLayout: expectedV4PathLayout(mode) }
  if (mode === "plaintext") return { formatVersion: V4_FORMAT_VERSION, mode, repoId, pathLayout: expectedV4PathLayout(mode) }
  return {
    formatVersion: V4_FORMAT_VERSION,
    mode,
    repoId,
    pathLayout: expectedV4PathLayout(mode),
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: toBase64Url(randomBytes(16)) },
  }
}

function createMemoryAdapter(owner: object): V4LocalIndexAdapter {
  let store = fallbackStores.get(owner)
  if (!store) { store = new Map(); fallbackStores.set(owner, store) }
  return {
    async read(path) { const value = store!.get(path); if (value === undefined) throw new Error(`Missing V4 index: ${path}`); return value },
    async write(path, value) { store!.set(path, value) },
    async exists(path) { return store!.has(path) },
    async mkdir() {},
  }
}

function createIndexAdapter(plugin: FastSync): V4LocalIndexAdapter {
  const vault = plugin.app.vault as FastSync["app"]["vault"] & {
    configDir?: string
    adapter?: { read(path: string): Promise<string>; write(path: string, data: string): Promise<void>; exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void> }
  }
  if (!vault.adapter) return createMemoryAdapter(plugin)
  const base = `${vault.configDir || ".obsidian"}/plugins/${plugin.manifest.id}`
  const resolve = (path: string) => `${base}/${path.replace(/^\/+/, "")}`
  return {
    read: path => vault.adapter!.read(resolve(path)),
    write: (path, value) => vault.adapter!.write(resolve(path), value),
    exists: path => vault.adapter!.exists(resolve(path)),
    mkdir: async path => { try { await vault.adapter!.mkdir(resolve(path)) } catch (error) { if (!/exist/i.test((error as Error).message)) throw error } },
  }
}

export class V4PluginRuntime {
  private readonly coordinator: V4SyncCoordinator
  private readonly adapter: V4LocalIndexAdapter
  private readonly progressStore = new V4ProgressStore()
  private debounceRunActive = false
  private disposed = false

  constructor(private readonly plugin: FastSync) {
    this.adapter = createIndexAdapter(plugin)
    this.coordinator = new V4SyncCoordinator({
      execute: (request, changes) => this.execute(request, changes),
      notice: message => new Notice(message),
      debounceMs: 5_000,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.debounceRunActive = false
    this.coordinator.dispose()
    this.progressStore.dispose()
  }
  get isSyncing(): boolean { return this.coordinator.isSyncing }
  get pendingCount(): number { return this.coordinator.pendingCount }
  get progressSnapshot(): V4SyncProgressSnapshot {
    return this.snapshotForConsumers(this.progressStore.snapshot)
  }

  subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void {
    return this.progressStore.subscribe(snapshot => listener(this.snapshotForConsumers(snapshot)))
  }

  manualSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "manual" }) }
  startupSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "startup" }) }
  scheduledSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "scheduled" }) }
  forcePush(allowThresholdOverride = false): Promise<unknown> { return this.coordinator.run({ operation: "forcePush", trigger: "forcePush", allowThresholdOverride }) }
  forcePull(allowThresholdOverride = false): Promise<unknown> { return this.coordinator.run({ operation: "forcePull", trigger: "forcePull", allowThresholdOverride }) }

  async createHistoryService(): Promise<V4HistoryService> {
    this.assertNotDisposed()
    const loaded = await this.loadConfiguredRemoteConfig()
    if (!loaded) throw new Error("V4 history is not initialized. Force Push first.")
    const { remoteConfig, config } = loaded
    assertV4PathLayoutCompatible(remoteConfig, config, "normal")
    const keyring = config.mode === "encrypted"
      ? await deriveV4Keyring({
        passphrase: this.plugin.settings.encryptionPassphrase,
        repoId: config.repoId,
        salt: fromBase64Url(config.kdfParams!.salt),
        iterations: config.kdfParams!.iterations,
      })
      : undefined
    return new V4HistoryService({ github: this.plugin.githubClient, config, keyring })
  }

  async fileIdForPath(path: string): Promise<string | null> {
    this.assertNotDisposed()
    const loaded = await this.loadConfiguredRemoteConfig()
    if (!loaded) throw new Error("V4 history is not initialized. Force Push first.")
    assertV4PathLayoutCompatible(loaded.remoteConfig, loaded.config, "normal")
    const config = loaded.config
    const index = await this.loadIndex(config)
    for (const shard of Object.values(index.shards)) {
      for (const record of Object.values(shard.records)) if (!record.deleted && record.path === path) return record.fileId
    }
    return null
  }

  enqueueModify(path: string, mtime: number): void { this.enqueue({ type: "modify", path, mtime }) }
  enqueueDelete(path: string): void { this.enqueue({ type: "delete", path, mtime: Date.now() }) }
  enqueueRename(oldPath: string, path: string): void { this.enqueue({ type: "rename", oldPath, path, mtime: Date.now() }) }
  enqueueFolderRename(oldPath: string, path: string): void { this.enqueue({ type: "folderRename", oldPath, path, mtime: Date.now() }) }
  enqueueFolderDelete(path: string): void { this.enqueue({ type: "folderDelete", path, mtime: Date.now() }) }
  enqueueRescan(): void { this.enqueue({ type: "rescan", mtime: Date.now() }) }

  private enqueue(change: V4QueuedChange): void {
    if (this.disposed) return
    if (!this.plugin.settings.syncEnabled || !this.plugin.settings.syncOnLocalChange || !this.plugin.isWatchEnabled) return
    if (change.type === "rescan") {
      this.coordinator.enqueue(change)
      this.markWaiting()
      return
    }
    if (this.plugin.ignoredFiles.has(change.path)) return
    try {
      const oldPath = change.type === "rename" || change.type === "replace" || change.type === "folderRename" ? change.oldPath : undefined
      if (!this.inScope(change.path) && (!oldPath || !this.inScope(oldPath))) return
    } catch (error) {
      new Notice(`GitHub Sync: Invalid ignore regex: ${(error as Error).message}`)
      return
    }
    this.coordinator.enqueue(change)
    this.markWaiting()
  }

  private markWaiting(): void {
    if (this.coordinator.isSyncing) return
    this.beginWaitingRun()
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("V4 runtime is disposed.")
  }

  private beginWaitingRun(): void {
    const push = { completed: 0, total: this.coordinator.pendingCount }
    if (!this.debounceRunActive) {
      this.debounceRunActive = true
      this.progressStore.beginRun({
        phase: "debouncing",
        operation: "normal",
        trigger: "localChange",
        attempt: 0,
        pull: { completed: 0 },
        push,
      })
    } else {
      this.progressStore.update({ push })
    }
  }

  private snapshotForConsumers(snapshot: V4SyncProgressSnapshot): V4SyncProgressSnapshot {
    return this.debounceRunActive && snapshot.lifecycle === "active" && snapshot.phase === "debouncing"
      ? Object.freeze({ ...snapshot, lifecycle: "waiting" as const })
      : snapshot
  }

  private inScope(path: string): boolean {
    return isPathInV4SyncScope(path, {
        configDir: this.plugin.app.vault.configDir || ".obsidian",
        pluginId: this.plugin.manifest.id,
        ignorePathRegex: this.plugin.settings.ignorePathRegex,
        syncObsidianConfig: this.plugin.settings.syncObsidianConfig,
        syncBookmarks: this.plugin.settings.syncBookmarks,
        syncPlugins: this.plugin.settings.syncPlugins,
    })
  }

  private scopePredicate(): (path: string) => boolean {
    return createV4ScopePredicate({
      configDir: this.plugin.app.vault.configDir || ".obsidian",
      pluginId: this.plugin.manifest.id,
      ignorePathRegex: this.plugin.settings.ignorePathRegex,
      syncObsidianConfig: this.plugin.settings.syncObsidianConfig,
      syncBookmarks: this.plugin.settings.syncBookmarks,
      syncPlugins: this.plugin.settings.syncPlugins,
    })
  }

  private repoId(): string {
    return `${this.plugin.settings.githubOwner}/${this.plugin.settings.githubRepo}#${this.plugin.settings.githubBranch || "main"}`
  }

  private async loadConfiguredRemoteConfig(): Promise<{ remoteConfig: V4RemoteConfig; config: V4RemoteConfig } | null> {
    if (!this.plugin.githubClient) throw new Error("GitHub connection is not configured.")
    const ref = await this.plugin.githubClient.getGitRefOrNull()
    const remote = ref ? await this.plugin.githubClient.getFileBytes(V4_CONFIG_PATH, ref.sha) : null
    if (!remote) return null
    const remoteConfig = decodeV4RemoteConfig(remote.bytes)
    const config = selectV4RuntimeConfig(remoteConfig, remoteConfig.mode, this.repoId())
    if (remoteConfig.repoId !== config.repoId) throw new Error("V4 remote repository identity mismatch.")
    return { remoteConfig, config }
  }

  private async remoteOrNewConfig(): Promise<V4RemoteConfig> {
    const loaded = await this.loadConfiguredRemoteConfig()
    if (loaded) return loaded.config
    const mode = this.plugin.settings.encryptionMode
    return selectV4RuntimeConfig(null, mode, this.repoId())
  }

  private async loadIndex(config: V4RemoteConfig): Promise<V4LocalIndex> {
    const loaded = await loadV4LocalIndex(this.adapter, V4_INDEX_ROOT)
    const pathLayout = config.pathLayout ?? expectedV4PathLayout(config.mode)
    if (loaded.repoId === config.repoId && loaded.mode === config.mode && loaded.pathLayout === pathLayout) return loaded
    return createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: this.plugin.settings.vault || "defaultVault", mode: config.mode, pathLayout: config.pathLayout })
  }

  private async saveIndex(index: V4LocalIndex, previousShardHashes: Record<string, string> = {}): Promise<void> {
    await saveV4LocalIndex(this.adapter, V4_INDEX_ROOT, index, previousShardHashes)
  }

  private sessionVault(inScope = this.scopePredicate()) {
    return {
      listFiles: async () => this.plugin.app.vault.getFiles().filter(file => inScope(file.path)).map(file => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime })),
      stat: async (path: string) => {
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        return file instanceof TFile && inScope(path) ? { path, size: file.stat.size, mtime: file.stat.mtime } : null
      },
      read: async (path: string) => {
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`)
        return readVaultFileBytes(this.plugin.app.vault, file)
      },
      write: async (path: string, bytes: Uint8Array) => {
        this.plugin.addIgnoredFile(path)
        try { await writeVaultFileBytes(this.plugin.app.vault, path, bytes) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      delete: async (path: string) => {
        this.plugin.addIgnoredFile(path)
        try { await deleteVaultFileIfExists(this.plugin.app.vault, path) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
    }
  }

  private async execute(request: V4SyncRequest, changes: V4QueuedChange[]): Promise<{ changedFiles: number }> {
    const continuingDebounceRun = this.debounceRunActive
    this.debounceRunActive = false
    const runPatch = {
      operation: request.operation,
      trigger: request.trigger,
      attempt: 1,
      currentPath: undefined,
      currentDirection: undefined,
      pull: { completed: 0, total: undefined },
      push: { completed: 0, total: undefined },
      errorMessage: undefined,
      failurePhase: undefined,
      failurePath: undefined,
    } as const
    if (continuingDebounceRun) this.progressStore.update({ ...runPatch, lifecycle: "active", phase: "checking-remote" })
    else {
      this.progressStore.beginRun(runPatch)
      this.progressStore.update({ phase: "checking-remote" })
    }
    if (request.trigger === "startup") this.plugin.enableWatch()
    this.plugin.isSyncInProgress = true
    try {
      if (!this.plugin.githubClient) throw new Error("GitHub connection is not configured.")
      let lastError: unknown
      let progressAttempt = 0
      const runState: V4SyncRunState = { conflictCopies: new Map() }
      for (let casAttempt = 1; casAttempt <= 3; casAttempt++) {
        try {
          progressAttempt++
          this.progressStore.update({
            phase: "checking-remote",
            attempt: progressAttempt,
            currentPath: undefined,
            currentDirection: undefined,
          })
          const discovered = await this.remoteOrNewConfig()
          const desiredMode = this.plugin.settings.encryptionMode
          if (discovered.mode !== desiredMode && desiredMode === "encrypted") {
            throw new Error("Encrypted V4 requires a new empty repository or branch; plaintext history cannot be retained.")
          }
          if (discovered.mode !== desiredMode && request.operation !== "forcePush") {
            throw new Error("Remote storage mode differs. Force Push is required.")
          }
          const config = selectV4RuntimeConfig(discovered, desiredMode, this.repoId())
          this.progressStore.update({ phase: "loading-index", currentPath: undefined, currentDirection: undefined })
          const index = await this.loadIndex(config)
          const previousShardHashes = { ...index.shardHashes }
          const passphrase = this.plugin.settings.encryptionPassphrase
          const authenticationConfig = discovered.mode === "encrypted" ? discovered : config.mode === "encrypted" ? config : null
          if (authenticationConfig && !passphrase) throw new Error("Encryption passphrase is required.")
          const keyring = authenticationConfig
            ? await deriveV4Keyring({ passphrase, repoId: authenticationConfig.repoId, salt: fromBase64Url(authenticationConfig.kdfParams!.salt), iterations: authenticationConfig.kdfParams!.iterations })
            : undefined
          const inScope = this.scopePredicate()
          const includePath = (path: string): boolean => {
            for (const copy of runState.conflictCopies.values()) {
              if (copy.path === path) return copy.includeInSync
            }
            return inScope(path)
          }
          const result = await new V4SyncSession({
            github: this.plugin.githubClient,
            vault: this.sessionVault(includePath),
            index,
            config,
            keyring,
            conflictPolicy: this.plugin.settings.conflictPolicy,
            abortChangePercent: this.plugin.settings.abortChangePercent,
            askConflict: input => this.askConflict(input.path),
            includePath,
            runState,
            onProgress: patch => {
              if (patch.phase === "checking-remote") return
              this.progressStore.update(patch)
            },
          }).sync({ operation: request.operation, allowThresholdOverride: !!request.allowThresholdOverride, changes })
          this.progressStore.update({ phase: "saving-index", currentPath: undefined, currentDirection: undefined })
          await this.saveIndex(index, previousShardHashes)
          if (result.changedFiles === 0 && request.trigger === "manual") new Notice("GitHub Sync: No changes")
          this.progressStore.finish(result.changedFiles === 0 ? "no-change" : "success", { lastSyncTime: Date.now() })
          return { changedFiles: result.changedFiles }
        } catch (error) {
          lastError = error
          if (error instanceof V4ChangeGuardError && !request.allowThresholdOverride && request.operation !== "normal") {
            this.progressStore.update({ phase: "blocked", currentPath: undefined, currentDirection: undefined })
            const confirmed = await this.confirmThresholdOverride(error, request.operation)
            if (!confirmed) throw new Error("Sync cancelled because the modification threshold was exceeded.")
            request.allowThresholdOverride = true
            casAttempt--
            continue
          }
          if (casAttempt === 3 || !/branch head changed|stale ref/i.test((error as Error).message)) throw error
          this.progressStore.update({
            phase: "retrying",
            attempt: progressAttempt + 1,
            currentPath: undefined,
            currentDirection: undefined,
            pull: { completed: 0, total: undefined },
            push: { completed: 0, total: undefined },
          })
        }
      }
      throw lastError
    } catch (error) {
      const message = (error as Error).message
      this.progressStore.finish("failed", { errorMessage: message })
      new Notice(`GitHub Sync failed: ${message}`)
      return { changedFiles: 0 }
    } finally {
      this.plugin.isSyncInProgress = false
      if (!this.disposed) {
        this.plugin.enableWatch()
        if (this.coordinator.pendingCount > 0) this.beginWaitingRun()
      }
    }
  }

  private async askConflict(path: string): Promise<V4ConflictResolution> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app)
      let settled = false
      const finish = (resolution: V4ConflictResolution) => {
        if (settled) return
        settled = true
        modal.close()
        resolve(resolution)
      }
      modal.onClose = () => { if (!settled) { settled = true; resolve({ action: "ask" }) } }
      modal.titleEl.setText("Resolve sync conflict")
      modal.contentEl.createEl("p", { text: `Both local and remote changed: ${path}` })
      const buttons = modal.contentEl.createDiv()
      buttons.createEl("button", { text: "Keep both" }).onclick = () => finish({ action: "keep-local-copy-remote" })
      buttons.createEl("button", { text: "Use local" }).onclick = () => finish({ action: "use-local" })
      buttons.createEl("button", { text: "Use remote" }).onclick = () => finish({ action: "use-remote" })
      buttons.createEl("button", { text: "Cancel" }).onclick = () => finish({ action: "ask" })
      modal.open()
    })
  }

  private async confirmThresholdOverride(error: V4ChangeGuardError, operation: "forcePush" | "forcePull"): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app)
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        modal.close()
        resolve(value)
      }
      modal.onClose = () => { if (!settled) { settled = true; resolve(false) } }
      modal.titleEl.setText("Modification threshold exceeded")
      modal.contentEl.createEl("p", { text: `${error.changePercent}% of logical files would change; the limit is ${error.thresholdPercent}%.` })
      modal.contentEl.createEl("p", { text: "Override the guard for this force operation only?" })
      const buttons = modal.contentEl.createDiv()
      buttons.createEl("button", { text: "Cancel" }).onclick = () => finish(false)
      const confirm = buttons.createEl("button", { text: operation === "forcePush" ? "Override and force push" : "Override and force pull" })
      confirm.addClass("mod-warning")
      confirm.onclick = () => finish(true)
      modal.open()
    })
  }
}
