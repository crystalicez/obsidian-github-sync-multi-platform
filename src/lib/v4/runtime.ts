import { Modal, Notice, Platform, TFile } from "obsidian"
import type FastSync from "../../main"
import { fromBase64Url, randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { syncConsoleLog } from "../debug"
import { assertPluginSettingsRuntimeSafe } from "../plugin-settings-validation"
import { readVaultFileBytes, removeEmptyVaultFolderIfExists, writeVaultFileBytes, trashVaultFileIfExists } from "../vault"
import { deriveV4BootstrapRecoveryKey, deriveV4Keyring, type V4Keyring } from "./crypto"
import {
  createEmptyV4LocalIndex,
  loadV4LocalIndex,
  saveV4LocalIndex,
  type V4LocalIndex,
  type V4LocalIndexAdapter,
} from "./local-index"
import { decodeV4RemoteConfig } from "./remote-index"
import { createV4ScopePredicate, isPathInV4SyncScope } from "./scope"
import { assertV4PathLayoutCompatible, V4ChangeGuardError, V4RecoveryReplanRequiredError, V4SyncSession, type V4SyncRunState } from "./sync-session"
import type { V4ConflictResolution } from "./conflicts"
import { buildV4ConflictReview, buildV4ConflictReviewAsync, canPrepareV4ConflictReviewPair, decodeV4ReviewText, mergeV4ReviewedLines, v4ReviewLineKey, V4_REVIEW_MAX_BYTES, V4_REVIEW_MAX_RESULT_BYTES, type V4ReviewLineDecision, type V4ReviewChoice, type V4ReviewSection } from "./conflict-review"
import { V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "./sync-coordinator"
import { expectedV4PathLayout, V4_FORMAT_VERSION, V4_CONFIG_PATH, V4_PBKDF2_ITERATIONS, type V4RemoteConfig, type V4StorageMode } from "./protocol-types"
import { V4HistoryService } from "./history-service"
import { buildV4FileOverview, type V4FileOverview } from "./file-overview"
import { loadV4RemoteState } from "./remote-loader"
import type { V4SessionVault } from "./local-io"
import { createV4ContentSource, createV4WholeBufferContentSource, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, type V4ContentSource } from "./content-source"
import { createV4PlatformIo, type V4BinaryAdapterLike, type V4PlatformIo } from "./platform-io"
import { createV4StagingStore, type V4StagingStore } from "./staging-store"
import { V4ProgressStore, type V4SyncProgressSnapshot } from "./progress"
import { createV4RecoveryStore, discardV4RecoveryStages, markV4RecoveryIndexCommitted, recoverV4PendingState, V4RecoveryRequiredError } from "./recovery-store"
import { V4KeyringCache } from "./keyring-cache"
import { V4CancelledError, throwIfV4Aborted } from "./cancellation"
import { V4PublicationRaceError, isV4PublicationRaceError } from "./publication-race"
import { assertV4SpeculativeConfigStillAbsent, guardV4SpeculativeConfigGithub } from "./speculative-config-guard"

const V4_INDEX_ROOT = "github-sync-v4-index"
const V4_STAGE_ROOT = "github-sync-v4-stage"
const V4_RECOVERY_ROOT = "github-sync-v4-recovery"
const fallbackStores = new WeakMap<object, Map<string, string>>()

type V4RuntimeConfigSource = "observed-remote" | "speculative-empty"
interface V4RuntimeConfigSelection {
  config: V4RemoteConfig
  source: V4RuntimeConfigSource
}

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
    kdfParams: { iterations: V4_PBKDF2_ITERATIONS, salt: toBase64Url(randomBytes(16)) },
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

function createRuntimePlatformIo(plugin: FastSync): { io: V4PlatformIo; stageRoot: string } {
  const vault = plugin.app.vault as FastSync["app"]["vault"] & {
    configDir?: string
    adapter?: V4BinaryAdapterLike & { getFullPath?(path: string): string; getBasePath?(): string }
  }
  const adapter = vault.adapter
  const configDir = vault.configDir || ".obsidian"
  const stageRoot = `${configDir}/plugins/${plugin.manifest.id}/${V4_STAGE_ROOT}`
  const desktop = Platform.isDesktopApp === true
  const resolveDesktopPath = desktop && typeof adapter?.getFullPath === "function"
    ? (path: string) => adapter.getFullPath!(path)
    : undefined
  const desktopRootPath = desktop && typeof adapter?.getBasePath === "function"
    ? adapter.getBasePath()
    : undefined
  return {
    io: createV4PlatformIo({
      platform: desktop ? "desktop" : "mobile",
      adapter,
      resolveDesktopPath,
      desktopRootPath,
    }),
    stageRoot,
  }
}

function createRuntimeStagingStore(platformIo: V4PlatformIo, stageRoot: string): V4StagingStore {
  const ceiling = DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES
  return createV4StagingStore({
    root: stageRoot,
    wholeBufferCeilingBytes: ceiling,
    backend: {
      boundedAppend: platformIo.capabilities.boundedAppend,
      write: (path, bytes) => platformIo.writeStage(path, bytes),
      append: (path, bytes) => platformIo.appendStage(path, bytes),
      remove: path => platformIo.removeStage(path),
      freeBytes: path => platformIo.freeBytes(path),
      openSource: async (path, size): Promise<V4ContentSource> => {
        if (size > ceiling) return platformIo.openBoundedSource(path, size)
        const bytes = await platformIo.readWhole(path)
        if (bytes.byteLength !== size) throw new Error(`V4 staged content size changed: expected ${size}, got ${bytes.byteLength}.`)
        return createV4WholeBufferContentSource(bytes)
      },
    },
  })
}

function createIndexAdapter(plugin: FastSync): V4LocalIndexAdapter {
  const vault = plugin.app.vault as FastSync["app"]["vault"] & {
    configDir?: string
    adapter?: { read(path: string): Promise<string>; write(path: string, data: string): Promise<void>; exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>; stat?(path: string): Promise<{ size: number } | null> }
  }
  if (!vault.adapter) return createMemoryAdapter(plugin)
  const base = `${vault.configDir || ".obsidian"}/plugins/${plugin.manifest.id}`
  const resolve = (path: string) => `${base}/${path.replace(/^\/+/, "")}`
  return {
    read: path => vault.adapter!.read(resolve(path)),
    stat: async path => vault.adapter!.stat?.(resolve(path)) ?? null,
    write: (path, value) => vault.adapter!.write(resolve(path), value),
    exists: path => vault.adapter!.exists(resolve(path)),
    mkdir: async path => { try { await vault.adapter!.mkdir(resolve(path)) } catch (error) { if (!/exist/i.test((error as Error).message)) throw error } },
  }
}

export class V4PluginRuntime {
  private readonly coordinator: V4SyncCoordinator
  private readonly adapter: V4LocalIndexAdapter
  private readonly progressStore = new V4ProgressStore()
  private readonly platformIo: V4PlatformIo
  private readonly stagingStore: V4StagingStore
  private readonly keyringCache = new V4KeyringCache()
  private credentialGeneration = 0
  private debounceRunActive = false
  private settingsTransitionActive = false
  private settingsTransitionSawLocalChange = false
  private disposed = false

  constructor(private readonly plugin: FastSync) {
    this.adapter = createIndexAdapter(plugin)
    const executionIo = createRuntimePlatformIo(plugin)
    this.platformIo = executionIo.io
    this.stagingStore = createRuntimeStagingStore(this.platformIo, executionIo.stageRoot)
    this.coordinator = new V4SyncCoordinator({
      execute: (request, changes, signal) => this.execute(request, changes, signal),
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
    void this.coordinator.whenIdle().finally(() => this.keyringCache.dispose())
  }

  async quiesceForSettingsChange(): Promise<void> {
    this.assertNotDisposed()
    if (this.settingsTransitionActive) throw new Error("V4 settings change is already in progress.")
    this.settingsTransitionActive = true
    this.settingsTransitionSawLocalChange = false
    try {
      this.coordinator.cancelPending()
      this.coordinator.cancelActive(new V4CancelledError("V4 settings changed."))
      await this.coordinator.whenIdle()
      this.coordinator.cancelPending()
      this.debounceRunActive = false
      if (this.progressStore.snapshot.lifecycle === "active" || this.progressStore.snapshot.lifecycle === "waiting") {
        this.progressStore.update({
          lifecycle: "idle",
          phase: undefined,
          currentPath: undefined,
          currentDirection: undefined,
          pull: { completed: 0, total: undefined },
          push: { completed: 0, total: undefined },
          errorMessage: undefined,
          failurePhase: undefined,
          failurePath: undefined,
        })
      }
    } catch (error) {
      this.finishSettingsChange()
      throw error
    }
  }

  finishSettingsChange(): void {
    if (!this.settingsTransitionActive) return
    const rescan = this.settingsTransitionSawLocalChange
    this.settingsTransitionSawLocalChange = false
    this.settingsTransitionActive = false
    if (rescan && !this.disposed) this.enqueue({ type: "rescan", mtime: Date.now() })
  }

  credentialsChanged(): void {
    if (this.disposed) return
    this.credentialGeneration++
    this.keyringCache.invalidate()
  }

  private async keyringForConfig(config: V4RemoteConfig, passphrase: string, signal?: AbortSignal): Promise<V4Keyring> {
    if (config.mode !== "encrypted" || !config.kdfParams) throw new Error("V4 encrypted keyring requires KDF parameters.")
    throwIfV4Aborted(signal)
    const keyring = await this.keyringCache.get({
      repoId: config.repoId,
      salt: config.kdfParams.salt,
      iterations: config.kdfParams.iterations,
      mode: config.mode,
      credentialGeneration: this.credentialGeneration,
    }, async () => {
      throwIfV4Aborted(signal)
      const derived = await deriveV4Keyring({
        passphrase,
        repoId: config.repoId,
        salt: fromBase64Url(config.kdfParams!.salt),
        iterations: config.kdfParams!.iterations,
      })
      throwIfV4Aborted(signal)
      return derived
    })
    throwIfV4Aborted(signal)
    return keyring
  }

  get isSyncing(): boolean { return this.coordinator.isSyncing }
  get pendingCount(): number { return this.coordinator.pendingCount }
  get settingsGeneration(): number { return this.credentialGeneration }
  get progressSnapshot(): V4SyncProgressSnapshot {
    return this.snapshotForConsumers(this.progressStore.snapshot)
  }

  subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void {
    return this.progressStore.subscribe(snapshot => listener(this.snapshotForConsumers(snapshot)))
  }

  private runWhileSettingsStable(request: V4SyncRequest): Promise<unknown> {
    if (this.disposed || this.settingsTransitionActive) return Promise.resolve({ status: "skipped", changedFiles: 0 })
    return this.coordinator.run(request)
  }

  private assertSettingsTransitionInactive(): void {
    this.assertNotDisposed()
    if (this.settingsTransitionActive) throw new V4CancelledError("V4 settings change is in progress.")
  }

  manualSync(): Promise<unknown> { return this.runWhileSettingsStable({ operation: "normal", trigger: "manual" }) }
  startupSync(): Promise<unknown> { return this.runWhileSettingsStable({ operation: "normal", trigger: "startup" }) }
  scheduledSync(): Promise<unknown> { return this.runWhileSettingsStable({ operation: "normal", trigger: "scheduled" }) }
  forcePush(allowThresholdOverride = false): Promise<unknown> { return this.runWhileSettingsStable({ operation: "forcePush", trigger: "forcePush", allowThresholdOverride }) }
  forcePull(allowThresholdOverride = false): Promise<unknown> { return this.runWhileSettingsStable({ operation: "forcePull", trigger: "forcePull", allowThresholdOverride }) }

  async createHistoryService(): Promise<V4HistoryService> {
    this.assertSettingsTransitionInactive()
    const generation = this.credentialGeneration
    const github = this.plugin.githubClient
    const repoId = this.repoId()
    const passphrase = this.plugin.settings.encryptionPassphrase
    const loaded = await this.loadConfiguredRemoteConfig({ github, repoId })
    this.assertSettingsGeneration(generation)
    if (!loaded) throw new Error("V4 history is not initialized. Force Push first.")
    const { remoteConfig, config } = loaded
    assertV4PathLayoutCompatible(remoteConfig, config, "normal")
    const keyring = config.mode === "encrypted"
      ? await this.keyringForConfig(config, passphrase)
      : undefined
    this.assertSettingsGeneration(generation)
    return new V4HistoryService({
      github,
      config,
      keyring,
      assertCurrent: () => this.assertSettingsGeneration(generation),
    })
  }

  /** Read-only, exact-ref inventory. Never infer remote-only files from the stale local cache. */
  async fileOverview(): Promise<V4FileOverview> {
    this.assertSettingsTransitionInactive()
    const generation = this.credentialGeneration
    const github = this.plugin.githubClient
    if (!github) throw new Error("GitHub connection is not configured.")
    const ref = await github.getGitRefOrNull()
    this.assertSettingsGeneration(generation)
    if (!ref) throw new Error("Remote branch is not initialized.")
    const configFile = await github.getFileBytes(V4_CONFIG_PATH, ref.sha)
    this.assertSettingsGeneration(generation)
    if (!configFile) throw new Error("V4 remote metadata is not initialized.")
    const config = decodeV4RemoteConfig(configFile.bytes)
    if (config.repoId !== this.repoId()) throw new Error("V4 remote repository identity mismatch.")
    assertV4PathLayoutCompatible(config, selectV4RuntimeConfig(config, this.plugin.settings.encryptionMode, config.repoId), "normal")
    const index = await this.loadIndex(config)
    this.assertSettingsGeneration(generation)
    const keyring = config.mode === "encrypted"
      ? await this.keyringForConfig(config, this.plugin.settings.encryptionPassphrase)
      : undefined
    const remote = await loadV4RemoteState({ github, index, keyring }, ref.sha, config)
    this.assertSettingsGeneration(generation)
    if (!remote) throw new Error("V4 remote state is unavailable.")
    const inScope = this.scopePredicate()
    const localFiles = this.plugin.app.vault.getFiles().filter(file => inScope(file.path))
      .map(file => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime }))
    const baselineFiles = Object.values(index.shards)
      .flatMap(shard => Object.values(shard.records))
      .filter(record => !record.deleted && inScope(record.path))
    return buildV4FileOverview({
      localFiles,
      remoteFiles: remote.records.filter(record => !record.deleted && inScope(record.path)),
      baselineFiles,
      remoteCommitSha: ref.sha,
    })
  }

  async fileIdForPath(path: string): Promise<string | null> {
    this.assertSettingsTransitionInactive()
    const generation = this.credentialGeneration
    const github = this.plugin.githubClient
    const repoId = this.repoId()
    const loaded = await this.loadConfiguredRemoteConfig({ github, repoId })
    this.assertSettingsGeneration(generation)
    if (!loaded) throw new Error("V4 history is not initialized. Force Push first.")
    assertV4PathLayoutCompatible(loaded.remoteConfig, loaded.config, "normal")
    const config = loaded.config
    const index = await this.loadIndex(config)
    this.assertSettingsGeneration(generation)
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
      if (this.settingsTransitionActive) {
        this.settingsTransitionSawLocalChange = true
        return
      }
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
    if (this.settingsTransitionActive) {
      this.settingsTransitionSawLocalChange = true
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

  private assertSettingsGeneration(generation: number): void {
    this.assertNotDisposed()
    if (generation !== this.credentialGeneration) throw new V4CancelledError("V4 settings generation changed.")
  }

  private beginWaitingRun(): void {
    // Coalescing a growing debounce queue after every file event is quadratic.
    // Once the burst exceeds this UI-only threshold, keep the exact queue
    // untouched for the eventual flush and display an unknown progress total.
    const total = this.coordinator.pendingRawCount <= 128 ? this.coordinator.pendingCount : undefined
    const push = { completed: 0, total }
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

  private async loadConfiguredRemoteConfig(
    target: { github: FastSync["githubClient"]; repoId: string } = { github: this.plugin.githubClient, repoId: this.repoId() },
  ): Promise<{ remoteConfig: V4RemoteConfig; config: V4RemoteConfig } | null> {
    if (!target.github) throw new Error("GitHub connection is not configured.")
    const ref = await target.github.getGitRefOrNull()
    const remote = ref ? await target.github.getFileBytes(V4_CONFIG_PATH, ref.sha) : null
    if (!remote) return null
    const remoteConfig = decodeV4RemoteConfig(remote.bytes)
    const config = selectV4RuntimeConfig(remoteConfig, remoteConfig.mode, target.repoId)
    if (remoteConfig.repoId !== config.repoId) throw new Error("V4 remote repository identity mismatch.")
    return { remoteConfig, config }
  }

  private async remoteOrNewConfig(): Promise<V4RuntimeConfigSelection> {
    const loaded = await this.loadConfiguredRemoteConfig()
    if (loaded) return { config: loaded.config, source: "observed-remote" }
    const mode = this.plugin.settings.encryptionMode
    return { config: selectV4RuntimeConfig(null, mode, this.repoId()), source: "speculative-empty" }
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

  private sessionVault(inScope = this.scopePredicate()): V4SessionVault {
    return {
      listFiles: async () => this.plugin.app.vault.getFiles().filter(file => inScope(file.path)).map(file => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime })),
      stat: async (path: string) => {
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        return file instanceof TFile && inScope(path) ? { path, size: file.stat.size, mtime: file.stat.mtime } : null
      },
      read: async (path: string) => {
        await this.platformIo.assertVaultPathSafe(path, { mustExist: true })
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`)
        return readVaultFileBytes(this.plugin.app.vault, file)
      },
      write: async (path: string, bytes: Uint8Array) => {
        await this.platformIo.assertVaultPathSafe(path)
        this.plugin.addIgnoredFile(path)
        try { await writeVaultFileBytes(this.plugin.app.vault, path, bytes) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      trash: async (path: string) => {
        await this.platformIo.assertVaultPathSafe(path)
        this.plugin.addIgnoredFile(path)
        try { await trashVaultFileIfExists(this.plugin.app.vault, this.plugin.app.fileManager, path) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      openContentSource: (handle, signal) => createV4ContentSource(handle, {
        wholeBufferCeilingBytes: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES,
        readVaultWhole: async path => {
          await this.platformIo.assertVaultPathSafe(path, { mustExist: true })
          const file = this.plugin.app.vault.getAbstractFileByPath(path)
          if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`)
          return readVaultFileBytes(this.plugin.app.vault, file)
        },
        openVaultBounded: this.platformIo.capabilities.boundedRead
          ? (path, expectedSize) => this.platformIo.openBoundedSource(path, expectedSize)
          : undefined,
        openStage: (stageId, expectedSize) => this.stagingStore.open({ stageId, size: expectedSize }),
      }, signal),
      staging: this.stagingStore,
      commitStage: async ({ stage, path, precondition }) => {
        this.plugin.addIgnoredFile(path)
        try {
          if (!precondition.exists) await removeEmptyVaultFolderIfExists(this.plugin.app.vault, path)
          await this.platformIo.commitStage(this.stagingStore.pathFor(stage.stageId), path, {
            expectedTarget: precondition,
            expectedStageSize: stage.size,
            expectedStageSha256: stage.hash,
          })
        } finally {
          this.plugin.removeIgnoredFile(path)
        }
      },
      rollbackStage: async ({ stage, path, precondition }) => {
        this.plugin.addIgnoredFile(path)
        try {
          await this.platformIo.rollbackStage(this.stagingStore.pathFor(stage.stageId), path, {
            expectedTarget: precondition,
            expectedStageSize: stage.size,
            expectedStageSha256: stage.hash,
          })
        } finally {
          this.plugin.removeIgnoredFile(path)
        }
      },
    }
  }

  private async execute(request: V4SyncRequest, changes: V4QueuedChange[], signal: AbortSignal): Promise<{ changedFiles: number }> {
    throwIfV4Aborted(signal)
    assertPluginSettingsRuntimeSafe(this.plugin.settings)
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
    let bootstrapRecoveryKeyCache: { repoId: string; credentialGeneration: number; key: Uint8Array } | undefined
    const bootstrapRecoveryKeyFor = async (passphrase: string, repoId: string): Promise<Uint8Array> => {
      if (bootstrapRecoveryKeyCache?.repoId === repoId && bootstrapRecoveryKeyCache.credentialGeneration === this.credentialGeneration) {
        return bootstrapRecoveryKeyCache.key
      }
      bootstrapRecoveryKeyCache?.key.fill(0)
      const key = await deriveV4BootstrapRecoveryKey({ passphrase, repoId })
      bootstrapRecoveryKeyCache = { repoId, credentialGeneration: this.credentialGeneration, key }
      return key
    }
    syncConsoleLog(this.plugin.settings, "info", "V4 sync started", {
      operation: request.operation,
      trigger: request.trigger,
    })
    try {
      if (!this.plugin.githubClient) throw new Error("GitHub connection is not configured.")
      ;(this.plugin.githubClient as unknown as { setV4AbortSignal?(signal?: AbortSignal): void }).setV4AbortSignal?.(signal)
      throwIfV4Aborted(signal)
      let lastError: unknown
      let progressAttempt = 0
      const runState: V4SyncRunState = { runId: toBase64Url(randomBytes(12)), conflictCopies: new Map(), conflictCopyStages: new Map() }
      for (let casAttempt = 1; casAttempt <= 3; casAttempt++) {
        try {
          throwIfV4Aborted(signal)
          progressAttempt++
          this.progressStore.update({
            phase: "checking-remote",
            attempt: progressAttempt,
            currentPath: undefined,
            currentDirection: undefined,
          })
          const configSelection = await this.remoteOrNewConfig()
          const discovered = configSelection.config
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
          if (configSelection.source === "speculative-empty") {
            await assertV4SpeculativeConfigStillAbsent(this.plugin.githubClient, config.repoId)
          }
          const passphrase = this.plugin.settings.encryptionPassphrase
          const authenticationConfig = discovered.mode === "encrypted" ? discovered : config.mode === "encrypted" ? config : null
          if (authenticationConfig && !passphrase) throw new Error("Encryption passphrase is required.")
          const keyring = authenticationConfig
            ? await this.keyringForConfig(authenticationConfig, passphrase, signal)
            : undefined
          const recoveryNamespace = (await sha256Hex(utf8ToBytes(config.repoId))).slice(0, 32)
          const recoveryRoot = `${V4_RECOVERY_ROOT}/${recoveryNamespace}`
          let recoveryPayloadKey: Uint8Array | undefined
          if (config.mode === "encrypted") {
            recoveryPayloadKey = configSelection.source === "speculative-empty"
              ? await bootstrapRecoveryKeyFor(passphrase, config.repoId)
              : keyring?.journalKey
          }
          let recoveryStore = createV4RecoveryStore({
            adapter: this.adapter,
            root: recoveryRoot,
            repoId: config.repoId,
            payloadKey: recoveryPayloadKey,
          })
          let pendingRecovery
          try {
            pendingRecovery = await recoveryStore.load()
          } catch (error) {
            if (
              !(error instanceof V4RecoveryRequiredError)
              || config.mode !== "encrypted"
              || configSelection.source !== "observed-remote"
              || !passphrase
            ) throw error
            const bootstrapKey = await bootstrapRecoveryKeyFor(passphrase, config.repoId)
            const bootstrapStore = createV4RecoveryStore({
              adapter: this.adapter,
              root: recoveryRoot,
              repoId: config.repoId,
              payloadKey: bootstrapKey,
            })
            try {
              pendingRecovery = await bootstrapStore.load()
              recoveryStore = bootstrapStore
            } catch {
              throw error
            }
          }
          let reconciledRecovery = pendingRecovery
          if (pendingRecovery && pendingRecovery.header.phase !== "index-committed") {
            const recoveryHead = (await this.plugin.githubClient.getGitRefOrNull())?.sha ?? null
            const recovered = await recoverV4PendingState({
              store: recoveryStore,
              snapshot: pendingRecovery,
              io: this.sessionVault(() => true),
              currentRemoteHead: recoveryHead,
              publicationGithub: this.plugin.githubClient,
              signal,
            })
            reconciledRecovery = recovered.snapshot
            if (recovered.replanRequired) {
              const keepStageIds = pendingRecovery.header.runId === runState.runId
                ? new Set([...runState.conflictCopyStages?.values() ?? []].map(copy => copy.stage.stageId))
                : new Set<string>()
              await discardV4RecoveryStages(recovered.snapshot, this.sessionVault(() => true), keepStageIds)
            }
          }
          const inScope = this.scopePredicate()
          const includePath = (path: string): boolean => {
            for (const copy of runState.conflictCopies.values()) {
              if (copy.path === path) return copy.includeInSync
            }
            return inScope(path)
          }
          const sessionGithub = configSelection.source === "speculative-empty"
            ? guardV4SpeculativeConfigGithub(this.plugin.githubClient, config.repoId)
            : this.plugin.githubClient
          const result = await new V4SyncSession({
            github: sessionGithub,
            vault: this.sessionVault(includePath),
            index,
            config,
            keyring,
            conflictPolicy: this.plugin.settings.conflictPolicy,
            abortChangePercent: this.plugin.settings.abortChangePercent,
            askConflict: input => this.askConflict(input.path, signal, input.localBytes, input.remoteBytes),
            includePath,
            runState,
            recoveryStore,
            signal,
            onProgress: patch => {
              if (patch.phase === "checking-remote") return
              this.progressStore.update(patch)
            },
          }).sync({ operation: request.operation, allowThresholdOverride: !!request.allowThresholdOverride, changes })
          this.progressStore.update({ phase: "saving-index", currentPath: undefined, currentDirection: undefined })
          await this.saveIndex(index, previousShardHashes)
          const recoveredRunId = !result.recoveryRunId
            && reconciledRecovery
            && reconciledRecovery.header.phase !== "index-committed"
            && (
              reconciledRecovery.header.phase === "replan-required"
              || (
                !!reconciledRecovery.header.verifiedRemoteHead
                && index.remoteCommitSha === reconciledRecovery.header.verifiedRemoteHead
              )
            )
            ? reconciledRecovery.header.runId
            : undefined
          const recoveryRunId = result.recoveryRunId ?? recoveredRunId
          if (recoveryRunId) await markV4RecoveryIndexCommitted(recoveryStore, recoveryRunId)
          if (result.changedFiles === 0 && request.trigger === "manual") new Notice("GitHub Sync: No changes")
          this.progressStore.finish(result.changedFiles === 0 ? "no-change" : "success", { lastSyncTime: Date.now() })
          syncConsoleLog(this.plugin.settings, "info", "V4 sync completed", {
            operation: request.operation,
            trigger: request.trigger,
            changedFiles: result.changedFiles,
            attempt: progressAttempt,
          })
          return { changedFiles: result.changedFiles }
        } catch (error) {
          lastError = error
          if (error instanceof V4ChangeGuardError && !request.allowThresholdOverride && request.operation !== "normal") {
            this.progressStore.update({ phase: "blocked", currentPath: undefined, currentDirection: undefined })
            const confirmed = await this.confirmThresholdOverride(error, request.operation, signal)
            throwIfV4Aborted(signal)
            if (!confirmed) throw new Error("Sync cancelled because the modification threshold was exceeded.")
            request.allowThresholdOverride = true
            casAttempt--
            continue
          }
          const publicationRace = isV4PublicationRaceError(error)
          const recoveryReplan = error instanceof V4RecoveryReplanRequiredError && request.operation === "normal"
          if (casAttempt === 3 || (!publicationRace && !recoveryReplan)) {
            if (publicationRace && casAttempt === 3) {
              throw new V4PublicationRaceError({
                phase: error.phase,
                expectedHeadSha: error.expectedHeadSha,
                observedHeadSha: error.observedHeadSha,
                publicationOutcome: error.publicationOutcome,
                evidence: error.evidence,
                cause: error.cause,
                message: "Remote branch changed repeatedly while syncing. Please try again.",
              })
            }
            throw error
          }
          if (publicationRace) runState.conflictCopyStages?.clear()
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
      if (error instanceof V4CancelledError) return { changedFiles: 0 }
      const message = (error as Error).message
      const snapshot = this.progressStore.snapshot
      const publicationRace = isV4PublicationRaceError(error) ? error : undefined
      syncConsoleLog(this.plugin.settings, "warn", "V4 sync failed", {
        operation: request.operation,
        trigger: request.trigger,
        attempt: snapshot.attempt,
        phase: snapshot.phase,
        currentPath: snapshot.currentPath,
        publicationPhase: publicationRace?.phase,
        expectedHeadSha: publicationRace?.expectedHeadSha,
        observedHeadSha: publicationRace?.observedHeadSha,
        publicationOutcome: publicationRace?.publicationOutcome,
        publicationEvidence: publicationRace?.evidence,
        publicationCause: publicationRace?.cause,
        error,
      })
      this.progressStore.finish("failed", { errorMessage: message })
      new Notice(`GitHub Sync failed: ${message}`)
      return { changedFiles: 0 }
    } finally {
      bootstrapRecoveryKeyCache?.key.fill(0)
      ;(this.plugin.githubClient as unknown as { setV4AbortSignal?(signal?: AbortSignal): void } | undefined)?.setV4AbortSignal?.(undefined)
      this.plugin.isSyncInProgress = false
      if (!this.disposed) {
        this.plugin.enableWatch()
        if (this.coordinator.pendingCount > 0) this.beginWaitingRun()
      }
    }
  }

  private async askConflict(path: string, signal: AbortSignal, localBytes?: Uint8Array, remoteBytes?: Uint8Array): Promise<V4ConflictResolution> {
    const localText = localBytes ? decodeV4ReviewText(localBytes) : null
    const remoteText = remoteBytes ? decodeV4ReviewText(remoteBytes) : null
    const reviewable = localText !== null && remoteText !== null
      && canPrepareV4ConflictReviewPair(localText, remoteText)
    let prepared: V4ReviewSection[] | undefined
    if (reviewable && localText.length + remoteText.length > 150_000) {
      try {
        prepared = await buildV4ConflictReviewAsync(localText, remoteText, signal)
      } catch (error) {
        if (signal.aborted) return { action: "ask" }
        throw error
      }
    }
    if (signal.aborted) return { action: "ask" }
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app)
      let settled = false
      let onAbort: (() => void) | undefined
      const settle = (resolution: V4ConflictResolution, close: boolean) => {
        if (settled) return
        settled = true
        if (onAbort) signal.removeEventListener("abort", onAbort)
        if (close) modal.close()
        resolve(resolution)
      }
      const finish = (resolution: V4ConflictResolution) => settle(resolution, true)
      onAbort = () => finish({ action: "ask" })
      modal.onClose = () => settle({ action: "ask" }, false)
      modal.titleEl.setText("Resolve sync conflict")
      modal.contentEl.addClass("github-sync-conflict")
      modal.contentEl.createEl("h3", { text: path, cls: "github-sync-conflict__path" })
      modal.contentEl.createEl("p", { text: "Both local and remote changed. Nothing is applied until you choose a resolution.", cls: "github-sync-conflict__intro" })
      const buttons = modal.contentEl.createDiv({ cls: "github-sync-conflict__actions" })
      if (reviewable && localText !== null && remoteText !== null) {
        const sections = prepared ?? buildV4ConflictReview(localText, remoteText)
        const hunks = sections.filter(section => section.kind === "difference")
        const selections = new Map<string, V4ReviewLineDecision>()
        const controls = new Map<string, { keep: HTMLButtonElement; omit: HTMLButtonElement }>()
        const review = modal.contentEl.createDiv({ cls: "github-sync-conflict__review" })
        const headings = review.createDiv({ cls: "github-sync-conflict__columns github-sync-conflict__labels" })
        headings.createEl("strong", { text: "Local · this vault" })
        headings.createEl("strong", { text: "Remote · GitHub" })
        const preview = modal.contentEl.createDiv({ cls: "github-sync-conflict__result" })
        preview.createEl("strong", { text: "Merged result · editable" })
        const summary = preview.createEl("span", { text: "Decide whether to keep or omit each changed line." })
        const output = preview.createEl("textarea", { cls: "github-sync-conflict__output github-sync-conflict__editor",
          attr: { "aria-label": "Editable merged result", "spellcheck": "false", "rows": "8" } }) as HTMLTextAreaElement
        const reset = preview.createEl("button", { text: "Reset text to selected lines" })
        reset.setAttribute("aria-label", "Discard manual edits and restore selected lines")
        const apply = buttons.createEl("button", { text: "Apply reviewed merge", cls: "mod-cta github-sync-conflict__apply" })
        const count = sections.reduce((sum, section) =>
          section.kind === "difference" ? sum + section.localLines.length + section.remoteLines.length : sum, 0)
        const contextLineCount = sections.reduce((sum, section) =>
          section.kind === "common" ? sum + section.lines.length : sum, 0)
        // Shortcuts apply to a whole hunk in O(1) state instead of allocating
        // one string/Map entry for every line of a very large difference.
        const hunkDefaults = new Map<number, V4ReviewChoice>()
        const partialLineCounts = new Map<number, number>()
        let reviewedLineCount = 0
        const decisionFor = (key: string): V4ReviewLineDecision | undefined => {
          const explicit = selections.get(key)
          if (explicit) return explicit
          const [index, side] = key.split(":")
          const choice = hunkDefaults.get(Number(index))
          if (!choice) return undefined
          return choice === "both" || choice === side ? "keep" : "omit"
        }
        const chooseLine = (index: number, side: "local" | "remote", line: number,
          choice: V4ReviewLineDecision) => {
          const key = v4ReviewLineKey(index, side, line)
          if (!selections.has(key) && !hunkDefaults.has(index)) {
            reviewedLineCount++
            partialLineCounts.set(index, (partialLineCounts.get(index) ?? 0) + 1)
          }
          selections.set(key, choice)
          update()
        }
        const chooseHunk = (index: number, section: Extract<V4ReviewSection, { kind: "difference" }>,
          choice: V4ReviewChoice) => {
          if (!hunkDefaults.has(index)) {
            reviewedLineCount += section.localLines.length + section.remoteLines.length
              - (partialLineCounts.get(index) ?? 0)
          }
          hunkDefaults.set(index, choice)
          const prefix = `${index}:`
          for (const key of selections.keys()) {
            if (key.startsWith(prefix)) selections.delete(key)
          }
          partialLineCounts.delete(index)
          update()
        }
        let edited = false
        let previewReady = false
        const update = () => {
          const merged = reviewedLineCount === count ? mergeV4ReviewedLines(sections, selections, hunkDefaults) : null
          previewReady = merged !== null
          if (!edited) output.value = merged ?? ""
          output.disabled = !previewReady
          const tooLarge = previewReady && output.value.length * 3 > V4_REVIEW_MAX_RESULT_BYTES
            && new TextEncoder().encode(output.value).byteLength > V4_REVIEW_MAX_RESULT_BYTES
          apply.disabled = !previewReady || tooLarge || signal.aborted
          reset.disabled = !previewReady || !edited
          summary.setText(tooLarge ? "Merged result exceeds the available safe text budget (32 MiB)."
            : !previewReady ? `${reviewedLineCount}/${count} lines reviewed · choose Keep or Omit for every changed line.`
              : edited ? "Custom text preserved. Review the exact result before applying; Reset restores line selections."
                : "All lines reviewed · you can edit the merged text directly before applying.")
          for (const [key, pair] of controls) {
            pair.keep.setAttribute("aria-pressed", String(decisionFor(key) === "keep"))
            pair.omit.setAttribute("aria-pressed", String(decisionFor(key) === "omit"))
          }
        }
        output.oninput = () => {
          if (!previewReady) return
          edited = true
          update()
        }
        reset.onclick = () => {
          edited = false
          update()
        }
        // Large reviews render one difference and one line window at a time.
        // The underlying choices remain global, but DOM nodes never scale
        // with vault size or the number of changes in a long note.
        if (count + contextLineCount > 160 || sections.length > 180) {
          const changed = sections.map((section, index) => ({ section, index }))
            .filter((item): item is { section: Extract<V4ReviewSection, { kind: "difference" }>; index: number } =>
              item.section.kind === "difference")
          const nav = review.createDiv({ cls: "github-sync-conflict__pager" })
          const pageHost = review.createDiv({ cls: "github-sync-conflict__page" })
          let activeHunk = 0, activePage = 0
          const pageSize = 48
          const renderPage = () => {
            controls.clear()
            nav.empty()
            pageHost.empty()
            const item = changed[activeHunk]
            if (!item) return
            const { section, index: sectionIndex } = item
            const pageCount = Math.max(1, Math.ceil(Math.max(section.localLines.length, section.remoteLines.length) / pageSize))
            const navButton = (title: string, disabled: boolean, action: () => void) => {
              const button = nav.createEl("button", { text: title })
              button.disabled = disabled
              button.onclick = action
            }
            navButton("Previous change", activeHunk === 0, () => { activeHunk--; activePage = 0; renderPage() })
            nav.createEl("span", { text: `Change ${activeHunk + 1}/${changed.length} · lines ${activePage * pageSize + 1}–${Math.min((activePage + 1) * pageSize, Math.max(section.localLines.length, section.remoteLines.length))}` })
            navButton("Next change", activeHunk >= changed.length - 1, () => { activeHunk++; activePage = 0; renderPage() })
            navButton("Previous lines", activePage === 0, () => { activePage--; renderPage() })
            nav.createEl("span", { text: `Page ${activePage + 1}/${pageCount}` })
            navButton("Next lines", activePage >= pageCount - 1, () => { activePage++; renderPage() })
            const before = sections[sectionIndex - 1]
            if (before?.kind === "common") {
              pageHost.createEl("pre", { cls: "github-sync-conflict__common",
                text: (before.lines.length > 3 ? "…\n" : "") + before.lines.slice(-3).join("\n") })
            }
            const block = pageHost.createDiv({ cls: "github-sync-conflict__hunk" })
            block.createEl("span", { cls: "github-sync-conflict__hunk-title",
              text: `Change ${activeHunk + 1} of ${changed.length} · select individual lines` })
            const columns = block.createDiv({ cls: "github-sync-conflict__columns" })
            const sides = [
              { name: "local" as const, lines: section.localLines, cls: "is-local" },
              { name: "remote" as const, lines: section.remoteLines, cls: "is-remote" },
            ]
            for (const side of sides) {
              const column = columns.createDiv({ cls: `github-sync-conflict__side ${side.cls}` })
              const start = activePage * pageSize
              const lines = side.lines.slice(start, start + pageSize)
              if (!lines.length) column.createEl("span", { text: "(no lines on this page)", cls: "github-sync-conflict__empty" })
              lines.forEach((line, i) => {
                const lineIndex = start + i
                const key = v4ReviewLineKey(sectionIndex, side.name, lineIndex)
                const row = column.createDiv({ cls: "github-sync-conflict__line" })
                row.createEl("code", { text: line || " ", cls: "github-sync-conflict__line-text" })
                const actions = row.createDiv({ cls: "github-sync-conflict__line-actions" })
                const keep = actions.createEl("button", { text: "Keep" })
                const omit = actions.createEl("button", { text: "Omit" })
                keep.setAttribute("aria-label", `Change ${activeHunk + 1} ${side.name} line ${lineIndex + 1}: keep`)
                omit.setAttribute("aria-label", `Change ${activeHunk + 1} ${side.name} line ${lineIndex + 1}: omit`)
                controls.set(key, { keep, omit })
                keep.onclick = () => chooseLine(sectionIndex, side.name, lineIndex, "keep")
                omit.onclick = () => chooseLine(sectionIndex, side.name, lineIndex, "omit")
              })
            }
            const shortcuts = block.createDiv({ cls: "github-sync-conflict__choices" })
            const commands: Array<{ label: string; decision: V4ReviewChoice }> = [
              { label: "Keep all local lines", decision: "local" },
              { label: "Keep all remote lines", decision: "remote" },
              { label: "Keep both sides", decision: "both" },
              { label: "Omit both sides", decision: "discard" },
            ]
            for (const command of commands) {
              const button = shortcuts.createEl("button", { text: command.label })
              button.setAttribute("aria-label", `Change ${activeHunk + 1}: ${command.decision}`)
              button.onclick = () => chooseHunk(sectionIndex, section, command.decision)
            }
            const after = sections[sectionIndex + 1]
            if (after?.kind === "common") {
              pageHost.createEl("pre", { cls: "github-sync-conflict__common",
                text: after.lines.slice(0, 3).join("\n") + (after.lines.length > 3 ? "\n…" : "") })
            }
            update()
            review.scrollTop = 0
          }
          renderPage()
        } else {
        let hunk = 0
        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
          const section = sections[sectionIndex]
          if (section.kind === "common") {
            const common = review.createEl("pre", { cls: "github-sync-conflict__common", text: section.lines.join("\n") })
            common.setAttribute("aria-label", "Unchanged lines")
            continue
          }
          const index = hunk++
          const block = review.createDiv({ cls: "github-sync-conflict__hunk" })
          block.createEl("span", { text: `Change ${index + 1} of ${hunks.length} · select individual lines`, cls: "github-sync-conflict__hunk-title" })
          const columns = block.createDiv({ cls: "github-sync-conflict__columns" })
          const sides = [
            { name: "local" as const, label: "Local", lines: section.localLines, cls: "is-local" },
            { name: "remote" as const, label: "Remote", lines: section.remoteLines, cls: "is-remote" },
          ]
          for (const side of sides) {
            const column = columns.createDiv({ cls: `github-sync-conflict__side ${side.cls}` })
            if (!side.lines.length) column.createEl("span", { text: "(no lines)", cls: "github-sync-conflict__empty" })
            side.lines.forEach((line, lineIndex) => {
              const key = v4ReviewLineKey(sectionIndex, side.name, lineIndex)
              const row = column.createDiv({ cls: "github-sync-conflict__line" })
              row.createEl("code", { text: line || " ", cls: "github-sync-conflict__line-text" })
              const buttons = row.createDiv({ cls: "github-sync-conflict__line-actions" })
              const keep = buttons.createEl("button", { text: "Keep", attr: { type: "button" } })
              const omit = buttons.createEl("button", { text: "Omit", attr: { type: "button" } })
              keep.setAttribute("aria-label", `Change ${index + 1} ${side.name} line ${lineIndex + 1}: keep`)
              omit.setAttribute("aria-label", `Change ${index + 1} ${side.name} line ${lineIndex + 1}: omit`)
              controls.set(key, { keep, omit })
              keep.onclick = () => chooseLine(sectionIndex, side.name, lineIndex, "keep")
              omit.onclick = () => chooseLine(sectionIndex, side.name, lineIndex, "omit")
            })
          }
          const choose = block.createDiv({ cls: "github-sync-conflict__choices" })
          const choices: Array<{ choice: V4ReviewChoice; button: HTMLButtonElement }> = [
            { choice: "local", button: choose.createEl("button", { text: "Keep all local lines" }) },
            { choice: "remote", button: choose.createEl("button", { text: "Keep all remote lines" }) },
            { choice: "both", button: choose.createEl("button", { text: "Keep both sides" }) },
            { choice: "discard", button: choose.createEl("button", { text: "Omit both sides" }) },
          ]
          for (const { choice, button } of choices) {
            button.setAttribute("aria-label", `Change ${index + 1}: ${choice}`)
            button.onclick = () => chooseHunk(sectionIndex, section, choice)
          }
        }
        }
        update()
        apply.onclick = () => {
          if (!previewReady || signal.aborted) return
          const mergedBytes = new TextEncoder().encode(output.value)
          if (mergedBytes.byteLength > V4_REVIEW_MAX_RESULT_BYTES) return
          finish({ action: "merged", mergedBytes })
        }
      } else {
        modal.contentEl.createEl("p", { text: "Line-by-line review uses a bounded memory budget (up to 16 MiB per text side). Binary or exceptionally line-dense/large files use the whole-file decisions below.", cls: "github-sync-conflict__intro" })
      }
      buttons.createEl("button", { text: "Keep both" }).onclick = () => finish({ action: "keep-local-copy-remote" })
      buttons.createEl("button", { text: "Use local" }).onclick = () => finish({ action: "use-local" })
      buttons.createEl("button", { text: "Use remote" }).onclick = () => finish({ action: "use-remote" })
      buttons.createEl("button", { text: "Cancel" }).onclick = () => finish({ action: "ask" })
      if (signal.aborted) {
        finish({ action: "ask" })
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
      modal.open()
    })
  }

  private async confirmThresholdOverride(
    error: V4ChangeGuardError,
    operation: "forcePush" | "forcePull",
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app)
      let settled = false
      let onAbort: (() => void) | undefined
      const settle = (value: boolean, close: boolean) => {
        if (settled) return
        settled = true
        if (onAbort) signal.removeEventListener("abort", onAbort)
        if (close) modal.close()
        resolve(value)
      }
      const finish = (value: boolean) => settle(value, true)
      onAbort = () => finish(false)
      modal.onClose = () => settle(false, false)
      modal.titleEl.setText("Modification threshold exceeded")
      modal.contentEl.createEl("p", { text: `${error.changePercent}% of logical files would change; the limit is ${error.thresholdPercent}%.` })
      modal.contentEl.createEl("p", { text: "Override the guard for this force operation only?" })
      const buttons = modal.contentEl.createDiv()
      buttons.createEl("button", { text: "Cancel" }).onclick = () => finish(false)
      const confirm = buttons.createEl("button", { text: operation === "forcePush" ? "Override and force push" : "Override and force pull" })
      confirm.addClass("mod-warning")
      confirm.onclick = () => finish(true)
      if (signal.aborted) {
        finish(false)
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
      modal.open()
    })
  }
}