import { Modal, Notice, Platform, TFile } from "obsidian"
import type FastSync from "../../main"
import { GitHubClient } from "../github-api"
import { fromBase64Url, randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { syncConsoleLog } from "../debug"
import { readVaultFileBytes, writeVaultFileBytes, trashVaultFileIfExists } from "../vault"
import { deriveV4BootstrapRecoveryKey, deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4Pbkdf2Iterations, V4_DEFAULT_PBKDF2_ITERATIONS, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import {
  createEmptyV4LocalIndex,
  loadV4LocalIndex,
  saveV4LocalIndex,
  type V4LocalIndex,
  type V4LocalIndexAdapter,
} from "./local-index"
import { decodeV4RemoteConfig } from "./remote-index"
import { createV4ScopePredicate, isPathInV4SyncScope } from "./scope"
import { assertV4PathLayoutCompatible, V4ChangeGuardError, V4PublishedLocalApplyError, V4RecoveryReplanRequiredError, V4SyncSession, type V4SyncRunState } from "./sync-session"
import type { V4ConflictResolution } from "./conflicts"
import { V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "./sync-coordinator"
import { expectedV4PathLayout, V4_FORMAT_VERSION, V4_CONFIG_PATH, type V4RemoteConfig, type V4StorageMode } from "./protocol-types"
import { V4HistoryService } from "./history-service"
import type { V4SessionVault } from "./local-io"
import { createV4ContentSource, createV4WholeBufferContentSource, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, type V4ContentSource } from "./content-source"
import { createV4PlatformIo, V4ManualRecoveryRequiredError, type V4BinaryAdapterLike, type V4PlatformIo } from "./platform-io"
import { isV4UncVaultPath, V4_NETWORK_VAULT_WARNING } from "./network-storage"
import { createV4DesktopInitiatorLocalReader } from "./reencryption-desktop-initiator-reader"
import { createV4MobileInitiatorLocalReader } from "./reencryption-mobile-initiator-reader"
import { openV4NewDesktopPluginWalWriter, type V4DesktopPluginWalWriter } from "./reencryption-desktop-plugin-wal-writer"
import { openV4NewMobilePluginWalWriter, type V4MobilePluginWalWriter } from "./reencryption-mobile-plugin-wal-writer"
import { openV4DesktopPluginWalForRecovery } from "./reencryption-desktop-plugin-wal-recovery"
import { openV4MobilePluginWalForRecovery, type V4MobilePluginWalOwner } from "./reencryption-mobile-wal-recovery"
import { planV4PluginPrivateWalLocation } from "./reencryption-plugin-wal-location"
import {
  inspectV4ReencryptionCandidateGitRefs,
  type V4ReencryptionCandidateGitRefsReport,
} from "./reencryption-candidate-ref-preflight"
import { armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear, V4ReencryptionSyncFencedError, type V4ReencryptionSyncFenceReport } from "./reencryption-sync-fence"
import type { V4InitiatorLocalReader } from "./reencryption-initiator-parity"
import { createV4StagingStore, type V4StagingStore } from "./staging-store"
import { V4ProgressStore, type V4SyncProgressSnapshot } from "./progress"
import { createV4RunDiagnostics } from "./run-diagnostics"
import type { V4TransportMetricsSnapshot } from "./transport-metrics"
import { createV4RecoveryStore, discardV4RecoveryStages, markV4RecoveryIndexCommitted, recoverV4PendingState, V4RecoveryRequiredError } from "./recovery-store"
import { V4KeyringCache } from "./keyring-cache"
import { boundedMap } from "./bounded-map"
import { V4CancelledError, throwIfV4Aborted } from "./cancellation"
import { V4PublicationRaceError, isV4PublicationRaceError } from "./publication-race"
import { assertV4SpeculativeConfigStillAbsent, guardV4SpeculativeConfigGithub } from "./speculative-config-guard"

import { V4_RUNTIME_INDEX_ROOT } from "./reencryption-index-root"
import { inspectV4ReencryptionColdStartIndexRoute, type V4ReencryptionColdStartRouteReport } from "./reencryption-runtime-index-route"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"
import { inspectV4ReencryptionColdStartJournalKey, type V4ReencryptionColdStartJournalReport, type V4ReencryptionColdStartJournalInput } from "./reencryption-cold-start-journal-key"
const V4_INDEX_ROOT = V4_RUNTIME_INDEX_ROOT
const V4_STAGE_ROOT = "github-sync-v4-stage"
const V4_RECOVERY_ROOT = "github-sync-v4-recovery"
const fallbackStores = new WeakMap<object, Map<string, string>>()

type V4RuntimeConfigSource = "observed-remote" | "speculative-empty"
interface V4RuntimeConfigSelection {
  config: V4RemoteConfig
  source: V4RuntimeConfigSource
}

/** Presence and repeated byte readback of untrusted physical WAL slots only. */
export interface V4ReencryptionExistingWalStructureReport {
  readonly integrityScope: "read-only-untrusted-existing-wal-structure"
  readonly observation: "existing-wal-structure-observed-untrusted" | "manual-recovery-required"
  readonly walAuthenticated: false
  readonly completeRecoveryProven: false
  readonly powerLossDurabilityProven: false
  readonly installedObsidianAcceptanceProven: false
  readonly resumeSyncAuthorized: false
  readonly localCutoverAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const V4_WAL_STRUCTURE_BASE = Object.freeze({
  integrityScope: "read-only-untrusted-existing-wal-structure" as const,
  walAuthenticated: false as const,
  completeRecoveryProven: false as const,
  powerLossDurabilityProven: false as const,
  installedObsidianAcceptanceProven: false as const,
  resumeSyncAuthorized: false as const,
  localCutoverAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const V4_WAL_STRUCTURE_MANUAL: V4ReencryptionExistingWalStructureReport = Object.freeze({
  ...V4_WAL_STRUCTURE_BASE, observation: "manual-recovery-required",
})

interface V4ArmedReencryptionInitiator {
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly assertPinned: () => void
  readonly assertQuiescent: () => void
}

export function selectV4RuntimeConfig(discovered: V4RemoteConfig | null, mode: V4StorageMode, repoId: string, newVaultKdfIterations = V4_DEFAULT_PBKDF2_ITERATIONS): V4RemoteConfig {
  if (discovered?.mode === mode) return { ...discovered, repoId, pathLayout: expectedV4PathLayout(mode) }
  if (mode === "plaintext") return { formatVersion: V4_FORMAT_VERSION, mode, repoId, pathLayout: expectedV4PathLayout(mode) }
  assertV4Pbkdf2Iterations(newVaultKdfIterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
  return {
    formatVersion: V4_FORMAT_VERSION,
    mode,
    repoId,
    pathLayout: expectedV4PathLayout(mode),
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: newVaultKdfIterations, salt: toBase64Url(randomBytes(16)) },
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

function createRuntimePlatformIo(plugin: FastSync): { io: V4PlatformIo; stageRoot: string; desktopRootPath?: string | undefined } {
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
  private readonly indexAdapterBacking: object | undefined
  private readonly progressStore = new V4ProgressStore()
  private diagnosticsClient?: FastSync["githubClient"]
  private diagnosticsBaseline?: V4TransportMetricsSnapshot
  private peakRendererRssBytes: number | undefined
  private runDecryptionMs: number | undefined
  private runEncryptionMs: number | undefined
  private runHashingMs: number | undefined
  private readonly platformIo: V4PlatformIo
  private readonly uncVault: boolean
  private readonly desktopVaultRoot: string | undefined
  private networkStorageNoticeShown = false
  private readonly stagingStore: V4StagingStore
  private readonly recentlyStagedPaths = new Set<string>()
  private readonly keyringCache = new V4KeyringCache()
  private credentialGeneration = 0
  private debounceRunActive = false
  private reencryptionSyncFenced = false
  private reencryptionFencePending = false
  private recoveryDiagnosticInProgress = false
  /** Set only after this live Runtime successfully persists the D173 Fence. */
  private armedReencryptionInitiator: V4ArmedReencryptionInitiator | undefined
  private disposed = false
  private coldStartIndexRoute?: V4ReencryptionColdStartRouteReport

  constructor(private readonly plugin: FastSync) {
    this.indexAdapterBacking = plugin.app.vault.adapter
    this.adapter = createIndexAdapter(plugin)
    const executionIo = createRuntimePlatformIo(plugin)
    this.platformIo = executionIo.io
    this.desktopVaultRoot = executionIo.desktopRootPath
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
    this.armedReencryptionInitiator = undefined
    this.debounceRunActive = false
    this.recentlyStagedPaths.clear()
    this.coordinator.dispose()
    this.progressStore.dispose()
    // Observe *both* outcomes of the final active Sync. A detached finally()
    // would still reject if the Sync unexpectedly failed, creating an
    // unhandled shutdown Promise while clearing secrets. Its own caller
    // continues to observe the original run rejection independently.
    void this.coordinator.whenIdle().then(
      () => this.keyringCache.dispose(),
      () => this.keyringCache.dispose(),
    )
  }

  credentialsChanged(): void {
    if (this.disposed) return
    this.credentialGeneration++
    this.keyringCache.invalidate()
  }

  /**
   * A live Re-encryption fence preserves original Settings and BOTH keys
   * for Manual Recovery, including after an Obsidian restart. Read the
   * actual on-disk fence at each Settings write boundary.
   */
  /** Read native disk evidence after restart; never authorizes Sync. */
  async inspectFencedReencryptionIndexRoute(): Promise<V4ReencryptionColdStartRouteReport> {
    this.assertNotDisposed()
    const observed = await inspectV4ReencryptionColdStartIndexRoute({
      adapter: this.adapter,
      readPersistedPluginData: () => this.plugin.loadData(),
      getSecret: id => this.plugin.app.secretStorage.getSecret(id),
    })
    this.coldStartIndexRoute = observed
    return observed
  }

  getReencryptionColdStartIndexRoute(): V4ReencryptionColdStartRouteReport | undefined {
    return this.coldStartIndexRoute
  }

  /**
   * Explicit user-triggered, read-only GitHub check after Obsidian restart.
   * Never run this as startup Sync: the old Backup may be unavailable and
   * recovering the original key cannot authorize mutation.
   */
  async verifyFencedReencryptionOriginalKey(): Promise<V4ReencryptionColdStartJournalReport | null> {
    return this.verifyFencedReencryptionOriginalKeyWithWal()
  }

  private async verifyFencedReencryptionOriginalKeyWithWal(
    walEvidence?: V4ReencryptionColdStartJournalInput["walEvidence"],
    recoveryScope?: V4ReencryptionColdStartJournalInput["recoveryScope"],
  ): Promise<V4ReencryptionColdStartJournalReport | null> {
    this.assertNotDisposed()
    const route = await this.inspectFencedReencryptionIndexRoute()
    if (route.observation !== "destination-shadow-diagnostic-only"
      && route.observation !== "source-settings-pending") return null

    const settings = this.plugin.settings
    const token = settings.githubToken
    const owner = settings.githubOwner
    const repo = settings.githubRepo
    const branch = settings.githubBranch
    const tokenSecretId = settings.githubTokenSecretId
    const passphraseSecretId = settings.encryptionPassphraseSecretId
    const encryptionMode = settings.encryptionMode
    const originalVault = this.plugin.app.vault
    const configDir = originalVault.configDir
    const pluginId = this.plugin.manifest.id
    const credentialGeneration = this.credentialGeneration
    if (!token || !owner || !repo) {
      throw new Error("Re-encryption read-only verification needs the configured GitHub token.")
    }
    const raw: unknown = JSON.parse(await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH))
    const runId = (raw as { runId?: unknown })?.runId
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(runId)) {
      throw new Error("Re-encryption routing Intent is not valid.")
    }
    const contract = decodeV4ReencryptionCutoverCandidateManifest(
      await this.adapter.read(V4_INDEX_ROOT + "-rekey-cutover-candidate-" + runId + "/contract.json"),
    )
    const id = contract.identity
    const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(id.backupRepoId)
    if (!match || match[1] !== owner || match[2] !== repo || id.runId !== runId) {
      throw new Error("Re-encryption Backup repo differs from live plugin credentials.")
    }
    const backing = this.indexAdapterBacking
    const secretStorage = this.plugin.app.secretStorage
    const getSecret = secretStorage.getSecret
    const loadData = this.plugin.loadData
    const github = new GitHubClient({ token, owner, repo, branch: match[3]! })
    return inspectV4ReencryptionColdStartJournalKey({
      adapter: this.adapter,
      readPersistedPluginData: () => loadData.call(this.plugin),
      getSecret: secretId => getSecret.call(secretStorage, secretId),
      backupGit: github,
      ...(walEvidence ? { walEvidence } : {}),
      ...(recoveryScope ? { recoveryScope } : {}),
      assertLiveOwner: () => {
        if (this.disposed || this.indexAdapterBacking !== backing
          || this.plugin.app.vault !== originalVault
          || originalVault.configDir !== configDir
          || this.plugin.manifest.id !== pluginId
          || this.plugin.app.vault.adapter !== backing
          || this.plugin.settings !== settings || this.credentialGeneration !== credentialGeneration
          || settings.githubToken !== token || settings.githubOwner !== owner
          || settings.githubRepo !== repo || settings.githubBranch !== branch
          || settings.githubTokenSecretId !== tokenSecretId
          || settings.encryptionPassphraseSecretId !== passphraseSecretId
          || settings.encryptionMode !== encryptionMode
          || this.plugin.app.secretStorage !== secretStorage
          || secretStorage.getSecret !== getSecret
          || this.plugin.loadData !== loadData
          || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()) {
          throw Error("Re-encryption owner changed during read-only verification.")
        }
      },
    })
  }

  /**
   * Read-only old-key Frozen Backup, WAL and complete new-key Destination
   * scan, using the installed plugin-private WAL and current SecretStorage.
   * Desktop holds the existing cooperative WAL lock; Mobile is best-effort.
   * This does not grant Recovery, Sync or Cutover authority.
   */
  async verifyFencedReencryptionAuthenticatedWal(): Promise<V4ReencryptionColdStartJournalReport | null> {
    if (this.recoveryDiagnosticInProgress) return null
    this.recoveryDiagnosticInProgress = true
    try {
      this.assertNotDisposed()
      const vault = this.plugin.app.vault
      const settings = this.plugin.settings
      const native = this.indexAdapterBacking as (V4MobilePluginWalOwner["adapter"] & {
        exists(path: string): Promise<boolean>
        getFullPath?: (path: string) => string
      }) | undefined
      const nativeRead = native?.read
      const nativeExists = native?.exists
      const nativeStat = native?.stat
      const nativeList = native?.list
      const nativeGetFullPath = native?.getFullPath
      const secretStorage = this.plugin.app.secretStorage
      const getSecret = secretStorage.getSecret
      const loadData = this.plugin.loadData
      const originalConfigDir = vault.configDir
      const configDir = originalConfigDir || ".obsidian"
      const pluginId = this.plugin.manifest.id
      const desktop = Platform.isDesktopApp === true
      const generation = this.credentialGeneration
      const pinned = {
        owner: settings.githubOwner, repo: settings.githubRepo,
        branch: settings.githubBranch, token: settings.githubToken,
        tokenSecretId: settings.githubTokenSecretId,
        passphraseSecretId: settings.encryptionPassphraseSecretId,
        mode: settings.encryptionMode,
      }
      const checkOwner = () => {
        this.assertNotDisposed()
        if (!native || native !== this.indexAdapterBacking
          || this.plugin.app.vault !== vault || vault.adapter !== native
          || vault.configDir !== originalConfigDir
          || this.plugin.settings !== settings || this.plugin.manifest.id !== pluginId
          || this.credentialGeneration !== generation || Platform.isDesktopApp !== desktop
          || native.read !== nativeRead || native.exists !== nativeExists
          || native.stat !== nativeStat || native.list !== nativeList
          || native.getFullPath !== nativeGetFullPath
          || settings.githubOwner !== pinned.owner || settings.githubRepo !== pinned.repo
          || settings.githubBranch !== pinned.branch || settings.githubToken !== pinned.token
          || settings.githubTokenSecretId !== pinned.tokenSecretId
          || settings.encryptionPassphraseSecretId !== pinned.passphraseSecretId
          || settings.encryptionMode !== pinned.mode
          || this.plugin.app.secretStorage !== secretStorage
          || secretStorage.getSecret !== getSecret || this.plugin.loadData !== loadData
          || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()
          || this.coordinator.isSyncing || this.coordinator.pendingCount > 0
          || this.debounceRunActive || this.recentlyStagedPaths.size > 0
          || !this.recoveryDiagnosticInProgress) {
          throw Error("Re-encryption authenticated WAL owner changed.")
        }
      }
      checkOwner()
      if (!native || !pinned.owner || !pinned.repo || !pinned.token
        || (desktop && this.uncVault)) return null
      const route = await this.inspectFencedReencryptionIndexRoute()
      checkOwner()
      if (route.observation !== "source-settings-pending"
        && route.observation !== "destination-shadow-diagnostic-only") return null
      const rawText = await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
      checkOwner()
      const raw: unknown = JSON.parse(rawText)
      const runId = (raw as { runId?: unknown } | null)?.runId
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(runId)) return null
      const contractText = await this.adapter.read(
        V4_INDEX_ROOT + "-rekey-cutover-candidate-" + runId + "/contract.json",
      )
      checkOwner()
      const candidate = decodeV4ReencryptionCutoverCandidateManifest(contractText)
      const destination = candidate.identity.destinationRepoId
      const destinationPrefix = pinned.owner + "/" + pinned.repo + "#"
      const destinationBranch = destination.startsWith(destinationPrefix)
        ? destination.slice(destinationPrefix.length) : ""
      if (candidate.identity.runId !== runId || !destinationBranch
        || !pinned.token || !pinned.owner || !pinned.repo) return null
      const destinationGit = new GitHubClient({
        token: pinned.token, owner: pinned.owner, repo: pinned.repo, branch: destinationBranch,
      })
      const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
      checkOwner()
      if (desktop) {
        if (typeof native.getFullPath !== "function") return null
        const reader = await openV4DesktopPluginWalForRecovery({
          adapter: native as typeof native & { getFullPath(path: string): string },
          configDir, pluginId, runId, assertLiveOwner: checkOwner,
        })
        try {
          await reader.assertExclusiveStageLease()
          const assertLease = async () => {
            checkOwner()
            await reader.assertExclusiveStageLease()
            checkOwner()
          }
          const result = await this.verifyFencedReencryptionOriginalKeyWithWal({
            adapter: reader.adapter, root: layout.journalRoot, destinationGit,
            fullDestination: true,
          }, {
            withExclusiveRecoveryLease: async <T>(body: () => Promise<T>) => {
              await assertLease()
              return body()
            },
            assertExclusiveRecoveryLease: assertLease,
            assertBestEffortWalCheckpoint: () => reader.assertBestEffortCheckpoint(),
          })
          checkOwner()
          await reader.assertBestEffortCheckpoint()
          checkOwner()
          return result
        } finally {
          await reader.release()
        }
      }
      const reader = await openV4MobilePluginWalForRecovery({
        adapter: native, configDir, pluginId, runId, assertLiveOwner: checkOwner,
      })
      checkOwner()
      // Mobile has one in-process diagnostic owner, but no cross-process OS lock.
      // Read both existing WAL slots at each boundary and refuse any drift.
      const assertCooperativeLease = async () => { checkOwner() }
      let firstSlots: readonly string[] | undefined
      const checkpoint = async (): Promise<"best-effort-readback-only"> => {
        await assertCooperativeLease()
        const slots = await Promise.all([
          reader.adapter.read(reader.journalRoot + "/slot-0.json"),
          reader.adapter.read(reader.journalRoot + "/slot-1.json"),
        ])
        await assertCooperativeLease()
        if (firstSlots && slots.some((slot, i) => slot !== firstSlots![i])) {
          throw Error("Re-encryption Mobile recovery WAL slots changed.")
        }
        firstSlots = slots
        return "best-effort-readback-only"
      }
      const result = await this.verifyFencedReencryptionOriginalKeyWithWal({
        adapter: reader.adapter, root: reader.journalRoot, destinationGit,
        fullDestination: true,
      }, {
        withExclusiveRecoveryLease: async <T>(body: () => Promise<T>) => {
          await assertCooperativeLease()
          return body()
        },
        assertExclusiveRecoveryLease: assertCooperativeLease,
        assertBestEffortWalCheckpoint: checkpoint,
      })
      checkOwner()
      return result
    } catch {
      return null
    } finally {
      this.recoveryDiagnosticInProgress = false
    }
  }

  /**
   * Read-only D251 check of the saved candidate's current remote ref topology.
   * A Git ref matching local claims does not authenticate its encrypted files.
   */
  async inspectFencedReencryptionCandidateGitRefs(): Promise<V4ReencryptionCandidateGitRefsReport | null> {
    try {
      this.assertNotDisposed()
      const vault = this.plugin.app.vault
      const adapterBacking = this.indexAdapterBacking
      const settings = this.plugin.settings
      const secretStorage = this.plugin.app.secretStorage
      const getSecret = secretStorage.getSecret
      const loadData = this.plugin.loadData
      const pluginId = this.plugin.manifest.id
      const configDir = vault.configDir
      const generation = this.credentialGeneration
      const token = settings.githubToken
      const owner = settings.githubOwner
      const repo = settings.githubRepo
      const branch = settings.githubBranch
      const tokenSecretId = settings.githubTokenSecretId
      const passphraseSecretId = settings.encryptionPassphraseSecretId
      const encryptionMode = settings.encryptionMode
      const checkOwner = () => {
        this.assertNotDisposed()
        if (this.plugin.app.vault !== vault || vault.adapter !== adapterBacking
          || this.indexAdapterBacking !== adapterBacking || vault.configDir !== configDir
          || this.plugin.manifest.id !== pluginId
          || this.plugin.settings !== settings || this.credentialGeneration !== generation
          || settings.githubToken !== token || settings.githubOwner !== owner
          || settings.githubRepo !== repo || settings.githubBranch !== branch
          || settings.githubTokenSecretId !== tokenSecretId
          || settings.encryptionPassphraseSecretId !== passphraseSecretId
          || settings.encryptionMode !== encryptionMode
          || this.plugin.app.secretStorage !== secretStorage
          || secretStorage.getSecret !== getSecret || this.plugin.loadData !== loadData
          || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()
          || this.coordinator.isSyncing || this.coordinator.pendingCount > 0
          || this.debounceRunActive || this.recentlyStagedPaths.size > 0) {
          throw Error("Re-encryption Git ref diagnostic owner changed.")
        }
      }
      checkOwner()
      if (!token || !owner || !repo) return null
      const routing = await this.inspectFencedReencryptionIndexRoute()
      checkOwner()
      if (routing.observation !== "destination-shadow-diagnostic-only"
        && routing.observation !== "source-settings-pending") return null
      const markerText = await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
      checkOwner()
      const marker: unknown = JSON.parse(markerText)
      const runId = (marker as { runId?: unknown } | null)?.runId
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(runId)) return null
      const contractPath = V4_INDEX_ROOT + "-rekey-cutover-candidate-" + runId + "/contract.json"
      const contractText = await this.adapter.read(contractPath)
      checkOwner()
      const contract = decodeV4ReencryptionCutoverCandidateManifest(contractText)
      const id = contract.identity
      const matchRepo = owner + "/" + repo + "#"
      const matchBackup = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(id.backupRepoId)
      const matchDestination = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(id.destinationRepoId)
      if (runId !== id.runId || !id.sourceRepoId.startsWith(matchRepo)
        || !id.backupRepoId.startsWith(matchRepo)
        || !id.destinationRepoId.startsWith(matchRepo)
        || !matchBackup || !matchDestination) return null

      const backupGit = new GitHubClient({ token, owner, repo, branch: matchBackup[3]! })
      const destinationGit = new GitHubClient({ token, owner, repo, branch: matchDestination[3]! })
      const result = await inspectV4ReencryptionCandidateGitRefs({
        contract, backupGit, destinationGit, assertLiveOwner: checkOwner,
      })
      checkOwner()
      const after = await this.inspectFencedReencryptionIndexRoute()
      checkOwner()
      if (after.observation !== routing.observation
        || after.diagnosticIndexRoot !== routing.diagnosticIndexRoot
        || await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== markerText
        || await this.adapter.read(contractPath) !== contractText) return null
      checkOwner()
      return result
    } catch {
      return null
    }
  }

  /**
   * Installed D250 structural-only preflight of an EXISTING plugin-private WAL.
   * No ciphertext is authenticated; no migration, Sync or Cutover can follow.
   * Desktop temporarily creates only the existing WAL's cooperative lock.
   */
  async inspectFencedReencryptionExistingWalStructure(): Promise<V4ReencryptionExistingWalStructureReport> {
    try {
      this.assertNotDisposed()
      const vault = this.plugin.app.vault
      const settings = this.plugin.settings
      const secretStorage = this.plugin.app.secretStorage
      const getSecret = secretStorage.getSecret
      const loadData = this.plugin.loadData
      const backing = this.indexAdapterBacking as (V4MobilePluginWalOwner["adapter"] & {
        exists(path: string): Promise<boolean>
        getFullPath?: (path: string) => string
      }) | undefined
      const originalConfigDir = vault.configDir
      const configDir = originalConfigDir || ".obsidian"
      const pluginId = this.plugin.manifest.id
      const desktop = Platform.isDesktopApp === true
      const generation = this.credentialGeneration
      const indexRead = backing?.read
      const indexExists = backing?.exists
      const nativeStat = backing?.stat
      const nativeList = backing?.list
      const nativeGetFullPath = backing?.getFullPath
      const source = {
        owner: settings.githubOwner, repo: settings.githubRepo,
        branch: settings.githubBranch, token: settings.githubToken,
        tokenSecretId: settings.githubTokenSecretId,
        passphraseSecretId: settings.encryptionPassphraseSecretId,
        mode: settings.encryptionMode,
      }
      const assertOwner = () => {
        this.assertNotDisposed()
        if (!backing || this.indexAdapterBacking !== backing
          || vault !== this.plugin.app.vault || vault.adapter !== backing
          || vault.configDir !== originalConfigDir
          || this.plugin.manifest.id !== pluginId
          || this.plugin.settings !== settings || this.credentialGeneration !== generation
          || this.plugin.app.secretStorage !== secretStorage
          || secretStorage.getSecret !== getSecret || this.plugin.loadData !== loadData
          || Platform.isDesktopApp !== desktop
          || backing.read !== indexRead || backing.exists !== indexExists
          || backing.stat !== nativeStat || backing.list !== nativeList
          || backing.getFullPath !== nativeGetFullPath
          || settings.githubOwner !== source.owner || settings.githubRepo !== source.repo
          || settings.githubBranch !== source.branch || settings.githubToken !== source.token
          || settings.githubTokenSecretId !== source.tokenSecretId
          || settings.encryptionPassphraseSecretId !== source.passphraseSecretId
          || settings.encryptionMode !== source.mode
          || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()
          || this.coordinator.isSyncing || this.coordinator.pendingCount > 0
          || this.debounceRunActive || this.recentlyStagedPaths.size > 0) {
          throw Error("Re-encryption physical WAL diagnostic owner changed.")
        }
      }
      assertOwner()
      if (!backing || !source.owner || !source.repo || (desktop && this.uncVault)) {
        return V4_WAL_STRUCTURE_MANUAL
      }
      const route = await this.inspectFencedReencryptionIndexRoute()
      assertOwner()
      if (route.observation !== "destination-shadow-diagnostic-only"
        && route.observation !== "source-settings-pending") return V4_WAL_STRUCTURE_MANUAL
      const markerText = await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
      assertOwner()
      const marker: unknown = JSON.parse(markerText)
      const runId = (marker as { runId?: unknown } | null)?.runId
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(runId)) {
        return V4_WAL_STRUCTURE_MANUAL
      }
      const candidatePath = V4_INDEX_ROOT + "-rekey-cutover-candidate-" + runId + "/contract.json"
      const contractText = await this.adapter.read(candidatePath)
      assertOwner()
      const contract = decodeV4ReencryptionCutoverCandidateManifest(contractText)
      const id = contract.identity
      const physicalRepo = source.owner + "/" + source.repo + "#"
      if (id.runId !== runId || !id.sourceRepoId.startsWith(physicalRepo)
        || !id.backupRepoId.startsWith(physicalRepo)
        || !id.destinationRepoId.startsWith(physicalRepo)) return V4_WAL_STRUCTURE_MANUAL
      const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
      assertOwner()
      const slots = [layout.journalRoot + "/slot-0.json", layout.journalRoot + "/slot-1.json"]
      const doubleRead = async (reader: Pick<V4LocalIndexAdapter, "read" | "exists">) => {
        const values: string[] = []
        for (const slot of slots) {
          assertOwner()
          if (!(await reader.exists(slot))) throw Error("Re-encryption WAL slot missing.")
          const text = await reader.read(slot)
          assertOwner()
          if (typeof text !== "string" || !text.length || text.length > 2 * 1024 * 1024) {
            throw Error("Re-encryption WAL slot malformed or oversized.")
          }
          values.push(text)
        }
        for (const [i, slot] of slots.entries()) {
          assertOwner()
          if (await reader.read(slot) !== values[i]) {
            throw Error("Re-encryption WAL slot changed between reads.")
          }
          assertOwner()
        }
      }
      const recheck = async () => {
        assertOwner()
        const again = await this.inspectFencedReencryptionIndexRoute()
        assertOwner()
        if (again.observation !== route.observation
          || again.diagnosticIndexRoot !== route.diagnosticIndexRoot
          || await this.adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== markerText
          || await this.adapter.read(candidatePath) !== contractText) {
          throw Error("Re-encryption WAL route changed during readback.")
        }
        assertOwner()
      }
      if (desktop) {
        if (typeof backing.getFullPath !== "function") return V4_WAL_STRUCTURE_MANUAL
        const reader = await openV4DesktopPluginWalForRecovery({
          adapter: backing as typeof backing & { getFullPath(path: string): string },
          configDir, pluginId, runId, assertLiveOwner: assertOwner,
        })
        try {
          await reader.assertExclusiveStageLease()
          await doubleRead(reader.adapter)
          await reader.assertBestEffortCheckpoint()
          await recheck()
        } finally {
          await reader.release()
        }
      } else {
        const reader = await openV4MobilePluginWalForRecovery({
          adapter: backing, configDir, pluginId, runId, assertLiveOwner: assertOwner,
        })
        await doubleRead(reader.adapter)
        await recheck()
      }
      assertOwner()
      return Object.freeze({
        ...V4_WAL_STRUCTURE_BASE,
        observation: "existing-wal-structure-observed-untrusted" as const,
      })
    } catch {
      return V4_WAL_STRUCTURE_MANUAL
    }
  }

  /** Read local Destination Shadow for Manual Recovery, not as a Sync writer. */
  async readFencedReencryptionDestinationIndexForRecovery(): Promise<V4LocalIndex | null> {
    this.assertNotDisposed()
    const observed = await this.inspectFencedReencryptionIndexRoute()
    if (observed.observation !== "destination-shadow-diagnostic-only"
      || !observed.diagnosticIndexRoot) return null
    const root = observed.diagnosticIndexRoot
    const candidate = await loadV4LocalIndex(this.adapter, root)
    const after = await this.inspectFencedReencryptionIndexRoute()
    if (after.observation !== "destination-shadow-diagnostic-only"
      || after.diagnosticIndexRoot !== root) return null
    return candidate
  }

  async assertReencryptionSettingsSaveAllowed(): Promise<void> {
    if (this.disposed || this.reencryptionSyncFenced || this.reencryptionFencePending
      || !this.indexAdapterBacking
      || this.plugin.app.vault.adapter !== this.indexAdapterBacking) {
      throw new V4ReencryptionSyncFencedError()
    }
    await assertV4ReencryptionSyncFenceClear(this.adapter)
    if (this.disposed || this.reencryptionSyncFenced || this.reencryptionFencePending
      || !this.indexAdapterBacking
      || this.plugin.app.vault.adapter !== this.indexAdapterBacking) {
      throw new V4ReencryptionSyncFencedError()
    }
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

  /**
   * Read-only factory bound to live scope/queue/editor state and real
   * Desktop filesystem or Mobile DataAdapter inventory. Mobile cannot
   * establish an OS-wide file lock or prove symlink/physical-snapshot safety.
   * Both return non-authorizing parity evidence; no migration is started.
   */
  createReencryptionInitiatorLocalReader(
    assertExclusiveInitiatorLease: () => Promise<void>,
  ): V4InitiatorLocalReader {
    this.assertNotDisposed()
    if (Platform.isDesktopApp === true
      && (!this.desktopVaultRoot || !this.platformIo.capabilities.boundedRead
        || !this.platformIo.capabilities.recoveryStagedCommit || this.uncVault)) {
      throw new Error("Re-encryption live initiating-vault parity requires a verified local Desktop filesystem.")
    }
    if (typeof assertExclusiveInitiatorLease !== "function") {
      throw new Error("Re-encryption initiating-vault parity requires a real exclusive WAL lease.")
    }
    const initial = { ...this.plugin.settings }
    const generation = this.credentialGeneration
    const sourceScope = {
      configDir: this.plugin.app.vault.configDir || ".obsidian",
      pluginId: this.plugin.manifest.id,
      ignorePathRegex: initial.ignorePathRegex,
      syncObsidianConfig: initial.syncObsidianConfig,
      syncBookmarks: initial.syncBookmarks,
      syncPlugins: initial.syncPlugins,
    }
    const assertConnection = async () => {
      this.assertNotDisposed()
      const latest = this.plugin.settings
      if (this.credentialGeneration !== generation
        || latest.githubOwner !== initial.githubOwner || latest.githubRepo !== initial.githubRepo
        || latest.githubBranch !== initial.githubBranch || latest.githubToken !== initial.githubToken
        || latest.encryptionMode !== initial.encryptionMode
        || latest.encryptionPassphrase !== initial.encryptionPassphrase
        || latest.encryptionPassphraseSecretId !== initial.encryptionPassphraseSecretId
        || latest.githubTokenSecretId !== initial.githubTokenSecretId
        || latest.vault !== initial.vault
        || latest.ignorePathRegex !== initial.ignorePathRegex
        || latest.syncObsidianConfig !== initial.syncObsidianConfig
        || latest.syncBookmarks !== initial.syncBookmarks
        || latest.syncPlugins !== initial.syncPlugins
        || (this.plugin.app.vault.configDir || ".obsidian") !== sourceScope.configDir
        || this.plugin.manifest.id !== sourceScope.pluginId
        || this.plugin.app.vault.adapter !== this.indexAdapterBacking) {
        throw new Error("Re-encryption source connection or local Sync scope changed.")
      }
    }
    const guards = {
      scope: sourceScope,
      assertExclusiveInitiatorLease,
      assertIdleAndNoPendingEdits: async () => {
        this.assertNotDisposed()
        if (this.coordinator.isSyncing || this.coordinator.pendingCount > 0
          || this.debounceRunActive || this.recentlyStagedPaths.size > 0) {
          throw new Error("Re-encryption source Sync or pending local mutations are not idle.")
        }
      },
      assertSourceConfigurationUnchanged: assertConnection,
      listOpenEditorPaths: async () => {
        const workspace = this.plugin.app.workspace
        if (!workspace || typeof workspace.iterateAllLeaves !== "function") {
          throw new Error("Re-encryption cannot prove that Obsidian editors are closed.")
        }
        const open = new Set<string>()
        const activeEditor = workspace.activeEditor
        const active = activeEditor?.file?.path
        if (activeEditor && !active) {
          throw new Error("Re-encryption cannot prove an unsaved active editor is closed.")
        }
        if (active) open.add(active)
        let unboundMarkdownEditor = false
        workspace.iterateAllLeaves(leaf => {
          const view = leaf.view as {
            file?: { path?: string }
            getViewType?: () => string
          } | undefined
          const file = view?.file?.path
          if (file) open.add(file)
          // A new unsaved Markdown tab can have no TFile/path, so physical
          // vault inventory cannot see its contents. Refuse the migration
          // preflight instead of falsely claiming there are no open editors.
          if (view?.getViewType?.() === "markdown" && !file) {
            unboundMarkdownEditor = true
          }
        })
        if (unboundMarkdownEditor) {
          throw new Error("Re-encryption cannot prove an unsaved Markdown editor is closed.")
        }
        return [...open]
      },
    }
    if (Platform.isDesktopApp === true) {
      return createV4DesktopInitiatorLocalReader({
        ...guards, rootAbsolute: this.desktopVaultRoot!,
      })
    }
    return createV4MobileInitiatorLocalReader({
      ...guards, adapter: this.plugin.app.vault.adapter,
    })
  }

  get isSyncing(): boolean { return this.coordinator.isSyncing }
  get pendingCount(): number { return this.coordinator.pendingCount }

  /**
   * Internal D174 preflight only. No Wizard Run/remote mutation or local
   * cutover is started here. Failure keeps this runtime paused until restart.
   */
  async armReencryptionSyncFence(input: {
    readonly runId: string
    readonly destinationRepoId: string
    readonly assertExclusiveInitiatorLease: () => Promise<void>
  }): Promise<V4ReencryptionSyncFenceReport> {
    this.assertNotDisposed()
    const originalSettings = this.plugin.settings
    const originalVault = this.plugin.app.vault
    const originalConfigDir = originalVault.configDir || ".obsidian"
    const originalPluginId = this.plugin.manifest.id
    const initial = { ...originalSettings }
    if (this.uncVault || !this.indexAdapterBacking
      || this.plugin.app.vault.adapter !== this.indexAdapterBacking
      || initial.encryptionMode !== "encrypted"
      || !initial.encryptionPassphraseSecretId
      || !initial.githubOwner || !initial.githubRepo
      || !initial.vault || typeof input?.assertExclusiveInitiatorLease !== "function") {
      throw new Error("Re-encryption Sync fence requires configured encrypted Source and exclusive lease.")
    }
    if (this.coordinator.isSyncing || this.coordinator.pendingCount !== 0
      || this.debounceRunActive || this.recentlyStagedPaths.size > 0
      || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()) {
      throw new Error("Re-encryption requires no active, pending or staged Sync work.")
    }
    const originalGeneration = this.credentialGeneration
    // Pin the caller's migration identity and lease function before ANY await.
    // The input object can be mutated by the caller while disk I/O is pending.
    const runId = input.runId
    const destinationRepoId = input.destinationRepoId
    const initiatorLease = input.assertExclusiveInitiatorLease
    const sourceRepoId = this.repoId(initial)
    const assertPinned = () => {
      this.assertNotDisposed()
      const now = this.plugin.settings
      if (input.runId !== runId || input.destinationRepoId !== destinationRepoId
        || input.assertExclusiveInitiatorLease !== initiatorLease
        || this.plugin.settings !== originalSettings
        || this.plugin.app.vault !== originalVault
        || (originalVault.configDir || ".obsidian") !== originalConfigDir
        || this.plugin.manifest.id !== originalPluginId
        || this.plugin.app.vault.adapter !== this.indexAdapterBacking
        || this.credentialGeneration !== originalGeneration
        || now.githubOwner !== initial.githubOwner || now.githubRepo !== initial.githubRepo
        || now.githubBranch !== initial.githubBranch || now.githubToken !== initial.githubToken
        || now.encryptionMode !== initial.encryptionMode
        || now.encryptionPassphrase !== initial.encryptionPassphrase
        || now.encryptionPassphraseSecretId !== initial.encryptionPassphraseSecretId
        || now.githubTokenSecretId !== initial.githubTokenSecretId || now.vault !== initial.vault
        || now.ignorePathRegex !== initial.ignorePathRegex
        || now.syncObsidianConfig !== initial.syncObsidianConfig
        || now.syncBookmarks !== initial.syncBookmarks
        || now.syncPlugins !== initial.syncPlugins
        || this.debounceRunActive || this.recentlyStagedPaths.size > 0
        || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()) {
        throw new Error("Re-encryption Source or Sync status changed; Manual Recovery required.")
      }
    }
    // The coordinator synchronously rejects new Syncs BEFORE the first await.
    const assertQuiescent = this.coordinator.reserveReencryptionQuiescence()
    this.reencryptionFencePending = true
    try {
      assertPinned()
      const report = await armV4ReencryptionSyncFence({
        adapter: this.adapter, runId, sourceRepoId,
        destinationRepoId,
        assertExclusiveInitiatorLease: async () => {
          assertQuiescent()
          assertPinned()
          await initiatorLease()
          assertQuiescent()
          assertPinned()
        },
      })
      assertQuiescent()
      assertPinned()
      this.armedReencryptionInitiator = Object.freeze({
        runId, sourceRepoId, destinationRepoId,
        assertExclusiveInitiatorLease: initiatorLease,
        assertPinned, assertQuiescent,
      })
      return report
    } finally {
      // Even an ambiguous mkdir/write response must not restart Sync here.
      this.reencryptionSyncFenced = true
      this.reencryptionFencePending = false
      try {
        this.plugin.disableWatch?.()
      } catch (error) {
        // A failed final watch shutdown cannot leave a write-capable session.
        this.armedReencryptionInitiator = undefined
        throw error
      }
    }
  }
  /**
   * D244/D245: only the same live Runtime that armed D173 may author WAL.
   * This authority is transient and never restored from a persisted Fence.
   */
  private reencryptionWalOwner() {
    this.assertNotDisposed()
    const session = this.armedReencryptionInitiator
    const backing = this.indexAdapterBacking
    const vault = this.plugin.app.vault
    const desktop = Platform.isDesktopApp === true
    if (!session || !this.reencryptionSyncFenced || this.reencryptionFencePending
      || !backing || vault.adapter !== backing) {
      throw Error("Re-encryption WAL requires this live initiating Runtime and its persisted Fence.")
    }
    const settings = this.plugin.settings
    const configDir = vault.configDir || ".obsidian"
    const pluginId = this.plugin.manifest.id
    const assertLiveOwner = () => {
      this.assertNotDisposed()
      if (this.armedReencryptionInitiator !== session
        || !this.reencryptionSyncFenced || this.reencryptionFencePending
        || this.plugin.app.vault !== vault || vault.adapter !== backing
        || this.plugin.settings !== settings
        || (vault.configDir || ".obsidian") !== configDir
        || this.plugin.manifest.id !== pluginId
        || (Platform.isDesktopApp === true) !== desktop
        || this.plugin.isSyncInProgress || this.plugin.isSettingsSaveInProgress?.()) {
        throw Error("Re-encryption WAL initiating owner changed; Manual Recovery required.")
      }
      session.assertQuiescent()
      session.assertPinned()
    }
    const assertExclusiveInitiatorLease = async () => {
      assertLiveOwner()
      await session.assertExclusiveInitiatorLease()
      assertLiveOwner()
    }
    assertLiveOwner()
    return {
      session, vault, backing, configDir, pluginId,
      assertLiveOwner, assertExclusiveInitiatorLease,
    }
  }

  /**
   * Desktop-only internal authoring. Not invoked by the installed Wizard.
   * Still requires actual persisted Sync Fence and create-only Node WAL lock.
   */
  async openNewReencryptionDesktopWalForArmedRun(): Promise<V4DesktopPluginWalWriter> {
    if (Platform.isDesktopApp !== true || this.uncVault) {
      throw Error("Re-encryption Desktop WAL requires a local Desktop Vault.")
    }
    const owner = this.reencryptionWalOwner()
    const adapter = owner.vault.adapter as typeof owner.vault.adapter & {
      getFullPath?: (path: string) => string
    }
    if (typeof adapter?.getFullPath !== "function") {
      throw Error("Re-encryption Desktop WAL requires the native Obsidian path resolver.")
    }
    return openV4NewDesktopPluginWalWriter({
      adapter: adapter as typeof adapter & { getFullPath(path: string): string },
      configDir: owner.configDir, pluginId: owner.pluginId, runId: owner.session.runId,
      fenceAdapter: this.adapter,
      sourceRepoId: owner.session.sourceRepoId,
      destinationRepoId: owner.session.destinationRepoId,
      assertLiveOwner: owner.assertLiveOwner,
      assertExclusiveInitiatorLease: owner.assertExclusiveInitiatorLease,
      assertSyncFenceArmed: async () => { owner.assertLiveOwner() },
    })
  }

  /**
   * D245: internal Mobile best-effort WAL writer. No OS lock, atomic rename,
   * durable write, auto-resume or Cutover permission. Not used by Wizard Run.
   */
  async openNewReencryptionMobileWalForArmedRun(): Promise<V4MobilePluginWalWriter> {
    if (Platform.isDesktopApp === true) {
      throw Error("Re-encryption Mobile WAL requires Obsidian Mobile.")
    }
    const owner = this.reencryptionWalOwner()
    const adapter = owner.vault.adapter
    if (!adapter || typeof adapter.stat !== "function"
      || typeof adapter.list !== "function" || typeof adapter.read !== "function"
      || typeof adapter.write !== "function" || typeof adapter.mkdir !== "function") {
      throw Error("Re-encryption Mobile WAL requires a complete native Vault Adapter.")
    }
    return openV4NewMobilePluginWalWriter({
      adapter,
      configDir: owner.configDir, pluginId: owner.pluginId, runId: owner.session.runId,
      fenceAdapter: this.adapter,
      sourceRepoId: owner.session.sourceRepoId,
      destinationRepoId: owner.session.destinationRepoId,
      assertLiveOwner: owner.assertLiveOwner,
      assertExclusiveInitiatorLease: owner.assertExclusiveInitiatorLease,
      assertSyncFenceArmed: async () => { owner.assertLiveOwner() },
    })
  }

  get progressSnapshot(): V4SyncProgressSnapshot {
    return this.snapshotForConsumers(this.progressStore.snapshot)
  }

  subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void {
    return this.progressStore.subscribe(snapshot => listener(this.snapshotForConsumers(snapshot)))
  }

  manualSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "manual" }) }
  startupSync(): Promise<unknown> { return this.coordinator.run({ operation: "normal", trigger: "startup" }) }
  scheduledSync(): Promise<unknown> {
    if (this.reencryptionSyncFenced) return Promise.resolve({ status: "skipped", changedFiles: 0 })
    return this.coordinator.run({ operation: "normal", trigger: "scheduled" })
  }
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
    if (this.disposed || this.reencryptionSyncFenced) return
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
    const lifecycle = this.debounceRunActive && snapshot.lifecycle === "active" && snapshot.phase === "debouncing"
      ? "waiting" as const
      : snapshot.lifecycle
    if (!this.diagnosticsClient || !this.diagnosticsBaseline) {
      return lifecycle === snapshot.lifecycle ? snapshot : Object.freeze({ ...snapshot, lifecycle })
    }
    if (Platform.isDesktopApp) {
      try {
        const rss = globalThis.process?.memoryUsage?.().rss
        if (typeof rss === "number" && Number.isFinite(rss) && rss > 0) {
          this.peakRendererRssBytes = Math.max(this.peakRendererRssBytes ?? 0, rss)
        }
      } catch { /* RAM sampling is optional and must never fail Sync. */ }
    }
    const diagnostics = createV4RunDiagnostics(
      this.diagnosticsBaseline,
      this.diagnosticsClient.transportMetricsSnapshot,
      snapshot.totalElapsedMs,
      this.peakRendererRssBytes,
      this.runDecryptionMs,
      this.runEncryptionMs,
      this.runHashingMs,
    )
    return Object.freeze({ ...snapshot, lifecycle, diagnostics: Object.freeze(diagnostics) })
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
    return createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: deviceId || "defaultVault", mode: config.mode, pathLayout })
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
    this.diagnosticsClient = github
    this.diagnosticsBaseline = github?.transportMetricsSnapshot
    this.peakRendererRssBytes = undefined
    this.runDecryptionMs = undefined
    this.runEncryptionMs = undefined
    this.runHashingMs = undefined
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
      await assertV4ReencryptionSyncFenceClear(this.adapter)
      if (request.trigger === "startup") this.plugin.enableWatch()
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
          await assertV4ReencryptionSyncFenceClear(this.adapter)
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
          const config = selectV4RuntimeConfig(discovered, desiredMode, repoId, settings.newVaultKdfIterations)
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
            onEncryptionMeasured: milliseconds => {
              if (!Number.isFinite(milliseconds) || milliseconds < 0) return
              this.runEncryptionMs = (this.runEncryptionMs ?? 0) + milliseconds
            },
            onHashingMeasured: milliseconds => {
              if (!Number.isFinite(milliseconds) || milliseconds < 0) return
              this.runHashingMs = (this.runHashingMs ?? 0) + milliseconds
            },
            onDecryptionMeasured: milliseconds => {
              if (!Number.isFinite(milliseconds) || milliseconds < 0) return
              this.runDecryptionMs = (this.runDecryptionMs ?? 0) + milliseconds
            },
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
      if (error instanceof V4ReencryptionSyncFencedError) {
        this.reencryptionSyncFenced = true
        this.plugin.disableWatch?.()
        this.progressStore.update({ phase: "blocked" })
      }
      if (error instanceof V4CancelledError) return { changedFiles: 0 }
      // Third-party adapters can reject with null, a string, or an arbitrary
      // value. Never throw again while publishing the terminal failed state,
      // or expose a raw non-Error payload (which may contain credentials).
      const message = error instanceof Error && typeof error.message === "string" && error.message.trim()
        ? error.message
        : "Unexpected Sync failure. Review Sync status before retrying manually."
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
      } else if (error instanceof V4PublishedLocalApplyError) {
        this.askUserToReviewPublishedMerge(error)
      } else {
        new Notice(`GitHub Sync failed: ${message}`)
      }
      return { changedFiles: 0 }
    } finally {
      bootstrapRecoveryKeyCache?.key.fill(0)
      ;(github as unknown as { setV4AbortSignal?(signal?: AbortSignal): void } | undefined)?.setV4AbortSignal?.(undefined)
      this.plugin.isSyncInProgress = false
      if (!this.disposed && !this.reencryptionSyncFenced) {
        this.plugin.enableWatch()
        if (this.coordinator.pendingCount > 0) this.beginWaitingRun()
      }
    }
  }

  private askUserToReviewPublishedMerge(error: V4PublishedLocalApplyError): void {
    const modal = new Modal(this.plugin.app)
    modal.titleEl.setText("GitHub Sync: Published Merge needs manual review")
    modal.contentEl.createEl("p", { text: "GitHub accepted the new commit, but this device could not finish applying the merged note locally. The Local Index may still reference the older commit." })
    modal.contentEl.createEl("p", { text: `Affected note: ${error.targetPath}` })
    modal.contentEl.createEl("p", { text: `Published commit: ${error.publishedCommitSha}` })
    modal.contentEl.createEl("p", { text: "Preserve the current Vault and remote branch. Back up the Vault, inspect all recently merged notes (some may already be written), compare the published commit, and resolve differences manually before retrying. Do not Force Push or Force Pull to dismiss this warning." })
    const buttons = modal.contentEl.createDiv()
    buttons.createEl("button", { text: "Keep files unchanged" }).onclick = () => modal.close()
    buttons.createEl("button", { text: "Copy recovery details" }).onclick = () => {
      void navigator.clipboard?.writeText(error.message).catch(() => new Notice("Could not copy recovery details."))
    }
    modal.open()
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