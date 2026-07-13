import { Modal, Notice, TFile } from "obsidian"
import type FastSync from "../../main"
import { fromBase64Url, randomBytes, toBase64Url } from "../bytes"
import { readVaultFileBytes, writeVaultFileBytes, deleteVaultFileIfExists } from "../vault"
import { deriveV4Keyring } from "./crypto"
import {
  createEmptyV4LocalIndex,
  loadV4LocalIndex,
  saveV4LocalIndexHeader,
  saveV4LocalIndexShard,
  type V4LocalIndex,
  type V4LocalIndexAdapter,
} from "./local-index"
import { decodeV4RemoteConfig } from "./remote-index"
import { createV4ScopePredicate, isPathInV4SyncScope } from "./scope"
import { V4ChangeGuardError, V4SyncSession } from "./sync-session"
import type { V4ConflictResolution } from "./conflicts"
import { V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "./sync-coordinator"
import { V4_FORMAT_VERSION, V4_CONFIG_PATH, type V4RemoteConfig } from "./protocol-types"
import { V4HistoryService } from "./history-service"

const V4_INDEX_ROOT = "github-sync-v4-index"
const fallbackStores = new WeakMap<object, Map<string, string>>()

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

  constructor(private readonly plugin: FastSync) {
    this.adapter = createIndexAdapter(plugin)
    this.coordinator = new V4SyncCoordinator({
      execute: (request, changes) => this.execute(request, changes),
      notice: message => new Notice(message),
      debounceMs: 5_000,
    })
  }

  dispose(): void { this.coordinator.dispose() }
  get isSyncing(): boolean { return this.coordinator.isSyncing }
  get pendingCount(): number { return this.coordinator.pendingCount }

  manualSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "manual" }) }
  startupSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "startup" }) }
  scheduledSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "scheduled" }) }
  forcePush(allowThresholdOverride = false): Promise<unknown> { return this.coordinator.run({ operation: "forcePush", trigger: "forcePush", allowThresholdOverride }) }
  forcePull(allowThresholdOverride = false): Promise<unknown> { return this.coordinator.run({ operation: "forcePull", trigger: "forcePull", allowThresholdOverride }) }

  async createHistoryService(): Promise<V4HistoryService> {
    if (!this.plugin.githubClient) throw new Error("GitHub connection is not configured.")
    const ref = await this.plugin.githubClient.getGitRefOrNull()
    const remote = ref ? await this.plugin.githubClient.getFileBytes(V4_CONFIG_PATH, ref.sha) : null
    if (!remote) throw new Error("V4 history is not initialized. Force Push first.")
    const config = decodeV4RemoteConfig(remote.bytes)
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
    const config = await this.remoteOrNewConfig()
    const index = await this.loadIndex(config)
    for (const shard of Object.values(index.shards)) {
      for (const record of Object.values(shard.records)) if (!record.deleted && record.path === path) return record.fileId
    }
    return null
  }

  enqueueModify(path: string, mtime: number): void { this.enqueue({ type: "modify", path, mtime }) }
  enqueueDelete(path: string): void { this.enqueue({ type: "delete", path, mtime: Date.now() }) }
  enqueueRename(oldPath: string, path: string): void { this.enqueue({ type: "rename", oldPath, path, mtime: Date.now() }) }
  enqueueRescan(): void { this.enqueue({ type: "rescan", mtime: Date.now() }) }

  private enqueue(change: V4QueuedChange): void {
    if (!this.plugin.settings.syncEnabled || !this.plugin.settings.syncOnLocalChange || !this.plugin.isWatchEnabled) return
    if (change.type === "rescan") {
      this.coordinator.enqueue(change)
      this.markWaiting()
      return
    }
    if (this.plugin.ignoredFiles.has(change.path)) return
    try {
      if (!this.inScope(change.path) && (change.type !== "rename" || !this.inScope(change.oldPath))) return
    } catch (error) {
      new Notice(`GitHub Sync: Invalid ignore regex: ${(error as Error).message}`)
      return
    }
    this.coordinator.enqueue(change)
    this.markWaiting()
  }

  private markWaiting(): void {
    this.plugin.syncProgress = {
      ...this.plugin.syncProgress,
      status: "waiting",
      totalPush: this.coordinator.pendingCount,
      pushCount: 0,
    }
    this.plugin.updateStatusBar()
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

  private async remoteOrNewConfig(): Promise<V4RemoteConfig> {
    const ref = await this.plugin.githubClient.getGitRefOrNull()
    const remote = ref ? await this.plugin.githubClient.getFileBytes(V4_CONFIG_PATH, ref.sha) : null
    if (remote) return decodeV4RemoteConfig(remote.bytes)
    const mode = this.plugin.settings.encryptionMode
    if (mode === "plaintext") return { formatVersion: V4_FORMAT_VERSION, mode, repoId: this.repoId() }
    return {
      formatVersion: V4_FORMAT_VERSION,
      mode,
      repoId: this.repoId(),
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: 600_000, salt: toBase64Url(randomBytes(16)) },
    }
  }

  private async loadIndex(config: V4RemoteConfig): Promise<V4LocalIndex> {
    const loaded = await loadV4LocalIndex(this.adapter, V4_INDEX_ROOT)
    if (loaded.repoId === config.repoId && loaded.mode === config.mode) return loaded
    return createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: this.plugin.settings.vault || "defaultVault", mode: config.mode })
  }

  private async saveIndex(index: V4LocalIndex, previousShardHashes: Record<string, string> = {}): Promise<void> {
    for (const bucket of Object.keys(index.shards)) {
      if (previousShardHashes[bucket] !== index.shardHashes[bucket]) await saveV4LocalIndexShard(this.adapter, V4_INDEX_ROOT, index, bucket)
    }
    await saveV4LocalIndexHeader(this.adapter, V4_INDEX_ROOT, index)
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
    if (!this.plugin.githubClient) {
      const message = "GitHub connection is not configured."
      this.plugin.syncProgress = { status: "fail", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: this.plugin.syncProgress.lastSyncTime, errorMessage: message }
      new Notice(`GitHub Sync failed: ${message}`)
      this.plugin.updateStatusBar()
      return { changedFiles: 0 }
    }
    if (request.trigger === "startup") this.plugin.enableWatch()
    this.plugin.isSyncInProgress = true
    this.plugin.syncProgress = { status: "syncing", pushCount: 0, totalPush: changes.length, pullCount: 0, totalPull: 0, lastSyncTime: this.plugin.syncProgress.lastSyncTime }
    this.plugin.updateStatusBar()
    try {
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const discovered = await this.remoteOrNewConfig()
          const desiredMode = this.plugin.settings.encryptionMode
          if (discovered.mode !== desiredMode && desiredMode === "encrypted") {
            throw new Error("Encrypted V4 requires a new empty repository or branch; plaintext history cannot be retained.")
          }
          if (discovered.mode !== desiredMode && request.operation !== "forcePush") {
            throw new Error("Remote storage mode differs. Force Push is required.")
          }
          const config: V4RemoteConfig = discovered.mode === desiredMode
            ? discovered
            : { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: this.repoId() }
          const index = await this.loadIndex(config)
          const previousShardHashes = { ...index.shardHashes }
          const passphrase = this.plugin.settings.encryptionPassphrase
          if (config.mode === "encrypted" && !passphrase) throw new Error("Encryption passphrase is required.")
          const keyring = config.mode === "encrypted"
            ? await deriveV4Keyring({ passphrase, repoId: config.repoId, salt: fromBase64Url(config.kdfParams!.salt), iterations: config.kdfParams!.iterations })
            : undefined
          const inScope = this.scopePredicate()
          const result = await new V4SyncSession({
            github: this.plugin.githubClient,
            vault: this.sessionVault(inScope),
            index,
            config,
            keyring,
            conflictPolicy: this.plugin.settings.conflictPolicy,
            abortChangePercent: this.plugin.settings.abortChangePercent,
            askConflict: input => this.askConflict(input.path),
            includePath: inScope,
          }).sync({ operation: request.operation, allowThresholdOverride: !!request.allowThresholdOverride, changes })
          await this.saveIndex(index, previousShardHashes)
          this.plugin.syncProgress = {
            status: "success",
            pushCount: result.pushedFiles,
            totalPush: result.pushedFiles,
            pullCount: result.pulledFiles,
            totalPull: result.pulledFiles,
            lastSyncTime: Date.now(),
          }
          if (result.changedFiles === 0 && request.trigger === "manual") new Notice("GitHub Sync: No changes")
          return { changedFiles: result.changedFiles }
        } catch (error) {
          lastError = error
          if (error instanceof V4ChangeGuardError && !request.allowThresholdOverride && request.operation !== "normal") {
            const confirmed = await this.confirmThresholdOverride(error, request.operation)
            if (!confirmed) throw new Error("Sync cancelled because the modification threshold was exceeded.")
            request.allowThresholdOverride = true
            attempt--
            continue
          }
          if (attempt === 3 || !/branch head changed|stale ref/i.test((error as Error).message)) throw error
        }
      }
      throw lastError
    } catch (error) {
      const message = (error as Error).message
      this.plugin.syncProgress = { status: "fail", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: this.plugin.syncProgress.lastSyncTime, errorMessage: message }
      new Notice(`GitHub Sync failed: ${message}`)
      return { changedFiles: 0 }
    } finally {
      this.plugin.isSyncInProgress = false
      this.plugin.enableWatch()
      this.plugin.updateStatusBar()
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
