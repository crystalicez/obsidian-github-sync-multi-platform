import { randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import type { GitHubTree } from "../github-api"
import { evaluateV4ChangeGuard } from "./change-guard"
import { canAttemptV4TextMerge, resolveV4Conflict, type V4ConflictPolicy, type V4ConflictResolution } from "./conflicts"
import type { V4Keyring } from "./crypto"
import { encryptV4Payload } from "./crypto"
import {
  createV4CandidateCommit,
  publishV4CandidateRef,
  resolveV4PublicationBase,
  uploadV4ObjectStream,
  uploadV4TreeFiles,
  type V4GitTreeFile,
  type V4GitTreeGithub,
  type V4GitTreeProgressItem,
} from "./git-tree-writer"
import { buildV4JournalPages, type V4JournalChange } from "./history-journal"
import { isV4LocalIndexCacheComplete, type V4IndexFileRecord, type V4LocalIndex } from "./local-index"
import { assertV4LocalTargetPrecondition, createV4LocalIo, type V4LocalIo, type V4LocalTargetPrecondition, type V4SessionVault } from "./local-io"
import { trashV4LocalUserFile } from "./local-delete-policy"
import { bucketForV4PathId } from "./paths"
import { planV4Sync, type V4LogicalFile, type V4PlannedChange, type V4SyncOperation } from "./planner"
import { assertV4RemoteRecordSet, buildV4RemoteMetadata, v4RemoteShardPath } from "./remote-index"
import { effectiveV4PathLayout, expectedV4PathLayout, V4_CONFIG_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "./protocol-types"
import { loadV4RemoteConfig, loadV4RemoteState, remoteV4StateFromLocalIndex, type V4RemoteState } from "./remote-loader"
import { V4StorageCodec } from "./storage-codec"
import { collectV4ContentSource, createV4WholeBufferContentSource, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, type V4ContentHandle, type V4ContentSource } from "./content-source"
import type { V4StageRef } from "./staging-store"
import { V4BoundedIoUnavailableError } from "./platform-io"
import { shouldUseV4Parts, V4_PART_BYTES } from "./large-files"
import { hashV4StableContentSource, V4SourceChangedError } from "./object-stream"
import { selectV4WriterPartBytes } from "./part-write-policy"
import type { V4PullBinding, V4PushBinding, V4ResolvedBatch, V4StagedWriteBinding } from "./resolved-batch"
import { boundedMap } from "./bounded-map"
import { V4ByteCache } from "./byte-cache"
import {
  estimateV4PackGroupResources,
  planV4PackGroups,
  type V4PackCandidateMeta,
} from "./pack-planner"
import {
  createV4ResourceController,
  estimateV4GitBlobTransportBytes,
  resolveV4ResourceLimits,
  type V4ResourceController,
  type V4ResourceLimits,
} from "./resource-controller"
import type { V4QueuedChange } from "./sync-coordinator"
import { applyV4RecoveryLocalMutations, type V4RecoveryStore } from "./recovery-store"
import type { V4RecoveryLocalMutation, V4RecoveryPayload } from "./recovery-types"
import type { V4DirectionalProgress, V4SyncProgressPatch } from "./progress"

export type { V4SessionVault, V4SessionVaultFile } from "./local-io"
export { assertV4PathLayoutCompatible } from "./remote-loader"
export type { V4PullBinding, V4PushBinding, V4ResolvedBatch, V4StagedWriteBinding } from "./resolved-batch"

export interface V4SessionGithub extends V4GitTreeGithub {
  getFileBytes(path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null>
  getTreeAt?(treeSha: string, recursive?: boolean): Promise<GitHubTree>
}

export interface V4SyncSessionInput {
  github: V4SessionGithub
  vault: V4SessionVault
  index: V4LocalIndex
  config: V4RemoteConfig
  keyring?: V4Keyring
  conflictPolicy: V4ConflictPolicy
  abortChangePercent: number
  now?: () => number
  askConflict?: (input: { path: string; localMtime: number; remoteMtime: number }) => Promise<V4ConflictResolution>
  includePath?: (path: string) => boolean
  onProgress?: (patch: V4SyncProgressPatch) => void
  runState?: V4SyncRunState
  recoveryStore?: V4RecoveryStore
  resourceLimits?: Partial<V4ResourceLimits>
}

export interface V4SyncRunState {
  runId?: string
  conflictCopies: Map<string, { path: string; fileId: string; includeInSync: boolean }>
  conflictCopyStages?: Map<string, { path: string; fileId: string; includeInSync: boolean; stage: V4StageRef }>
}

export interface V4SessionSyncResult {
  mode: "noop" | "pull" | "push" | "pull-push" | "force-pull" | "force-push"
  operation: V4SyncOperation
  changedFiles: number
  pushedFiles: number
  pulledFiles: number
  commitSha?: string
  recoveryRunId?: string
}

export class V4ChangeGuardError extends Error {
  constructor(public readonly changePercent: number, public readonly thresholdPercent: number) {
    super(`V4 change guard blocked sync: ${changePercent}% exceeds ${thresholdPercent}%.`)
    this.name = "V4ChangeGuardError"
  }
}

export class V4RecoveryReplanRequiredError extends Error {
  constructor(public readonly verifiedRemoteHead: string) {
    super(`V4 local recovery requires replanning against verified remote head ${verifiedRemoteHead}.`)
    this.name = "V4RecoveryReplanRequiredError"
  }
}

function recordsFromIndex(index: V4LocalIndex): V4IndexFileRecord[] {
  return Object.values(index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted)
}

function logical(records: V4IndexFileRecord[]): V4LogicalFile[] {
  return records.filter(record => !record.deleted).map(record => ({
    path: record.path,
    fileId: record.fileId,
    hash: record.plaintextSha256,
    size: record.size,
    mtime: record.mtime,
  }))
}

function assertNoCaseInsensitiveCollisions(files: V4LogicalFile[]): void {
  const seen = new Map<string, string>()
  for (const file of files) {
    const key = file.path.normalize("NFC").toLowerCase()
    const previous = seen.get(key)
    if (previous && previous !== file.path) throw new Error(`Case-insensitive path collision: ${previous} <-> ${file.path}`)
    seen.set(key, file.path)
  }
}

function recordPaths(record: V4IndexFileRecord): string[] {
  return record.storage === "chunked" ? record.partPaths ?? [] : [record.remotePath]
}

function descriptorFor(record: V4IndexFileRecord) {
  return {
    remotePath: record.remotePath,
    sha: "",
    size: record.size,
    pathId: record.pathId,
    plaintextSha256: record.plaintextSha256,
    remoteVersion: record.remoteVersion,
    storage: record.storage,
    partPaths: record.partPaths,
    packId: record.packId,
    mtime: record.mtime,
  }
}

function recordsByBucket(records: V4IndexFileRecord[]): Map<string, V4IndexFileRecord[]> {
  const grouped = new Map<string, V4IndexFileRecord[]>()
  for (const record of records) {
    const bucket = bucketForV4PathId(record.pathId)
    const values = grouped.get(bucket) ?? []
    values.push(record)
    grouped.set(bucket, values)
  }
  for (const values of grouped.values()) values.sort((left, right) => left.pathId.localeCompare(right.pathId))
  return grouped
}

function bucketSignature(records: V4IndexFileRecord[] | undefined): string {
  return JSON.stringify(records ?? [])
}

function journalPath(journalId: string, page: number, encrypted: boolean): string {
  return `${V4_ROOT}/journals/${journalId}/${String(page).padStart(6, "0")}.${encrypted ? "enc" : "json"}`
}

function causalIdentityState(records: V4IndexFileRecord[], changes: V4QueuedChange[]): {
  identityByPath: Map<string, string>
  touchedBaseRecords: V4IndexFileRecord[]
  survivingCausallyRenamedFileIds: Set<string>
} {
  const identities = new Map(records.map(record => [record.path, record]))
  const touched = new Map<string, V4IndexFileRecord>()
  const passedThroughRenameFileIds = new Set<string>()
  const atOrBelow = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
  const remove = (path: string) => {
    const record = identities.get(path)
    if (record) touched.set(record.fileId, record)
    identities.delete(path)
  }
  for (const change of changes) {
    if (change.type === "delete") {
      remove(change.path)
      continue
    }
    if (change.type === "replace") {
      remove(change.oldPath)
      remove(change.path)
      continue
    }
    if (change.type === "rename") {
      const record = identities.get(change.oldPath)
      remove(change.oldPath)
      remove(change.path)
      if (record) {
        passedThroughRenameFileIds.add(record.fileId)
        identities.set(change.path, record)
      }
      continue
    }
    if (change.type === "folderDelete") {
      for (const path of [...identities.keys()]) if (atOrBelow(path, change.path)) remove(path)
      continue
    }
    if (change.type !== "folderRename") continue
    const moved: Array<[string, V4IndexFileRecord]> = []
    for (const [path, record] of [...identities]) {
      if (!atOrBelow(path, change.oldPath)) continue
      remove(path)
      passedThroughRenameFileIds.add(record.fileId)
      moved.push([`${change.path}${path.slice(change.oldPath.length)}`, record])
    }
    for (const path of [...identities.keys()]) if (atOrBelow(path, change.path)) remove(path)
    for (const [path, record] of moved) identities.set(path, record)
  }
  return {
    identityByPath: new Map([...identities].map(([path, record]) => [path, record.fileId])),
    touchedBaseRecords: [...touched.values()],
    survivingCausallyRenamedFileIds: new Set([...identities.values()]
      .filter(record => passedThroughRenameFileIds.has(record.fileId))
      .map(record => record.fileId)),
  }
}


export class V4SyncSession {
  private readonly codec: V4StorageCodec
  private readonly now: () => number
  private readonly localIo: V4LocalIo
  private readonly resources: V4ResourceController
  private readonly localReadCache: V4ByteCache
  private readonly ephemeralStages = new Map<string, Uint8Array>()
  private ephemeralStageSequence = 0

  constructor(private readonly input: V4SyncSessionInput) {
    const resourceLimits = resolveV4ResourceLimits(input.resourceLimits)
    this.resources = createV4ResourceController(resourceLimits)
    this.localReadCache = new V4ByteCache(resourceLimits.maxCacheBytes)
    this.codec = new V4StorageCodec({
      mode: input.config.mode,
      pathLayout: input.config.pathLayout ?? expectedV4PathLayout(input.config.mode),
      keyring: input.keyring,
      resources: this.resources,
    })
    this.now = input.now ?? (() => Date.now())
    this.localIo = createV4LocalIo(input.vault)
  }

  private report(patch: V4SyncProgressPatch): void {
    try {
      this.input.onProgress?.(patch)
    } catch {
      // Progress is observational and must never affect sync behavior.
    }
  }

  async sync(options: {
    operation: V4SyncOperation
    allowThresholdOverride: boolean
    changes?: V4QueuedChange[]
  }): Promise<V4SessionSyncResult> {
    this.localReadCache.clear()
    const ownedStages: V4StageRef[] = []
    let preserveStagesForRecovery = false
    try {
    const baseCommitSha = this.input.index.remoteCommitSha
    this.report({ phase: "checking-remote", currentPath: undefined, currentDirection: undefined })
    const ref = await this.input.github.getGitRefOrNull()
    const remoteConfig = await loadV4RemoteConfig({ github: this.input.github, desiredConfig: this.input.config }, ref?.sha, options.operation)
    const localCacheComplete = isV4LocalIndexCacheComplete(this.input.index)
    const remote = ref && remoteConfig && remoteConfig.mode !== "encrypted" && localCacheComplete && ref.sha === this.input.index.remoteCommitSha && this.input.index.pathLayout === effectiveV4PathLayout(remoteConfig)
      ? remoteV4StateFromLocalIndex(this.input.index, ref.sha, remoteConfig)
      : await loadV4RemoteState({ github: this.input.github, index: this.input.index, keyring: this.input.keyring }, ref?.sha, remoteConfig)
    if (!remote && options.operation !== "forcePush") {
      throw new Error("Remote is not V4. Force Push is required before sync or Force Pull.")
    }
    if (!remote && ref && this.input.config.mode === "encrypted") {
      throw new Error("Encrypted V4 requires a new empty repository or branch to avoid retaining plaintext history.")
    }
    if (remote && remote.config.mode !== this.input.config.mode) {
      if (this.input.config.mode === "encrypted") {
        throw new Error("Encrypted V4 requires a new empty repository or branch; plaintext history cannot be retained.")
      }
      if (options.operation !== "forcePush") throw new Error("Remote storage mode differs. Force Push is required.")
    }
    const metadataRemoteRecords = (remote?.records ?? []).map(record => ({ ...record, partPaths: record.partPaths ? [...record.partPaths] : undefined }))
    let externalReconciled = false
    if (remote && this.input.index.remoteCommitSha && remote.commitSha !== this.input.index.remoteCommitSha) {
      const tip = await this.input.github.getGitCommit(remote.commitSha)
      const pluginMessage = `obsidian-sync-v4:${remote.head.journalId}`
      if (tip.message?.split("\n", 1)[0] !== pluginMessage) {
        await this.reconcileExternalCommit(remote, tip.treeSha)
        externalReconciled = true
      }
    }

    const includePath = this.input.includePath ?? (() => true)
    const allRemoteRecords = remote?.records ?? []
    const isLayoutMigration = !!remote
      && effectiveV4PathLayout(remote.config) !== expectedV4PathLayout(this.input.config.mode)
    if (isLayoutMigration && allRemoteRecords.some(record => !includePath(record.path))) {
      throw new Error("Legacy V4 migration cannot continue while encrypted records are excluded by sync scope. Include all legacy paths and retry Force Push.")
    }
    const remoteRecords = allRemoteRecords.filter(record => includePath(record.path))
    const hasKnownBase = localCacheComplete && !!this.input.index.remoteCommitSha
    const causalState = isLayoutMigration || !hasKnownBase
      ? causalIdentityState(remoteRecords, options.changes ?? [])
      : undefined
    const identityBaseRecords = isLayoutMigration
      ? []
      : hasKnownBase
        ? recordsFromIndex(this.input.index)
        : options.operation === "normal"
          ? causalState!.touchedBaseRecords
          : []
    const runCopyIdentityByPath = new Map([...this.input.runState?.conflictCopies.values() ?? []]
      .filter(copy => copy.includeInSync)
      .map(copy => [copy.path, copy.fileId] as const))
    const identitySeedByPath = new Map([...causalState?.identityByPath ?? [], ...runCopyIdentityByPath])
    const localFiles = (await this.scanLocalStable(identityBaseRecords, options.changes ?? [], identitySeedByPath, runCopyIdentityByPath)).filter(file => includePath(file.path))
    const syntheticConflictCopyIds = new Set<string>()
    for (const copy of this.input.runState?.conflictCopyStages?.values() ?? []) {
      if (!copy.includeInSync || localFiles.some(file => file.fileId === copy.fileId || file.path === copy.path)) continue
      localFiles.push({ path: copy.path, fileId: copy.fileId, hash: copy.stage.hash, size: copy.stage.size, mtime: copy.stage.mtime })
      syntheticConflictCopyIds.add(copy.fileId)
    }
    const localById = new Map(localFiles.map(file => [file.fileId, file]))
    const baseRecords = !hasKnownBase && options.operation === "normal" && causalState
      ? identityBaseRecords.filter(record => !causalState.survivingCausallyRenamedFileIds.has(record.fileId)
        || localById.get(record.fileId)?.hash === record.plaintextSha256)
      : identityBaseRecords.filter(record => includePath(record.path))
    assertNoCaseInsensitiveCollisions(localFiles)
    assertNoCaseInsensitiveCollisions(logical(remoteRecords))
    this.report({ phase: "planning", currentPath: undefined, currentDirection: undefined })
    const plan = planV4Sync({
      operation: options.operation,
      base: logical(baseRecords),
      local: localFiles,
      remote: isLayoutMigration ? [] : logical(remoteRecords),
    })
    const finalLocalFileIds = new Set(localFiles.map(file => file.fileId))
    const migrationDeletionPushItems: V4GitTreeProgressItem[] = isLayoutMigration
      ? [...new Map(remoteRecords
        .filter(record => !finalLocalFileIds.has(record.fileId))
        .map(record => [record.fileId, { fileId: record.fileId, path: record.path }])).values()]
      : []
    let pullCompleted = 0
    let pushCompleted = 0
    let pullTotal = plan.pulls.length
    let pushTotal = plan.pushes.length + migrationDeletionPushItems.length
    const directional = (completed: number, total: number | undefined): V4DirectionalProgress => total === undefined
      ? { completed }
      : { completed, total }
    const counters = (totalsKnown: boolean) => ({
      pull: directional(pullCompleted, totalsKnown ? pullTotal : undefined),
      push: directional(pushCompleted, totalsKnown ? pushTotal : undefined),
    })
    const conflictsResolved = plan.conflicts.length === 0
    this.report({
      phase: "planning",
      currentPath: undefined,
      currentDirection: undefined,
      ...counters(conflictsResolved),
    })
    const changedFiles = isLayoutMigration
      ? new Set([...localFiles.map(file => file.fileId), ...remoteRecords.map(record => record.fileId)]).size
      : plan.changedFiles
    const guard = evaluateV4ChangeGuard({
      thresholdPercent: this.input.abortChangePercent,
      changedFiles,
      baseFiles: baseRecords.length,
      localFiles: localFiles.length,
      remoteFiles: remoteRecords.length,
    })
    if (guard.blocked && !options.allowThresholdOverride) {
      this.report({ phase: "blocked", currentPath: undefined, currentDirection: undefined, ...counters(conflictsResolved) })
      throw new V4ChangeGuardError(guard.changePercent, guard.thresholdPercent)
    }
    if (changedFiles === 0 && options.operation !== "forcePush") {
      if (remote) this.replaceIndex(allRemoteRecords, remote.head, remote.commitSha)
      this.localReadCache.clear()
      return { mode: "noop", operation: options.operation, changedFiles: 0, pushedFiles: 0, pulledFiles: 0 }
    }

    const recordsById = new Map((isLayoutMigration ? [] : allRemoteRecords).map(record => [record.fileId, record]))
    const baseRecordsById = new Map(baseRecords.map(record => [record.fileId, record]))
    const remoteCommitSha = remote?.commitSha
    const batch: V4ResolvedBatch = {
      runId: this.input.runState?.runId ?? toBase64Url(randomBytes(12)),
      pulls: plan.pulls.map(change => this.bindPull(change, recordsById, remoteCommitSha)),
      pushes: plan.pushes.map(change => this.bindPush(change, recordsById)),
      stagedWrites: [],
    }
    for (const binding of batch.pushes) {
      const copy = this.input.runState?.conflictCopyStages?.get(binding.change.fileId)
      if (copy && binding.change.after?.hash === copy.stage.hash) binding.source = this.stageHandle(copy.stage)
    }
    const prefetchedRemoteBodies = new Map<string, Uint8Array>()
    const stagedCopyPulls: Array<{ pull: V4PullBinding; push?: V4PushBinding; reserved: { path: string; fileId: string; includeInSync: boolean } }> = []
    for (const [conflictIndex, conflict] of plan.conflicts.entries()) {
      this.report({
        phase: "resolving-conflicts",
        currentPath: conflict.path,
        currentDirection: undefined,
        ...counters(false),
      })
      const remoteRecord = recordsById.get(conflict.fileId)
      const baseRecord = baseRecordsById.get(conflict.fileId)
      let remoteBytes: Uint8Array | undefined
      let resolution: V4ConflictResolution
      const canMergeFromMetadata = this.input.conflictPolicy === "merge"
        && !!conflict.local && !!conflict.remote && !!baseRecord && !!remoteRecord
        && (remoteRecord.remoteVersion === baseRecord.remoteVersion || !!baseCommitSha)
        && canAttemptV4TextMerge(conflict.path, [baseRecord.size, conflict.local.size, conflict.remote.size])
      if (canMergeFromMetadata) {
        const localBytes = await this.readLocal(conflict.local!.path)
        remoteBytes = await this.readRecord(remoteRecord!, remoteCommitSha)
        const baseBytes = remoteRecord!.remoteVersion === baseRecord!.remoteVersion
          ? remoteBytes
          : await this.readRecord(baseRecord!, baseCommitSha)
        resolution = resolveV4Conflict({
          policy: this.input.conflictPolicy,
          path: conflict.path,
          localMtime: conflict.local?.mtime ?? 0,
          remoteMtime: conflict.remote?.mtime ?? 0,
          baseBytes,
          localBytes,
          remoteBytes,
        })
      } else {
        resolution = resolveV4Conflict({
          policy: this.input.conflictPolicy,
          path: conflict.path,
          localMtime: conflict.local?.mtime ?? 0,
          remoteMtime: conflict.remote?.mtime ?? 0,
        })
      }
      if (resolution.action === "ask") {
        if (!this.input.askConflict) throw new Error(`Conflict requires user decision: ${conflict.path}`)
        resolution = await this.input.askConflict({ path: conflict.path, localMtime: conflict.local?.mtime ?? 0, remoteMtime: conflict.remote?.mtime ?? 0 })
        if (resolution.action === "ask") throw new Error(`Conflict cancelled: ${conflict.path}`)
      }
      if (remoteBytes && remoteRecord) prefetchedRemoteBodies.set(remoteRecord.fileId, remoteBytes)

      if (resolution.action === "use-remote") {
        const pull = this.changeBetween(conflict.local, conflict.remote)
        if (pull) {
          pullTotal++
          batch.pulls.push(this.bindPull(pull, recordsById, remoteCommitSha))
        }
      } else if (resolution.action === "merged" && conflict.local && resolution.mergedBytes) {
        const mergeMtime = this.now()
        const stage = await this.stageBytes(resolution.mergedBytes, mergeMtime, conflict.local.size, ownedStages)
        const mergedAfter: V4LogicalFile = {
          ...conflict.local,
          hash: stage.hash,
          size: stage.size,
          mtime: stage.mtime,
        }
        const mergedChange = this.changeBetween(conflict.remote, mergedAfter)
        if (mergedChange) {
          pushTotal++
          const binding: V4PushBinding = { change: mergedChange, source: this.stageHandle(stage) }
          batch.pushes.push(binding)
          batch.stagedWrites.push({ change: mergedChange, stage })
        }
      } else {
        if (resolution.action === "keep-local-copy-remote" && conflict.remote && remoteRecord) {
          let reservedCopy = this.input.runState?.conflictCopies.get(conflict.fileId)
          if (!reservedCopy) {
            const path = this.conflictCopyPath(conflict.remote.path)
            reservedCopy = { path, fileId: await this.newFileId(path), includeInSync: includePath(path) }
            this.input.runState?.conflictCopies.set(conflict.fileId, reservedCopy)
          }
          const copyPath = reservedCopy.path
          const copyFileId = reservedCopy.fileId
          const carriedStage = syntheticConflictCopyIds.has(copyFileId)
            ? this.input.runState?.conflictCopyStages?.get(copyFileId)?.stage
            : undefined
          const existingCopy = carriedStage ? undefined : localById.get(copyFileId)
          const copyChange: V4PlannedChange = {
            fileId: copyFileId,
            kind: existingCopy ? "modify" : "create",
            path: copyPath,
            before: existingCopy,
            after: {
              path: copyPath,
              fileId: copyFileId,
              hash: conflict.remote.hash,
              size: conflict.remote.size,
              mtime: conflict.remote.mtime,
            },
          }
          pullTotal++
          const pullBinding: V4PullBinding = { change: copyChange, remoteRecord, remoteCommitSha, stage: carriedStage }
          batch.pulls.push(pullBinding)
          let pushBinding: V4PushBinding | undefined
          if (reservedCopy.includeInSync && !batch.pushes.some(binding => binding.change.fileId === copyFileId)) {
            pushTotal++
            pushBinding = { change: copyChange }
            batch.pushes.push(pushBinding)
          }
          if (!carriedStage) stagedCopyPulls.push({ pull: pullBinding, push: pushBinding, reserved: reservedCopy })
        }
        const localPush = this.changeBetween(conflict.remote, conflict.local)
        if (localPush) {
          pushTotal++
          batch.pushes.push(this.bindPush(localPush, recordsById))
        }
      }
      const isFinalConflict = conflictIndex === plan.conflicts.length - 1
      if (isFinalConflict) {
        this.report({
          phase: "resolving-conflicts",
          currentPath: conflict.path,
          currentDirection: undefined,
          ...counters(true),
        })
      }
    }

    for (const stagedCopy of stagedCopyPulls) {
      const remoteRecord = stagedCopy.pull.remoteRecord!
      const bytes = prefetchedRemoteBodies.get(remoteRecord.fileId) ?? await this.readRecord(remoteRecord, stagedCopy.pull.remoteCommitSha)
      const stage = await this.stageBytes(bytes, remoteRecord.mtime, stagedCopy.pull.change.before?.size ?? 0, ownedStages)
      stagedCopy.pull.stage = stage
      if (stagedCopy.push) stagedCopy.push.source = this.stageHandle(stage)
      if (this.input.runState) {
        const stages = this.input.runState.conflictCopyStages ?? new Map()
        stages.set(stagedCopy.reserved.fileId, { ...stagedCopy.reserved, stage })
        this.input.runState.conflictCopyStages = stages
      }
    }

    let pulledFiles = 0
    let recoveryPlan: { payload: V4RecoveryPayload; pullCompletionIds: Set<string> } | undefined
    if (this.input.recoveryStore) {
      recoveryPlan = await this.prepareRecoveryLocalPayload(batch, ownedStages, localById)
      pulledFiles = batch.pulls.length
    } else {
      for (const binding of batch.pulls) {
        await this.applyPullBinding(binding, ownedStages, () => {
          pullCompleted++
          this.report({ currentPath: binding.change.path, currentDirection: "pull", pull: directional(pullCompleted, pullTotal) })
        })
        pulledFiles++
      }
      for (const binding of batch.stagedWrites) {
        await this.applyStagedWrite(binding)
      }
    }

    if (batch.pushes.length === 0 && options.operation !== "forcePush" && !externalReconciled) {
      if (this.input.recoveryStore && recoveryPlan) {
        preserveStagesForRecovery = recoveryPlan.payload.mutations.length > 0
        let recovery = await this.input.recoveryStore.save({
          runId: batch.runId,
          phase: "remote-verified",
          expectedRemoteHead: baseCommitSha ?? null,
          verifiedRemoteHead: remote!.commitSha,
          payload: recoveryPlan.payload,
        })
        const applied = await applyV4RecoveryLocalMutations({
          store: this.input.recoveryStore,
          snapshot: recovery,
          io: this.localIo,
          onApplying: mutation => this.report({ phase: "applying", currentPath: mutation.path, currentDirection: mutation.id.startsWith("pull:") ? "pull" : "push" }),
          onApplied: mutation => {
            if (!recoveryPlan!.pullCompletionIds.has(mutation.id)) return
            pullCompleted++
            this.report({ currentPath: mutation.path, currentDirection: "pull", pull: directional(pullCompleted, pullTotal) })
          },
        })
        recovery = applied.snapshot
        if (applied.replanRequired) {
          preserveStagesForRecovery = false
          throw new V4RecoveryReplanRequiredError(remote!.commitSha)
        }
        preserveStagesForRecovery = false
      }
      this.replaceIndex(allRemoteRecords, remote!.head, remote!.commitSha)
      this.localReadCache.clear()
      return {
        mode: options.operation === "forcePull" ? "force-pull" : "pull",
        operation: options.operation,
        changedFiles,
        pushedFiles: 0,
        pulledFiles,
        recoveryRunId: this.input.recoveryStore ? batch.runId : undefined,
      }
    }

    const pushContentPaths = new Set(batch.pushes.flatMap(binding => binding.source?.kind === "vault" ? [binding.source.path] : []))
    this.localReadCache.retain(pushContentPaths)
    const files: V4GitTreeFile[] = []
    const deletions = new Set<string>()
    const journalChanges: V4JournalChange[] = []
    if (externalReconciled) {
      const beforeById = new Map(metadataRemoteRecords.map(record => [record.fileId, record]))
      const afterById = new Map(allRemoteRecords.map(record => [record.fileId, record]))
      for (const change of plan.pulls) {
        const before = beforeById.get(change.fileId)
        const after = afterById.get(change.fileId)
        journalChanges.push({
          fileId: change.fileId,
          kind: change.kind,
          path: change.path,
          previousPath: change.previousPath,
          before: before ? descriptorFor(before) : undefined,
          after: after ? descriptorFor(after) : undefined,
        })
      }
    }
    const journalId = `${this.now()}-${toBase64Url(randomBytes(6))}`
    batch.journalId = journalId
    const publicationBase = await resolveV4PublicationBase(this.input.github, ref?.sha ?? null)
    const completedPushIds = new Set<string>()
    const completePush = (item: V4GitTreeProgressItem, currentPath = item.path): void => {
      if (completedPushIds.has(item.fileId)) return
      completedPushIds.add(item.fileId)
      pushCompleted++
      this.report({ currentPath, currentDirection: "push", push: directional(pushCompleted, pushTotal) })
    }
    let latestUploadPath: string | undefined
    const onUploadStarted = (item: V4GitTreeProgressItem): void => {
      latestUploadPath = item.path
      this.report({
        phase: "uploading",
        currentPath: item.path,
        currentDirection: "push",
        push: directional(pushCompleted, pushTotal),
      })
    }
    const onUploaded = (item: V4GitTreeProgressItem): void => completePush(item, latestUploadPath ?? item.path)
    const withBlobTransport = (bytes: Uint8Array, task: () => Promise<string>): Promise<string> =>
      this.resources.withTransportBytes(estimateV4GitBlobTransportBytes(bytes.byteLength), task)
    const streamedEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = []
    const streamedUploadedPushIds = new Set<string>()
    const pushContexts = batch.pushes.map(binding => {
      const change = binding.change
      const previous = recordsById.get(change.fileId)
      const after = change.kind === "delete" ? undefined : change.after
      const reusesEncryptedContent = !!binding.reuseRecord || (!!after
        && change.kind === "rename"
        && !!previous
        && after.hash === previous.plaintextSha256
        && this.input.config.mode === "encrypted")
      return { binding, change, previous, after, reusesEncryptedContent }
    })
    const journalByFileId = new Map<string, V4JournalChange>()
    for (const context of pushContexts) {
      const journal: V4JournalChange = {
        fileId: context.change.fileId,
        kind: context.change.kind,
        path: context.change.path,
        previousPath: context.change.previousPath,
        before: context.previous ? descriptorFor(context.previous) : undefined,
      }
      journalChanges.push(journal)
      journalByFileId.set(context.change.fileId, journal)
    }
    const packCandidates: V4PackCandidateMeta[] = this.input.config.mode === "encrypted"
      ? pushContexts
        .filter(context => context.after && context.change.kind !== "delete" && !context.reusesEncryptedContent)
        .map(context => ({ fileId: context.change.fileId, path: context.after!.path, size: context.after!.size }))
      : []
    const packGroups = planV4PackGroups(packCandidates, {
      maxPlaintextBytes: this.resources.limits.maxPackPlaintextBytes,
      maxResidentBytes: this.resources.limits.maxResidentBytes,
      maxTransportTransientBytes: this.resources.limits.maxTransportTransientBytes,
    })
    const packGroupByFileId = new Map<string, number>()
    packGroups.forEach((group, groupIndex) => group.forEach(candidate => packGroupByFileId.set(candidate.fileId, groupIndex)))
    const contextByFileId = new Map(pushContexts.map(context => [context.change.fileId, context]))
    const processedPackGroups = new Set<number>()

    for (const context of pushContexts) {
      const { change, previous, after } = context
      const journal = journalByFileId.get(change.fileId)!
      if (change.kind === "delete") {
        recordsById.delete(change.fileId)
        continue
      }
      if (!after) continue
      if (context.reusesEncryptedContent && previous) {
        const relocated = await this.codec.relocate(previous, after.path)
        const record: V4IndexFileRecord = { ...relocated, path: after.path, mtime: after.mtime }
        recordsById.set(after.fileId, record)
        journal.after = descriptorFor(record)
        this.localReadCache.delete(after.path)
        continue
      }

      const packGroupIndex = packGroupByFileId.get(change.fileId)
      if (packGroupIndex !== undefined) {
        if (processedPackGroups.has(packGroupIndex)) continue
        processedPackGroups.add(packGroupIndex)
        const groupMeta = packGroups[packGroupIndex]
        const groupContexts = groupMeta.map(candidate => contextByFileId.get(candidate.fileId)!)
        const groupBudget = estimateV4PackGroupResources(groupMeta)
        const progressItems = groupContexts.map(groupContext => ({ fileId: groupContext.change.fileId, path: groupContext.after!.path }))
        const uploadedPack = await this.resources.withResidentBytes(groupBudget.residentBytes, () =>
          this.resources.withTransportBytes(groupBudget.transportBytes, async () => {
            for (const item of progressItems) onUploadStarted(item)
            for (const groupContext of groupContexts) {
              this.report({
                phase: "encrypting",
                currentPath: groupContext.after!.path,
                currentDirection: "push",
                push: directional(pushCompleted, pushTotal),
              })
            }
            const packed = await this.codec.preparePackFromSources(`${journalId}-${packGroupIndex}`, groupContexts.map(groupContext => {
              const groupAfter = groupContext.after!
              const sourceHandle = groupContext.binding.source
              return {
                logicalPath: groupAfter.path,
                fileId: groupAfter.fileId,
                source: this.packContentSource(groupContext.binding),
                expectedHash: groupAfter.hash,
                expectedSize: groupAfter.size,
                version: journalId,
                mtime: groupAfter.mtime,
                checkSourceStable: sourceHandle?.kind === "vault"
                  ? () => this.assertVaultSnapshot(sourceHandle)
                  : undefined,
              }
            }))
            const sha = await this.input.github.createGitBlob(packed.file.bytes)
            return { packed, sha }
          }),
        )
        streamedEntries.push({ path: uploadedPack.packed.file.path, mode: "100644", type: "blob", sha: uploadedPack.sha })
        for (const item of progressItems) {
          streamedUploadedPushIds.add(item.fileId)
          completePush(item, item.path)
        }
        for (let index = 0; index < uploadedPack.packed.records.length; index++) {
          const groupContext = groupContexts[index]
          const groupAfter = groupContext.after!
          const record: V4IndexFileRecord = { ...uploadedPack.packed.records[index], path: groupAfter.path }
          recordsById.set(record.fileId, record)
          journalByFileId.get(record.fileId)!.after = descriptorFor(record)
          this.localReadCache.delete(groupAfter.path)
        }
        continue
      }

      const predictedRemoteBytes = after.size + (this.input.config.mode === "encrypted" ? 33 : 0)
      const usesV4Parts = shouldUseV4Parts(after.size, predictedRemoteBytes)
      if (usesV4Parts || after.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        const source = await this.openPushContentSource(context.binding)
        const partBytes = usesV4Parts
          ? selectV4WriterPartBytes({
              logicalBytes: after.size,
              maxTransportTransientBytes: this.resources.limits.maxTransportTransientBytes,
            })
          : V4_PART_BYTES
        const prepared = await this.codec.prepareFromSource({
          logicalPath: after.path,
          source,
          expectedHash: after.hash,
          version: journalId,
          mtime: after.mtime,
          fileId: after.fileId,
          partBytes,
          checkSourceStable: context.binding.source?.kind === "vault"
            ? () => this.assertVaultSnapshot(context.binding.source as Extract<V4ContentHandle, { kind: "vault" }>)
            : undefined,
        })
        const progressItem = { fileId: after.fileId, path: after.path }
        const uploaded = await uploadV4ObjectStream(this.input.github, {
          objects: prepared.objects(),
          progressItem,
          onLogicalFileUploadStarted: onUploadStarted,
          onLogicalFileUploaded: onUploaded,
          withBlobTransport,
        })
        streamedEntries.push(...uploaded.entries as Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>)
        streamedUploadedPushIds.add(after.fileId)
        const streamedRecord = await prepared.finalize()
        const record: V4IndexFileRecord = { path: after.path, ...streamedRecord }
        recordsById.set(after.fileId, record)
        journal.after = descriptorFor(record)
        this.localReadCache.delete(after.path)
        continue
      }

      const prepared = await this.resources.withResidentBytes(after.size, async () => {
        const bytes = await this.readPushBinding(context.binding)
        this.report({
          phase: this.input.config.mode === "encrypted" ? "encrypting" : "hashing",
          currentPath: after.path,
          currentDirection: "push",
          push: directional(pushCompleted, pushTotal),
        })
        return this.codec.prepare(after.path, bytes, journalId, after.mtime, after.fileId)
      })
      const record: V4IndexFileRecord = { path: after.path, ...prepared.record }
      recordsById.set(after.fileId, record)
      files.push(...prepared.files.map(file => ({
        ...file,
        progressItems: [{ fileId: after.fileId, path: after.path }],
      })))
      journal.after = descriptorFor(record)
      this.localReadCache.delete(after.path)
    }

    const finalRecords = [...recordsById.values()]
    await assertV4RemoteRecordSet(finalRecords, this.input.config, this.input.keyring)
    const finalObjectPaths = new Set(finalRecords.flatMap(recordPaths))
    for (const path of allRemoteRecords.flatMap(recordPaths)) if (!finalObjectPaths.has(path)) deletions.add(path)
    const finalByBucket = recordsByBucket(finalRecords)
    const oldByBucket = recordsByBucket(metadataRemoteRecords)
    const buckets = new Set(finalByBucket.keys())
    const oldBuckets = new Set(remote ? Object.keys(remote.head.shardHashes) : [])
    for (const bucket of oldBuckets) if (!buckets.has(bucket)) deletions.add(v4RemoteShardPath(bucket, remote!.config.mode))
    const generation = (remote?.head.generation ?? 0) + 1
    const changedBuckets = new Set<string>()
    for (const bucket of new Set([...oldByBucket.keys(), ...finalByBucket.keys()])) {
      if (bucketSignature(oldByBucket.get(bucket)) !== bucketSignature(finalByBucket.get(bucket))) changedBuckets.add(bucket)
    }
    const shardHashes = { ...(remote?.head.shardHashes ?? {}) }
    for (const bucket of oldBuckets) if (!buckets.has(bucket)) delete shardHashes[bucket]
    for (const bucket of changedBuckets) {
      if (buckets.has(bucket)) shardHashes[bucket] = await sha256Hex(utf8ToBytes(bucketSignature(finalByBucket.get(bucket))))
    }
    const head: V4RemoteHead = {
      formatVersion: 4,
      mode: this.input.config.mode,
      epoch: remote?.head.epoch ?? 1,
      generation,
      journalId,
      shardHashes,
      updatedAt: this.now(),
      deviceId: this.input.index.deviceId,
    }
    files.push(...await buildV4RemoteMetadata({ config: this.input.config, head, records: finalRecords, keyring: this.input.keyring, buckets: changedBuckets }))
    const pages = buildV4JournalPages(journalId, journalChanges)
    for (const page of pages) {
      const raw = utf8ToBytes(JSON.stringify(page))
      files.push({
        path: journalPath(journalId, page.page, this.input.config.mode === "encrypted"),
        bytes: this.input.config.mode === "encrypted"
          ? await encryptV4Payload(this.input.keyring!.journalKey, raw, { kind: "journal", aad: `${this.input.config.repoId}:${journalId}:${page.page}` })
          : raw,
      })
    }
    if (options.operation === "forcePush" && ref && this.input.github.getTreeAt) {
      const commit = await this.input.github.getGitCommit(ref.sha)
      const tree = await this.input.github.getTreeAt(commit.treeSha, true)
      if (tree.truncated) throw new Error("GitHub tree is truncated; Force Push cannot safely mirror the repository.")
      const written = new Set([
        ...files.map(file => file.path),
        ...finalObjectPaths,
        ...[...buckets].map(bucket => v4RemoteShardPath(bucket, this.input.config.mode)),
      ])
      for (const node of tree.tree) {
        const internal = node.path.startsWith(`${V4_ROOT}/`)
        if (node.type !== "blob" || (!internal && !includePath(node.path)) || written.has(node.path) || node.path.startsWith(`${V4_ROOT}/journals/`)) continue
        deletions.add(node.path)
      }
    }
    const uploadedPushIds = new Set([
      ...streamedUploadedPushIds,
      ...files.flatMap(file => (file.progressItems ?? []).map(item => item.fileId)),
    ])
    const stagedPushItems: V4GitTreeProgressItem[] = [
      ...batch.pushes.map(binding => ({ fileId: binding.change.fileId, path: binding.change.path })),
      ...migrationDeletionPushItems,
    ]
    for (const item of stagedPushItems) {
      if (!uploadedPushIds.has(item.fileId)) completePush(item)
    }
    const uploaded = await uploadV4TreeFiles(this.input.github, {
      files,
      onLogicalFileUploadStarted: onUploadStarted,
      onLogicalFileUploaded: onUploaded,
      withBlobTransport,
      onUploadsComplete: () => this.report({
        phase: "committing",
        currentPath: undefined,
        currentDirection: undefined,
        push: directional(pushCompleted, pushTotal),
      }),
    })
    const candidate = await createV4CandidateCommit(this.input.github, {
      base: publicationBase,
      message: `obsidian-sync-v4:${journalId}`,
      entries: [...streamedEntries, ...uploaded.entries],
      deletions: [...deletions],
    })
    let recoverySnapshot = this.input.recoveryStore
      ? await this.input.recoveryStore.save({
        runId: batch.runId,
        journalId,
        phase: "publish-intent",
        expectedRemoteHead: candidate.previousHeadSha ?? null,
        candidateCommitSha: candidate.commitSha,
        payload: recoveryPlan?.payload ?? { mutations: [], completedMutationIds: [] },
      })
      : undefined
    preserveStagesForRecovery = !!recoverySnapshot && (recoveryPlan?.payload.mutations.length ?? 0) > 0
    await publishV4CandidateRef(this.input.github, candidate)
    if (this.input.recoveryStore && recoverySnapshot) {
      const verifiedRef = await this.input.github.getGitRefOrNull()
      if (verifiedRef?.sha !== candidate.commitSha) throw new Error("V4 candidate publication could not be verified.")
      recoverySnapshot = await this.input.recoveryStore.save({
        runId: batch.runId,
        journalId,
        phase: "remote-verified",
        expectedRemoteHead: candidate.previousHeadSha ?? null,
        candidateCommitSha: candidate.commitSha,
        verifiedRemoteHead: candidate.commitSha,
        payload: recoveryPlan?.payload ?? { mutations: [], completedMutationIds: [] },
      })
      if (recoveryPlan) {
        const applied = await applyV4RecoveryLocalMutations({
          store: this.input.recoveryStore,
          snapshot: recoverySnapshot,
          io: this.localIo,
          onApplying: mutation => this.report({ phase: "applying", currentPath: mutation.path, currentDirection: mutation.id.startsWith("pull:") ? "pull" : "push" }),
          onApplied: mutation => {
            if (!recoveryPlan!.pullCompletionIds.has(mutation.id)) return
            pullCompleted++
            this.report({ currentPath: mutation.path, currentDirection: "pull", pull: directional(pullCompleted, pullTotal) })
          },
        })
        recoverySnapshot = applied.snapshot
        if (applied.replanRequired) {
          preserveStagesForRecovery = false
          throw new V4RecoveryReplanRequiredError(candidate.commitSha)
        }
      }
      preserveStagesForRecovery = false
    }
    const published = { ...candidate, fileShas: uploaded.fileShas }
    this.replaceIndex(finalRecords, head, published.commitSha)
    const mode = options.operation === "forcePush" ? "force-push" : pulledFiles > 0 ? "pull-push" : "push"
    this.localReadCache.clear()
    return {
      mode,
      operation: options.operation,
      changedFiles,
      pushedFiles: batch.pushes.length,
      pulledFiles,
      commitSha: published.commitSha,
      recoveryRunId: this.input.recoveryStore ? batch.runId : undefined,
    }
    } finally {
      if (!preserveStagesForRecovery) await this.cleanupStages(ownedStages)
      this.localReadCache.clear()
    }
  }

  private async reconcileExternalCommit(remote: V4RemoteState, treeSha: string): Promise<void> {
    if (remote.config.mode === "encrypted") {
      throw new Error("External GitHub changes touched an encrypted V4 branch without updating its journal. Use Force Push or Force Pull after reviewing the commit.")
    }
    if (!this.input.github.getTreeAt) throw new Error("External GitHub changes require recursive tree support.")
    if (remote.records.some(record => record.storage !== "single")) {
      throw new Error("External GitHub changes cannot be safely reconciled while large or packed V4 objects exist.")
    }
    const tree = await this.input.github.getTreeAt(treeSha, true)
    if (tree.truncated) throw new Error("External GitHub tree is truncated; sync is unsafe.")
    const existingByPath = new Map(remote.records.map(record => [record.path, record]))
    const includePath = this.input.includePath ?? (() => true)
    const reconciled: V4IndexFileRecord[] = remote.records.filter(record => !includePath(record.path))
    for (const node of tree.tree) {
      if (node.type !== "blob" || node.path === V4_CONFIG_PATH || node.path.startsWith(`${V4_ROOT}/`)) continue
      if (!includePath(node.path)) continue
      const file = await this.input.github.getFileBytes(node.path, remote.commitSha)
      if (!file) continue
      const previous = existingByPath.get(node.path)
      const pathId = previous?.pathId ?? await sha256Hex(utf8ToBytes(`path:${node.path}`))
      reconciled.push({
        path: node.path,
        pathId,
        fileId: previous?.fileId ?? pathId,
        plaintextSha256: await sha256Hex(file.bytes),
        size: file.bytes.byteLength,
        mtime: this.now(),
        remoteVersion: `external:${remote.commitSha}`,
        remotePath: node.path,
        storage: "single",
      })
    }
    remote.records = reconciled
  }

  private async scanLocalStable(
    baseRecords: V4IndexFileRecord[],
    changes: V4QueuedChange[],
    identitySeedByPath?: ReadonlyMap<string, string>,
    additionalFilesByPath?: ReadonlyMap<string, string>,
  ): Promise<V4LogicalFile[]> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.scanLocal(baseRecords, changes, identitySeedByPath, additionalFilesByPath)
      } catch (error) {
        if (!(error instanceof V4SourceChangedError)) throw error
        lastError = error
        this.localReadCache.clear()
      }
    }
    throw lastError
  }

  private async scanLocal(
    baseRecords: V4IndexFileRecord[],
    changes: V4QueuedChange[],
    identitySeedByPath?: ReadonlyMap<string, string>,
    additionalFilesByPath?: ReadonlyMap<string, string>,
  ): Promise<V4LogicalFile[]> {
    this.report({ phase: "scanning-local", currentPath: undefined, currentDirection: undefined })
    const pathChanges = changes.filter((change): change is Exclude<V4QueuedChange, { type: "rescan" }> => change.type !== "rescan")
    const hasFolderChange = pathChanges.some(change => change.type === "folderRename" || change.type === "folderDelete")
    if (changes.length > 0 && pathChanges.length === changes.length && !hasFolderChange && baseRecords.length > 0 && this.localIo.stat) {
      const byPath = new Map(logical(baseRecords).map(file => [file.path, file]))
      for (const change of pathChanges) {
        if (change.type === "delete") { byPath.delete(change.path); continue }
        const previous = change.type === "replace" ? undefined : change.type === "rename" ? byPath.get(change.oldPath) : byPath.get(change.path)
        if (change.type === "replace") { byPath.delete(change.oldPath); byPath.delete(change.path) }
        if (change.type === "rename") byPath.delete(change.oldPath)
        this.report({ phase: "scanning-local", currentPath: change.path, currentDirection: undefined })
        const stat = await this.localIo.stat(change.path)
        if (!stat) { byPath.delete(change.path); continue }
        this.report({ phase: "hashing", currentPath: change.path, currentDirection: undefined })
        const hash = await this.hashLocal(change.path, stat.size, stat.mtime)
        byPath.set(change.path, {
          path: change.path,
          fileId: previous?.fileId ?? await this.newFileId(change.path),
          hash,
          size: stat.size,
          mtime: stat.mtime,
        })
      }
      for (const [path, fileId] of additionalFilesByPath ?? []) {
        if (byPath.has(path)) continue
        this.report({ phase: "scanning-local", currentPath: path, currentDirection: undefined })
        const stat = await this.localIo.stat(path)
        if (!stat) continue
        this.report({ phase: "hashing", currentPath: path, currentDirection: undefined })
        const hash = await this.hashLocal(path, stat.size, stat.mtime)
        byPath.set(path, {
          path,
          fileId,
          hash,
          size: stat.size,
          mtime: stat.mtime,
        })
      }
      return [...byPath.values()]
    }
    const identityByPath = new Map(baseRecords.map(record => [record.path, record]))
    for (const change of changes) {
      if (change.type === "replace") {
        identityByPath.delete(change.oldPath)
        identityByPath.delete(change.path)
        continue
      }
      if (change.type === "rename") {
        const record = identityByPath.get(change.oldPath)
        if (record) { identityByPath.delete(change.oldPath); identityByPath.set(change.path, record) }
        continue
      }
      if (change.type !== "folderRename") continue
      const oldPrefix = `${change.oldPath}/`
      for (const [path, record] of [...identityByPath]) {
        if (path !== change.oldPath && !path.startsWith(oldPrefix)) continue
        const suffix = path.slice(change.oldPath.length)
        identityByPath.delete(path)
        identityByPath.set(`${change.path}${suffix}`, record)
      }
    }
    const files = await this.localIo.listFiles()
    return boundedMap(files, this.resources.limits.maxVaultReads, async file => {
      this.report({ phase: "scanning-local", currentPath: file.path, currentDirection: undefined })
      const existing = identityByPath.get(file.path)
      const unchangedStat = existing && existing.size === file.size && existing.mtime === file.mtime
      if (!unchangedStat) this.report({ phase: "hashing", currentPath: file.path, currentDirection: undefined })
      return {
        path: file.path,
        fileId: identitySeedByPath?.get(file.path) ?? existing?.fileId ?? await this.newFileId(file.path),
        hash: unchangedStat ? existing.plaintextSha256 : await this.hashLocal(file.path, file.size, file.mtime),
        size: file.size,
        mtime: file.mtime,
      }
    })
  }

  private bindPull(
    change: V4PlannedChange,
    records: ReadonlyMap<string, V4IndexFileRecord>,
    remoteCommitSha?: string,
  ): V4PullBinding {
    return { change, remoteRecord: change.kind === "delete" ? undefined : records.get(change.fileId), remoteCommitSha }
  }

  private bindPush(
    change: V4PlannedChange,
    records: ReadonlyMap<string, V4IndexFileRecord>,
  ): V4PushBinding {
    if (change.kind === "delete" || !change.after) return { change }
    const previous = records.get(change.fileId)
    const reusesEncryptedContent = change.kind === "rename"
      && !!previous
      && change.after.hash === previous.plaintextSha256
      && this.input.config.mode === "encrypted"
    if (reusesEncryptedContent) return { change, reuseRecord: previous }
    return {
      change,
      source: {
        kind: "vault",
        path: change.after.path,
        expectedHash: change.after.hash,
        expectedSize: change.after.size,
        expectedMtime: change.after.mtime,
      },
    }
  }

  private stageHandle(stage: V4StageRef): V4ContentHandle {
    return { kind: "stage", stageId: stage.stageId, expectedHash: stage.hash, expectedSize: stage.size }
  }

  private async stageBytes(
    bytes: Uint8Array,
    mtime: number,
    existingTargetBytes: number,
    ownedStages: V4StageRef[],
  ): Promise<V4StageRef> {
    let stage: V4StageRef | undefined
    if (this.localIo.staging) {
      try {
        stage = await this.localIo.staging.stageSource(createV4WholeBufferContentSource(bytes), {
          mtime,
          existingTargetBytes,
          atomicReplace: false,
        })
      } catch (error) {
        const capabilityUnavailable = error instanceof V4BoundedIoUnavailableError
        if (!capabilityUnavailable || bytes.byteLength > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) throw error
      }
    }
    if (!stage) {
      if (bytes.byteLength > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        throw new V4BoundedIoUnavailableError("bounded-append")
      }
      const stageId = `memory_${++this.ephemeralStageSequence}`
      const copy = new Uint8Array(bytes)
      this.ephemeralStages.set(stageId, copy)
      stage = {
        stageId,
        hash: await this.resources.withCrypto(() => sha256Hex(copy)),
        size: copy.byteLength,
        mtime,
      }
    }
    ownedStages.push(stage)
    return stage
  }

  private async cleanupStages(stages: readonly V4StageRef[]): Promise<void> {
    for (const stage of [...stages].reverse()) {
      if (this.ephemeralStages.delete(stage.stageId)) continue
      try { await this.localIo.staging?.remove(stage) } catch {}
    }
  }

  private async readStage(stage: V4StageRef): Promise<Uint8Array> {
    const memory = this.ephemeralStages.get(stage.stageId)
    if (memory) return new Uint8Array(memory)
    if (!this.localIo.staging) throw new Error(`Missing V4 staging store for ${stage.stageId}`)
    const source = await this.localIo.staging.open(stage)
    return collectV4ContentSource(source, this.resources.limits.maxResidentBytes)
  }

  private packContentSource(binding: V4PushBinding): V4ContentSource {
    const after = binding.change.after
    if (!after) throw new Error(`Missing V4 pack content metadata for ${binding.change.path}`)
    const session = this
    return {
      size: after.size,
      async *chunks(chunkBytes: number, signal?: AbortSignal) {
        let bytes: Uint8Array
        const source = binding.source
        if (source?.kind === "stage") {
          bytes = await session.readStage({ stageId: source.stageId, hash: source.expectedHash, size: source.expectedSize, mtime: after.mtime })
        } else {
          const path = source?.kind === "vault" ? source.path : after.path
          bytes = await session.resources.withVaultRead(() => session.localIo.read(path))
        }
        if (bytes.byteLength !== after.size) throw new V4SourceChangedError(after.path, `read ${bytes.byteLength} bytes; expected ${after.size}`)
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          if (signal?.aborted) throw signal.reason ?? new Error("V4 pack source read aborted.")
          yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes))
        }
      },
    }
  }

  private async readPushBinding(binding: V4PushBinding): Promise<Uint8Array> {
    const after = binding.change.after
    if (!after) throw new Error(`Missing V4 push content metadata for ${binding.change.path}`)
    const source = binding.source
    if (!source) return this.readLocal(after.path)
    if (source.kind === "vault") return this.readLocal(source.path)
    const stage: V4StageRef = { stageId: source.stageId, hash: source.expectedHash, size: source.expectedSize, mtime: after.mtime }
    return this.readStage(stage)
  }

  private async stageRemotePull(binding: V4PullBinding, ownedStages: V4StageRef[]): Promise<V4StageRef> {
    const record = binding.remoteRecord
    if (!record) throw new Error(`Missing V4 remote record for ${binding.change.path}`)
    if (!this.localIo.staging) throw new V4BoundedIoUnavailableError("bounded-append", binding.change.path)
    const existingTargetBytes = binding.change.before?.path === binding.change.path ? binding.change.before.size : 0
    const sink = await this.localIo.staging.beginStage({
      expectedSize: record.size,
      mtime: record.mtime,
      existingTargetBytes,
      atomicReplace: false,
    })
    try {
      const result = await this.codec.readToSink({
        record,
        reader: async path => {
          const file = await this.input.github.getFileBytes(path, binding.remoteCommitSha)
          if (!file) throw new Error(`Missing V4 remote object: ${path}`)
          return file.bytes
        },
        sink,
      })
      const stage = await sink.finish(result)
      ownedStages.push(stage)
      return stage
    } catch (error) {
      await sink.abort()
      throw error
    }
  }

  private async prepareRecoveryLocalPayload(
    batch: V4ResolvedBatch,
    ownedStages: V4StageRef[],
    localById: ReadonlyMap<string, V4LogicalFile>,
  ): Promise<{ payload: V4RecoveryPayload; pullCompletionIds: Set<string> }> {
    const mutations: V4RecoveryLocalMutation[] = []
    const pullCompletionIds = new Set<string>()
    const addPull = async (binding: V4PullBinding) => {
      const change = binding.change
      if (change.kind === "delete") {
        const id = `pull:${change.fileId}:delete`
        mutations.push({ id, kind: "trash", path: change.path, precondition: this.pullPrecondition(change) })
        pullCompletionIds.add(id)
        return
      }
      if (!binding.stage) {
        this.report({ phase: "downloading", currentPath: change.path, currentDirection: "pull" })
        binding.stage = await this.stageRemotePull(binding, ownedStages)
      }
      if (this.ephemeralStages.has(binding.stage.stageId)) throw new V4BoundedIoUnavailableError("bounded-append", change.path)
      const writeId = `pull:${change.fileId}:write`
      mutations.push({ id: writeId, kind: "stage-write", path: change.path, stage: binding.stage, precondition: this.pullPrecondition(change) })
      if (change.kind === "rename" && change.previousPath) {
        const trashId = `pull:${change.fileId}:rename-trash`
        mutations.push({ id: trashId, kind: "trash", path: change.previousPath, precondition: this.pullPrecondition(change, change.previousPath) })
        pullCompletionIds.add(trashId)
      } else {
        pullCompletionIds.add(writeId)
      }
    }
    for (const binding of batch.pulls) await addPull(binding)

    for (const binding of batch.stagedWrites) {
      if (this.ephemeralStages.has(binding.stage.stageId)) throw new V4BoundedIoUnavailableError("bounded-append", binding.change.path)
      const current = localById.get(binding.change.fileId)
      const path = binding.change.path
      const precondition: V4LocalTargetPrecondition = current && current.path === path
        ? { path, exists: true, size: current.size, mtime: current.mtime }
        : { path, exists: false }
      mutations.push({ id: `local:${binding.change.fileId}:write`, kind: "stage-write", path, stage: binding.stage, precondition })
      if (binding.change.kind === "rename" && binding.change.previousPath) {
        const previous = localById.get(binding.change.fileId)
        mutations.push({
          id: `local:${binding.change.fileId}:rename-trash`,
          kind: "trash",
          path: binding.change.previousPath,
          precondition: previous && previous.path === binding.change.previousPath
            ? { path: binding.change.previousPath, exists: true, size: previous.size, mtime: previous.mtime }
            : { path: binding.change.previousPath, exists: false },
        })
      }
    }
    const stagedIds = new Set(mutations.flatMap(mutation => mutation.kind === "stage-write" ? [mutation.stage.stageId] : []))
    for (const copy of this.input.runState?.conflictCopyStages?.values() ?? []) {
      if (stagedIds.has(copy.stage.stageId)) continue
      const stat = this.localIo.stat ? await this.localIo.stat(copy.path) : null
      const precondition: V4LocalTargetPrecondition = stat
        ? { path: copy.path, exists: true, size: stat.size, mtime: stat.mtime }
        : { path: copy.path, exists: false }
      mutations.push({
        id: `conflict-copy:${copy.fileId}:write`,
        kind: "stage-write",
        path: copy.path,
        stage: copy.stage,
        precondition,
      })
    }
    return { payload: { mutations, completedMutationIds: [] }, pullCompletionIds }
  }

  private pullPrecondition(change: V4PlannedChange, path = change.path): V4LocalTargetPrecondition {
    const before = change.before
    if (before && before.path === path) return { path, exists: true, size: before.size, mtime: before.mtime }
    return { path, exists: false }
  }

  private async applyPullBinding(binding: V4PullBinding, ownedStages: V4StageRef[], onCompleted: () => void): Promise<void> {
    const change = binding.change
    if (change.kind === "delete") {
      await assertV4LocalTargetPrecondition(this.localIo, this.pullPrecondition(change))
      this.report({ phase: "applying", currentPath: change.path, currentDirection: "pull" })
      await trashV4LocalUserFile(this.localIo, change.path)
      onCompleted()
      return
    }
    const record = binding.remoteRecord
    if (!binding.stage && record?.storage === "chunked") {
      this.report({ phase: "downloading", currentPath: change.path, currentDirection: "pull" })
      binding.stage = await this.stageRemotePull(binding, ownedStages)
    }
    const targetPrecondition = this.pullPrecondition(change)
    if (binding.stage && binding.stage.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
      await assertV4LocalTargetPrecondition(this.localIo, targetPrecondition)
      if (change.kind === "rename" && change.previousPath) {
        await assertV4LocalTargetPrecondition(this.localIo, {
          path: change.previousPath, exists: true, size: change.before?.size, mtime: change.before?.mtime,
        })
      }
      if (!this.localIo.commitStage) throw new V4BoundedIoUnavailableError("stage-commit", change.path)
      this.report({ phase: "applying", currentPath: change.path, currentDirection: "pull" })
      await this.localIo.commitStage({ stage: binding.stage, path: change.path, precondition: targetPrecondition })
      if (change.kind === "rename" && change.previousPath) {
        await assertV4LocalTargetPrecondition(this.localIo, {
          path: change.previousPath, exists: true, size: change.before?.size, mtime: change.before?.mtime,
        })
        await trashV4LocalUserFile(this.localIo, change.previousPath)
      }
      onCompleted()
      return
    }
    let bytes: Uint8Array
    let mtime: number
    if (binding.stage) {
      bytes = await this.readStage(binding.stage)
      mtime = binding.stage.mtime
    } else {
      if (!record) throw new Error(`Missing V4 remote record for ${change.path}`)
      this.report({ phase: "downloading", currentPath: change.path, currentDirection: "pull" })
      bytes = await this.readRecord(record, binding.remoteCommitSha)
      mtime = record.mtime
    }
    await assertV4LocalTargetPrecondition(this.localIo, targetPrecondition)
    this.report({ phase: "applying", currentPath: change.path, currentDirection: "pull" })
    if (change.kind === "rename" && change.previousPath) {
      await assertV4LocalTargetPrecondition(this.localIo, {
        path: change.previousPath, exists: true, size: change.before?.size, mtime: change.before?.mtime,
      })
      await trashV4LocalUserFile(this.localIo, change.previousPath)
    }
    await this.localIo.write(change.path, bytes, mtime)
    if (!binding.stage) this.localReadCache.set(change.path, bytes)
    onCompleted()
  }

  private async applyStagedWrite(binding: V4StagedWriteBinding): Promise<void> {
    this.report({
      phase: "applying",
      currentPath: binding.change.path,
      currentDirection: "push",
    })
    const bytes = await this.readStage(binding.stage)
    if (binding.change.kind === "rename" && binding.change.previousPath) {
      await trashV4LocalUserFile(this.localIo, binding.change.previousPath)
    }
    await this.localIo.write(binding.change.path, bytes, binding.stage.mtime)
  }

  private async readLocal(path: string): Promise<Uint8Array> {
    const cached = this.localReadCache.get(path)
    if (cached) return cached
    const bytes = await this.resources.withVaultRead(() => this.localIo.read(path))
    this.localReadCache.set(path, bytes)
    return bytes
  }

  private async assertVaultSnapshot(handle: Extract<V4ContentHandle, { kind: "vault" }>): Promise<void> {
    if (!this.localIo.stat) return
    const stat = await this.localIo.stat(handle.path)
    if (!stat || stat.size !== handle.expectedSize || stat.mtime !== handle.expectedMtime) {
      throw new V4SourceChangedError(handle.path, "size or mtime changed")
    }
  }

  private async openPushContentSource(binding: V4PushBinding): Promise<V4ContentSource> {
    const after = binding.change.after
    const handle = binding.source
    if (!after || !handle) throw new Error(`Missing V4 push source for ${binding.change.path}`)
    if (this.localIo.openContentSource) return this.localIo.openContentSource(handle)
    if (handle.kind === "stage" && this.localIo.staging) {
      return this.localIo.staging.open({ stageId: handle.stageId, size: handle.expectedSize })
    }
    throw new V4BoundedIoUnavailableError("bounded-read", handle.kind === "vault" ? handle.path : undefined)
  }

  private async hashLocal(path: string, expectedBytes: number, expectedMtime: number): Promise<string> {
    const handle: Extract<V4ContentHandle, { kind: "vault" }> = {
      kind: "vault",
      path,
      expectedHash: "scan-pending",
      expectedSize: expectedBytes,
      expectedMtime,
    }
    await this.assertVaultSnapshot(handle)
    if (expectedBytes > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
      if (!this.localIo.openContentSource) throw new V4BoundedIoUnavailableError("bounded-read", path)
      const source = await this.localIo.openContentSource(handle)
      return hashV4StableContentSource(source, {
        chunkBytes: Math.min(4 * 1024 * 1024, Math.max(1, expectedBytes)),
        checkStable: () => this.assertVaultSnapshot(handle),
      })
    }
    return this.resources.withResidentBytes(expectedBytes, async () => {
      const bytes = await this.resources.withVaultRead(() => this.localIo.read(path))
      if (bytes.byteLength !== expectedBytes) throw new V4SourceChangedError(path, `read ${bytes.byteLength} bytes; expected ${expectedBytes}`)
      const hash = await this.resources.withCrypto(() => sha256Hex(bytes))
      await this.assertVaultSnapshot(handle)
      this.localReadCache.set(path, bytes)
      return hash
    })
  }

  private async readRecord(record: V4IndexFileRecord, remoteCommitSha?: string): Promise<Uint8Array> {
    return this.codec.read(record, async path => {
      const file = await this.input.github.getFileBytes(path, remoteCommitSha)
      if (!file) throw new Error(`Missing V4 remote object: ${path}`)
      return file.bytes
    })
  }

  private changeBetween(before?: V4LogicalFile, after?: V4LogicalFile): V4PlannedChange | null {
    if (!before && after) return { fileId: after.fileId, kind: "create", path: after.path, after }
    if (before && !after) return { fileId: before.fileId, kind: "delete", path: before.path, before }
    if (!before || !after) return null
    if (before.path !== after.path) return { fileId: after.fileId, kind: "rename", path: after.path, previousPath: before.path, before, after }
    return { fileId: after.fileId, kind: "modify", path: after.path, before, after }
  }

  private conflictCopyPath(path: string): string {
    const dot = path.lastIndexOf(".")
    const suffix = `.conflict-remote-${this.input.index.deviceId}-${this.now()}`
    return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`
  }

  private async newFileId(seed: string): Promise<string> {
    return (await sha256Hex(utf8ToBytes(`${seed}:${this.input.index.deviceId}:${this.now()}:${toBase64Url(randomBytes(8))}`))).slice(0, 32)
  }

  private replaceIndex(records: V4IndexFileRecord[], head: V4RemoteHead, commitSha: string): void {
    this.input.index.shards = {}
    for (const record of records) {
      const bucket = bucketForV4PathId(record.pathId)
      const shard = this.input.index.shards[bucket] ?? { bucket, hash: head.shardHashes[bucket] ?? "", records: {} }
      shard.records[record.pathId] = { ...record, dirty: false }
      this.input.index.shards[bucket] = shard
    }
    this.input.index.remoteCommitSha = commitSha
    this.input.index.epoch = head.epoch
    this.input.index.generation = head.generation
    this.input.index.shardHashes = { ...head.shardHashes }
    this.input.index.mode = head.mode
  }
}
