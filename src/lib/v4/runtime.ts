import { Modal, Notice, Platform, TFile } from "obsidian"
import type FastSync from "../../main"
import { fromBase64Url, randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { syncConsoleLog } from "../debug"
import { readVaultFileBytes, writeVaultFileBytes, trashVaultFileIfExists } from "../vault"
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
import { V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "./sync-coordinator"
import { expectedV4PathLayout, V4_FORMAT_VERSION, V4_CONFIG_PATH, type V4RemoteConfig, type V4StorageMode } from "./protocol-types"
import { V4HistoryService } from "./history-service"
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

function createRuntimePlatformIo(plugin: FastSync): { io: V4PlatformIo; stageRoot: string } {
  const vault = plugin.app.vault as FastSync["app"]["vault"] & {
    configDir?: string
    adapter?: V4BinaryAdapterLike & { getFullPath?(path: string): string }
  }
  const adapter = vault.adapter
  const configDir = vault.configDir || ".obsidian"
  const stageRoot = `${configDir}/plugins/${plugin.manifest.id}/${V4_STAGE_ROOT}`
  const desktop = Platform.isDesktopApp === true
  const resolveDesktopPath = desktop && typeof adapter?.getFullPath === "function"
    ? (path: string) => adapter.getFullPath!(path)
    : undefined
  return {
    io: createV4PlatformIo({
      platform: desktop ? "desktop" : "mobile",
      adapter,
      resolveDesktopPath,
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
  private readonly platformIo: V4PlatformIo
  private readonly stagingStore: V4StagingStore
  private readonly keyringCache = new V4KeyringCache()
  private credentialGeneration = 0
  private debounceRunActive = false
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
      ? await this.keyringForConfig(config, this.plugin.settings.encryptionPassphrase)
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
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`)
        return readVaultFileBytes(this.plugin.app.vault, file)
      },
      write: async (path: string, bytes: Uint8Array) => {
        this.plugin.addIgnoredFile(path)
        try { await writeVaultFileBytes(this.plugin.app.vault, path, bytes) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      trash: async (path: string) => {
        this.plugin.addIgnoredFile(path)
        try { await trashVaultFileIfExists(this.plugin.app.vault, this.plugin.app.fileManager, path) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      openContentSource: (handle, signal) => createV4ContentSource(handle, {
        wholeBufferCeilingBytes: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES,
        readVaultWhole: async path => {
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
          await this.platformIo.commitStage(this.stagingStore.pathFor(stage.stageId), path, {
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
            askConflict: input => this.askConflict(input.path),
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
            && reconciledRecovery?.header.phase !== "index-committed"
            && !!reconciledRecovery?.header.verifiedRemoteHead
            && index.remoteCommitSha === reconciledRecovery.header.verifiedRemoteHead
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
            const confirmed = await this.confirmThresholdOverride(error, request.operation)
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
