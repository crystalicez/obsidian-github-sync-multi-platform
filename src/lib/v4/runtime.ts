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
import { createV4PlatformIo, V4ManualRecoveryRequiredError, type V4BinaryAdapterLike, type V4PlatformIo } from "./platform-io"
import { isV4UncVaultPath, V4_NETWORK_VAULT_WARNING } from "./network-storage"
import { createV4StagingStore, type V4StagingStore } from "./staging-store"
import { V4ProgressStore, type V4SyncProgressSnapshot } from "./progress"
import { createV4RecoveryStore, discardV4RecoveryStages, markV4RecoveryIndexCommitted, recoverV4PendingState, V4RecoveryRequiredError } from "./recovery-store"
import { V4KeyringCache } from "./keyring-cache"
import { boundedMap } from "./bounded-map"
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

function createRuntimePlatformIo(plugin: FastSync): { io: V4PlatformIo; stageRoot: string; desktopRootPath?: string } {
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
  const desktopRootPath = resolveDesktopPath ? resolveDesktopPath("") : undefined
  return {
    io: createV4PlatformIo({
      platform: desktop ? "desktop" : "mobile",
      adapter,
      resolveDesktopPath,
      desktopRootPath,
    }),
    stageRoot,
    desktopRootPath,
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

export class V4OpenEditorConflictError extends Error {
  constructor(public readonly targetPath: string) {
    super(`Sync paused for ${targetPath}: this note is open in an Obsidian editor. Close the editor after saving your changes, then review the conflict and retry. No automatic local overwrite was attempted.`)
    this.name = "V4OpenEditorConflictError"
  }
}

export class V4PluginRuntime {
  private readonly coordinator: V4SyncCoordinator
  private readonly adapter: V4LocalIndexAdapter
  private readonly progressStore = new V4ProgressStore()
  private readonly platformIo: V4PlatformIo
  private readonly uncVault: boolean
  private networkStorageNoticeShown = false
  private readonly stagingStore: V4StagingStore
  private readonly recentlyStagedPaths = new Set<string>()
  private readonly keyringCache = new V4KeyringCache()
  private credentialGeneration = 0
  private debounceRunActive = false
  private disposed = false

  constructor(private readonly plugin: FastSync) {
    this.adapter = createIndexAdapter(plugin)
    const executionIo = createRuntimePlatformIo(plugin)
    this.platformIo = executionIo.io
    this.uncVault = isV4UncVaultPath(executionIo.desktopRootPath)
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
    this.recentlyStagedPaths.clear()
    this.coordinator.dispose()
    this.progressStore.dispose()
    void this.coordinator.whenIdle().finally(() => this.keyringCache.dispose())
  }

  credentialsChanged(): void {
    if (this.disposed) return
    this.credentialGeneration++
    this.keyringCache.invalidate()
  }

  private async keyringForConfig(config: V4RemoteConfig, passphrase: string, signal?: AbortSignal, generation = this.credentialGeneration): Promise<V4Keyring> {
    if (config.mode !== "encrypted" || !config.kdfParams) throw new Error("V4 encrypted keyring requires KDF parameters.")
    throwIfV4Aborted(signal)
    const keyring = await this.keyringCache.get({
      repoId: config.repoId,
      salt: config.kdfParams.salt,
      iterations: config.kdfParams.iterations,
      mode: config.mode,
      credentialGeneration: generation,
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

  private scopePredicate(settings: FastSync["settings"] = this.plugin.settings): (path: string) => boolean {
    return createV4ScopePredicate({
      configDir: this.plugin.app.vault.configDir || ".obsidian",
      pluginId: this.plugin.manifest.id,
      ignorePathRegex: settings.ignorePathRegex,
      syncObsidianConfig: settings.syncObsidianConfig,
      syncBookmarks: settings.syncBookmarks,
      syncPlugins: settings.syncPlugins,
    })
  }

  private repoId(settings: FastSync["settings"] = this.plugin.settings): string {
    return `${settings.githubOwner}/${settings.githubRepo}#${settings.githubBranch || "main"}`
  }

  private async loadConfiguredRemoteConfig(github = this.plugin.githubClient, repoId = this.repoId()): Promise<{ remoteConfig: V4RemoteConfig; config: V4RemoteConfig } | null> {
    if (!github) throw new Error("GitHub connection is not configured.")
    const ref = await github.getGitRefOrNull()
    const remote = ref ? await github.getFileBytes(V4_CONFIG_PATH, ref.sha) : null
    if (!remote) return null
    const remoteConfig = decodeV4RemoteConfig(remote.bytes)
    const config = selectV4RuntimeConfig(remoteConfig, remoteConfig.mode, repoId)
    if (remoteConfig.repoId !== config.repoId) throw new Error("V4 remote repository identity mismatch.")
    return { remoteConfig, config }
  }

  private async remoteOrNewConfig(github = this.plugin.githubClient, settings: FastSync["settings"] = this.plugin.settings, repoId = this.repoId(settings)): Promise<V4RuntimeConfigSelection> {
    const loaded = await this.loadConfiguredRemoteConfig(github, repoId)
    if (loaded) return { config: loaded.config, source: "observed-remote" }
    const mode = settings.encryptionMode
    return { config: selectV4RuntimeConfig(null, mode, repoId), source: "speculative-empty" }
  }

  private async loadIndex(config: V4RemoteConfig, deviceId = this.plugin.settings.vault): Promise<V4LocalIndex> {
    const loaded = await loadV4LocalIndex(this.adapter, V4_INDEX_ROOT)
    const pathLayout = config.pathLayout ?? expectedV4PathLayout(config.mode)
    if (loaded.repoId === config.repoId && loaded.mode === config.mode && loaded.pathLayout === pathLayout) return loaded
    return createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: deviceId || "defaultVault", mode: config.mode, pathLayout: config.pathLayout })
  }

  private async saveIndex(index: V4LocalIndex, previousShardHashes: Record<string, string> = {}): Promise<void> {
    await saveV4LocalIndex(this.adapter, V4_INDEX_ROOT, index, previousShardHashes)
  }

  /**
   * A clean editor can become dirty between any two awaited operations.
   * Until a pin/lock handshake with Obsidian exists, do not mutate a note
   * open in a Markdown editor at all. This also protects unsaved buffers that
   * are not reflected in disk stat/hash preconditions.
   */
  private assertNoOpenEditorMutation(path: string): void {
    const workspace = this.plugin.app.workspace
    if (!workspace) return // minimal offline runtime fixtures do not have a UI
    if (typeof workspace.iterateAllLeaves !== "function") {
      throw new V4OpenEditorConflictError(path)
    }
    const canonical = (value: string) => value.normalize("NFC").toLowerCase()
    const target = canonical(path)
    let open = workspace.activeEditor?.file?.path
      ? canonical(workspace.activeEditor.file.path) === target
      : false
    workspace.iterateAllLeaves(leaf => {
      const view = leaf.view as { file?: { path?: string } } | undefined
      if (view?.file?.path && canonical(view.file.path) === target) open = true
    })
    if (open) throw new V4OpenEditorConflictError(path)
  }

  private sessionVault(inScope = this.scopePredicate()): V4SessionVault {
    return {
      listFiles: async () => {
        const files = this.plugin.app.vault.getFiles().filter(file => inScope(file.path))
        if (!this.platformIo.capabilities.recoveryStagedCommit) {
          return files.map(file => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime }))
        }
        // The Obsidian TFile listing may have stale stats until its watcher
        // processes a staged rename. Bound live stat calls to avoid a file
        // descriptor/IO storm while scanning large vaults.
        const indexed = new Set(files.map(file => file.path))
        for (const path of indexed) this.recentlyStagedPaths.delete(path)
        const paths = [...indexed, ...[...this.recentlyStagedPaths].filter(path => inScope(path) && !indexed.has(path))]
        const actual = await boundedMap(paths, 4, async path => {
          const stat = await this.platformIo.statFile(path)
          return stat ? { path, ...stat } : null
        })
        return actual.filter((file): file is { path: string; size: number; mtime: number } => !!file)
      },
      stat: async (path: string) => {
        if (!inScope(path)) return null
        // Staged filesystem renames are visible on disk before Obsidian's watcher
        // updates its TFile cache. Recovery must inspect the real target bytes.
        if (this.platformIo.capabilities.recoveryStagedCommit) {
          const info = await this.platformIo.statFile(path)
          return info ? { path, ...info } : null
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        return file instanceof TFile ? { path, size: file.stat.size, mtime: file.stat.mtime } : null
      },
      read: async (path: string) => {
        if (this.platformIo.capabilities.recoveryStagedCommit) return this.platformIo.readWhole(path)
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        if (!(file instanceof TFile)) throw new Error(`Missing local file: ${path}`)
        return readVaultFileBytes(this.plugin.app.vault, file)
      },
      write: async (path: string, bytes: Uint8Array) => {
        this.assertNoOpenEditorMutation(path)
        this.plugin.addIgnoredFile(path)
        try { await writeVaultFileBytes(this.plugin.app.vault, path, bytes) }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      trash: async (path: string) => {
        this.assertNoOpenEditorMutation(path)
        this.plugin.addIgnoredFile(path)
        try {
          await trashVaultFileIfExists(this.plugin.app.vault, this.plugin.app.fileManager, path)
          this.recentlyStagedPaths.delete(path)
        }
        finally { this.plugin.removeIgnoredFile(path) }
      },
      openContentSource: (handle, signal) => createV4ContentSource(handle, {
        wholeBufferCeilingBytes: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES,
        readVaultWhole: async path => {
          if (this.platformIo.capabilities.recoveryStagedCommit) return this.platformIo.readWhole(path)
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
      // Only Desktop with a verifiable vault root can safely replay a staged small-file swap.
      preferStagedCommit: this.platformIo.capabilities.recoveryStagedCommit,
      commitStage: async ({ stage, path, precondition }) => {
        this.assertNoOpenEditorMutation(path)
        this.plugin.addIgnoredFile(path)
        try {
          await this.platformIo.commitStage(this.stagingStore.pathFor(stage.stageId), path, {
            expectedTarget: precondition,
            expectedStageSize: stage.size,
            expectedStageSha256: stage.hash,
            assertNoOpenEditor: () => this.assertNoOpenEditorMutation(path),
          })
          this.recentlyStagedPaths.add(path)
        } finally {
          this.plugin.removeIgnoredFile(path)
        }
      },
      rollbackStage: ({ stage, path, precondition }) => this.platformIo.rollbackStage(this.stagingStore.pathFor(stage.stageId), path, {
        expectedTarget: precondition,
        expectedStageSize: stage.size,
        expectedStageSha256: stage.hash,
        assertNoOpenEditor: () => this.assertNoOpenEditorMutation(path),
      }),
      finalizeStage: async ({ stage, path, precondition }) => {
        await this.platformIo.finalizeStage(this.stagingStore.pathFor(stage.stageId), path, {
          expectedTarget: precondition,
          expectedStageSize: stage.size,
          expectedStageSha256: stage.hash,
        })
        if (this.platformIo.capabilities.recoveryStagedCommit) this.recentlyStagedPaths.add(path)
      },
    }
  }

  private async execute(request: V4SyncRequest, changes: V4QueuedChange[], signal: AbortSignal): Promise<{ changedFiles: number }> {
    // A Settings save may replace the GitHub client while the run is suspended.
    // Pin repository/client/encryption identity across retries and WAL recovery.
    // Attempt-scoped conflict and ignore policies are captured separately below.
    const settings = { ...this.plugin.settings }
    const github = this.plugin.githubClient
    const repoId = this.repoId(settings)
    const runCredentialGeneration = this.credentialGeneration
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
      if (bootstrapRecoveryKeyCache?.repoId === repoId && bootstrapRecoveryKeyCache.credentialGeneration === runCredentialGeneration) {
        return bootstrapRecoveryKeyCache.key
      }
      bootstrapRecoveryKeyCache?.key.fill(0)
      const key = await deriveV4BootstrapRecoveryKey({ passphrase, repoId })
      bootstrapRecoveryKeyCache = { repoId, credentialGeneration: runCredentialGeneration, key }
      return key
    }
    syncConsoleLog(settings, "info", "V4 sync started", {
      operation: request.operation,
      trigger: request.trigger,
    })
    try {
      if (this.uncVault && !this.networkStorageNoticeShown) {
        this.networkStorageNoticeShown = true
        new Notice(`GitHub Sync: UNC network vault detected. ${V4_NETWORK_VAULT_WARNING}`, 10000)
      }
      if (!github) throw new Error("GitHub connection is not configured.")
      ;(github as unknown as { setV4AbortSignal?(signal?: AbortSignal): void }).setV4AbortSignal?.(signal)
      throwIfV4Aborted(signal)
      let lastError: unknown
      let progressAttempt = 0
      const runState: V4SyncRunState = { runId: toBase64Url(randomBytes(12)), conflictCopies: new Map(), conflictCopyStages: new Map() }
      for (let casAttempt = 1; casAttempt <= 3; casAttempt++) {
        // Conflict resolution and ignore scope may change after a losing CAS
        // attempt; pin them for each attempt, never halfway through an attempt.
        const attemptSettings = { ...this.plugin.settings }
        const attemptScope = this.scopePredicate(attemptSettings)
        try {
          throwIfV4Aborted(signal)
          progressAttempt++
          this.progressStore.update({
            phase: "checking-remote",
            attempt: progressAttempt,
            currentPath: undefined,
            currentDirection: undefined,
          })
          const configSelection = await this.remoteOrNewConfig(github, settings, repoId)
          const discovered = configSelection.config
          const desiredMode = settings.encryptionMode
          if (discovered.mode !== desiredMode && desiredMode === "encrypted") {
            throw new Error("Encrypted V4 requires a new empty repository or branch; plaintext history cannot be retained.")
          }
          if (discovered.mode !== desiredMode && request.operation !== "forcePush") {
            throw new Error("Remote storage mode differs. Force Push is required.")
          }
          const config = selectV4RuntimeConfig(discovered, desiredMode, repoId)
          this.progressStore.update({ phase: "loading-index", currentPath: undefined, currentDirection: undefined })
          const index = await this.loadIndex(config, settings.vault)
          const previousShardHashes = { ...index.shardHashes }
          if (configSelection.source === "speculative-empty") {
            await assertV4SpeculativeConfigStillAbsent(github, config.repoId)
          }
          const passphrase = settings.encryptionPassphrase
          const authenticationConfig = discovered.mode === "encrypted" ? discovered : config.mode === "encrypted" ? config : null
          if (authenticationConfig && !passphrase) throw new Error("Encryption passphrase is required.")
          const keyring = authenticationConfig
            ? await this.keyringForConfig(authenticationConfig, passphrase, signal, runCredentialGeneration)
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
            const recoveryHead = (await github.getGitRefOrNull())?.sha ?? null
            const recovered = await recoverV4PendingState({
              store: recoveryStore,
              snapshot: pendingRecovery,
              io: this.sessionVault(() => true),
              currentRemoteHead: recoveryHead,
              publicationGithub: github,
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
          const includePath = (path: string): boolean => {
            for (const copy of runState.conflictCopies.values()) {
              if (copy.path === path) return copy.includeInSync
            }
            return attemptScope(path)
          }
          const sessionGithub = configSelection.source === "speculative-empty"
            ? guardV4SpeculativeConfigGithub(github, config.repoId)
            : github
          const result = await new V4SyncSession({
            github: sessionGithub,
            vault: this.sessionVault(includePath),
            index,
            config,
            keyring,
            conflictPolicy: attemptSettings.conflictPolicy,
            abortChangePercent: attemptSettings.abortChangePercent,
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
          syncConsoleLog(settings, "info", "V4 sync completed", {
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
      syncConsoleLog(settings, "warn", "V4 sync failed", {
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
      if (error instanceof V4OpenEditorConflictError) {
        this.askUserToReviewOpenEditor(error)
      } else if (error instanceof V4ManualRecoveryRequiredError) {
        // Never present a destructive override when backup evidence is missing.
        this.askUserToReviewRecovery(error)
      } else {
        new Notice(`GitHub Sync failed: ${message}`)
      }
      return { changedFiles: 0 }
    } finally {
      bootstrapRecoveryKeyCache?.key.fill(0)
      ;(github as unknown as { setV4AbortSignal?(signal?: AbortSignal): void } | undefined)?.setV4AbortSignal?.(undefined)
      this.plugin.isSyncInProgress = false
      if (!this.disposed) {
        this.plugin.enableWatch()
        if (this.coordinator.pendingCount > 0) this.beginWaitingRun()
      }
    }
  }

  private askUserToReviewOpenEditor(error: V4OpenEditorConflictError): void {
    const modal = new Modal(this.plugin.app)
    modal.titleEl.setText("GitHub Sync: Open note needs review")
    modal.contentEl.createEl("p", { text: `Sync paused to protect edits in ${error.targetPath}.` })
    modal.contentEl.createEl("p", { text: "Save your edits, close this note in all Obsidian panes, then retry Sync. The pending recovery journal and staged data are retained until the conflict is reviewed. No overwrite or deletion is authorized by closing this dialog." })
    modal.contentEl.createEl("p", { text: "If the editor contains changes you want to keep, copy or save them before closing the note." })
    modal.contentEl.createEl("button", { text: "Keep files unchanged" }).onclick = () => modal.close()
    modal.open()
  }

  private askUserToReviewRecovery(error: V4ManualRecoveryRequiredError): void {
    const modal = new Modal(this.plugin.app)
    modal.titleEl.setText("GitHub Sync: Recovery needs your review")
    modal.contentEl.createEl("p", { text: "Automatic recovery has paused because the plugin cannot prove which file should be restored safely." })
    modal.contentEl.createEl("p", { text: `Affected file: ${error.targetPath}` })
    modal.contentEl.createEl("p", { text: error.message })
    modal.contentEl.createEl("p", { text: "No automatic overwrite or backup deletion will be attempted. Keep the .target-backup and .replacement-residue files. Review a copy of the vault before making any manual changes." })
    const buttons = modal.contentEl.createDiv()
    buttons.createEl("button", { text: "Keep files unchanged" }).onclick = () => modal.close()
    buttons.createEl("button", { text: "Copy recovery details" }).onclick = () => {
      void navigator.clipboard?.writeText(error.message).catch(() => new Notice("Could not copy recovery details."))
    }
    modal.open()
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