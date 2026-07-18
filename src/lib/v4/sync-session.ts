import { randomBytes, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import type { GitHubTree } from "../github-api"
import { evaluateV4ChangeGuard } from "./change-guard"
import { resolveV4Conflict, type V4ConflictPolicy, type V4ConflictResolution } from "./conflicts"
import type { V4Keyring } from "./crypto"
import { encryptV4Payload } from "./crypto"
import { publishV4TreeChanges, type V4GitTreeFile, type V4GitTreeGithub, type V4GitTreeProgressItem } from "./git-tree-writer"
import { buildV4JournalPages, type V4JournalChange } from "./history-journal"
import { isV4LocalIndexCacheComplete, isV4LocalIndexShardConsistent, type V4IndexFileRecord, type V4LocalIndex } from "./local-index"
import { bucketForV4PathId } from "./paths"
import { planV4Sync, type V4LogicalFile, type V4PlannedChange, type V4SyncOperation } from "./planner"
import {
  buildV4RemoteMetadata,
  assertV4RemoteRecordSet,
  assertV4RemoteShardRecords,
  decodeV4RemoteConfig,
  decodeV4RemoteHead,
  decodeV4RemoteShard,
  v4RemoteShardPath,
} from "./remote-index"
import { effectiveV4PathLayout, expectedV4PathLayout, V4_CONFIG_PATH, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "./protocol-types"
import { V4StorageCodec } from "./storage-codec"
import type { V4QueuedChange } from "./sync-coordinator"
import type { V4DirectionalProgress, V4SyncProgressPatch } from "./progress"

export interface V4SessionVaultFile { path: string; size: number; mtime: number }
export interface V4SessionVault {
  listFiles(): Promise<V4SessionVaultFile[]>
  stat?(path: string): Promise<V4SessionVaultFile | null>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array, mtime?: number): Promise<void>
  delete(path: string): Promise<void>
}

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
}

export interface V4SessionSyncResult {
  mode: "noop" | "pull" | "push" | "pull-push" | "force-pull" | "force-push"
  operation: V4SyncOperation
  changedFiles: number
  pushedFiles: number
  pulledFiles: number
  commitSha?: string
}

interface V4RemoteState {
  config: V4RemoteConfig
  head: V4RemoteHead
  records: V4IndexFileRecord[]
  commitSha: string
}

interface V4EffectivePull {
  change: V4PlannedChange
  cachedBytes?: Uint8Array
  cachedMtime?: number
}

interface V4DeferredLocalApply {
  path: string
  bytes: Uint8Array
  mtime: number
}

export class V4ChangeGuardError extends Error {
  constructor(public readonly changePercent: number, public readonly thresholdPercent: number) {
    super(`V4 change guard blocked sync: ${changePercent}% exceeds ${thresholdPercent}%.`)
    this.name = "V4ChangeGuardError"
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

export function assertV4PathLayoutCompatible(remote: V4RemoteConfig, desired: V4RemoteConfig, operation: V4SyncOperation): void {
  const actual = effectiveV4PathLayout(remote)
  const expected = expectedV4PathLayout(desired.mode)
  if (actual === expected) return
  if (operation === "forcePush") return
  throw new Error(`Remote encrypted path layout is ${actual}; confirmed Force Push is required to migrate to ${expected}.`)
}

const PACK_MIN_CHANGED_FILES = 64
const PACK_MAX_FILES = 500
const PACK_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024
const PACK_MAX_ENTRY_BYTES = 1024 * 1024

export class V4SyncSession {
  private readonly codec: V4StorageCodec
  private readonly now: () => number
  private readonly localReadCache = new Map<string, Uint8Array>()

  constructor(private readonly input: V4SyncSessionInput) {
    this.codec = new V4StorageCodec({
      mode: input.config.mode,
      pathLayout: input.config.pathLayout ?? expectedV4PathLayout(input.config.mode),
      keyring: input.keyring,
    })
    this.now = input.now ?? (() => Date.now())
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
    const baseCommitSha = this.input.index.remoteCommitSha
    this.report({ phase: "checking-remote", currentPath: undefined, currentDirection: undefined })
    const ref = await this.input.github.getGitRefOrNull()
    const remoteConfig = await this.loadRemoteConfig(ref?.sha, options.operation)
    const localCacheComplete = isV4LocalIndexCacheComplete(this.input.index)
    const remote = ref && remoteConfig && remoteConfig.mode !== "encrypted" && localCacheComplete && ref.sha === this.input.index.remoteCommitSha && this.input.index.pathLayout === effectiveV4PathLayout(remoteConfig)
      ? this.remoteFromLocalIndex(ref.sha, remoteConfig)
      : await this.loadRemote(ref?.sha, remoteConfig, options.operation)
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
    const identitySeedByPath = causalState?.identityByPath
    const localFiles = (await this.scanLocal(identityBaseRecords, options.changes ?? [], identitySeedByPath)).filter(file => includePath(file.path))
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
      return { mode: "noop", operation: options.operation, changedFiles: 0, pushedFiles: 0, pulledFiles: 0 }
    }

    const recordsById = new Map((isLayoutMigration ? [] : allRemoteRecords).map(record => [record.fileId, record]))
    const remoteCommitSha = remote?.commitSha
    const effectivePulls: V4EffectivePull[] = plan.pulls.map(change => ({ change }))
    const pushes = [...plan.pushes]
    const deferredLocalApplies: V4DeferredLocalApply[] = []
    for (const [conflictIndex, conflict] of plan.conflicts.entries()) {
      this.report({
        phase: "resolving-conflicts",
        currentPath: conflict.path,
        currentDirection: undefined,
        ...counters(false),
      })
      const localBytes = conflict.local ? await this.readLocal(conflict.local.path) : undefined
      const remoteRecord = recordsById.get(conflict.fileId)
      const remoteBytes = remoteRecord ? await this.readRecord(remoteRecord, remoteCommitSha) : undefined
      const baseRecord = baseRecords.find(record => record.fileId === conflict.fileId)
      const baseBytes = baseRecord
        ? remoteRecord?.remoteVersion === baseRecord.remoteVersion
          ? remoteBytes
          : baseCommitSha
            ? await this.readRecord(baseRecord, baseCommitSha)
            : undefined
        : undefined
      let resolution = resolveV4Conflict({
        policy: this.input.conflictPolicy,
        path: conflict.path,
        localMtime: conflict.local?.mtime ?? 0,
        remoteMtime: conflict.remote?.mtime ?? 0,
        baseBytes,
        localBytes,
        remoteBytes,
      })
      if (resolution.action === "ask") {
        if (!this.input.askConflict) throw new Error(`Conflict requires user decision: ${conflict.path}`)
        resolution = await this.input.askConflict({ path: conflict.path, localMtime: conflict.local?.mtime ?? 0, remoteMtime: conflict.remote?.mtime ?? 0 })
        if (resolution.action === "ask") throw new Error(`Conflict cancelled: ${conflict.path}`)
      }
      const pull = resolution.action === "use-remote" ? this.changeBetween(conflict.local, conflict.remote) : null
      const localPush = resolution.action === "use-remote" ? null : this.changeBetween(conflict.remote, conflict.local)
      if (pull) {
        pullTotal++
        effectivePulls.push({ change: pull, cachedBytes: remoteBytes, cachedMtime: remoteRecord?.mtime })
      }
      if (resolution.action === "merged" && conflict.local && resolution.mergedBytes) {
        deferredLocalApplies.push({ path: conflict.local.path, bytes: resolution.mergedBytes, mtime: this.now() })
      }
      if (resolution.action === "keep-local-copy-remote" && remoteBytes && conflict.remote) {
        const copyPath = this.conflictCopyPath(conflict.remote.path)
        const copyHash = await sha256Hex(remoteBytes)
        const copyFileId = await this.newFileId(copyPath)
        const copyChange: V4PlannedChange = {
          fileId: copyFileId,
          kind: "create",
          path: copyPath,
          after: { path: copyPath, fileId: copyFileId, hash: copyHash, size: remoteBytes.byteLength, mtime: conflict.remote.mtime },
        }
        pullTotal++
        pushTotal++
        effectivePulls.push({ change: copyChange, cachedBytes: remoteBytes, cachedMtime: conflict.remote.mtime })
        pushes.push(copyChange)
      }
      if (localPush) {
        pushTotal++
        pushes.push(localPush)
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

    let pulledFiles = 0
    for (const action of effectivePulls) {
      await this.applyPull(action.change, recordsById, remoteCommitSha, () => {
        pullCompleted++
        this.report({ currentPath: action.change.path, currentDirection: "pull", pull: directional(pullCompleted, pullTotal) })
      }, action.cachedBytes, action.cachedMtime)
      pulledFiles++
    }
    for (const apply of deferredLocalApplies) {
      this.report({
        phase: "applying",
        currentPath: apply.path,
        currentDirection: "push",
        ...counters(true),
      })
      await this.input.vault.write(apply.path, apply.bytes, apply.mtime)
      this.localReadCache.set(apply.path, apply.bytes)
    }

    if (pushes.length === 0 && options.operation !== "forcePush" && !externalReconciled) {
      this.replaceIndex(allRemoteRecords, remote!.head, remote!.commitSha)
      return { mode: options.operation === "forcePull" ? "force-pull" : "pull", operation: options.operation, changedFiles, pushedFiles: 0, pulledFiles }
    }

    const latestLocal = new Map((await this.scanLocal(identityBaseRecords, options.changes ?? [], identitySeedByPath)).map(file => [file.fileId, file]))
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
    const packCandidates: Array<{ record: V4IndexFileRecord; plaintext: Uint8Array; loosePaths: string[] }> = []
    const journalId = `${this.now()}-${toBase64Url(randomBytes(6))}`
    for (const change of pushes) {
      const previous = recordsById.get(change.fileId)
      if (change.kind === "delete") {
        recordsById.delete(change.fileId)
        journalChanges.push({ fileId: change.fileId, kind: "delete", path: change.path, before: previous ? descriptorFor(previous) : undefined })
        continue
      }
      const after = latestLocal.get(change.fileId) ?? change.after
      if (!after) continue
      if (change.kind === "rename"
        && previous
        && after.hash === previous.plaintextSha256
        && this.input.config.mode === "encrypted") {
        const relocated = await this.codec.relocate(previous, after.path)
        const record: V4IndexFileRecord = { ...relocated, path: after.path, mtime: after.mtime }
        recordsById.set(after.fileId, record)
        journalChanges.push({
          fileId: after.fileId,
          kind: change.kind,
          path: after.path,
          previousPath: change.previousPath,
          before: descriptorFor(previous),
          after: descriptorFor(record),
        })
        continue
      }
      const bytes = await this.readLocal(after.path)
      this.report({
        phase: this.input.config.mode === "encrypted" ? "encrypting" : "hashing",
        currentPath: after.path,
        currentDirection: "push",
        push: directional(pushCompleted, pushTotal),
      })
      const prepared = await this.codec.prepare(after.path, bytes, journalId, after.mtime, after.fileId)
      const record: V4IndexFileRecord = { path: after.path, ...prepared.record }
      recordsById.set(after.fileId, record)
      files.push(...prepared.files.map(file => ({
        ...file,
        progressItems: [{ fileId: after.fileId, path: after.path }],
      })))
      if (this.input.config.mode === "encrypted" && record.storage === "single" && bytes.byteLength <= PACK_MAX_ENTRY_BYTES) {
        packCandidates.push({ record, plaintext: bytes, loosePaths: prepared.files.map(file => file.path) })
      }
      journalChanges.push({
        fileId: after.fileId,
        kind: change.kind,
        path: after.path,
        previousPath: change.previousPath,
        before: previous ? descriptorFor(previous) : undefined,
        after: descriptorFor(record),
      })
    }

    if (packCandidates.length >= PACK_MIN_CHANGED_FILES) {
      const loosePaths = new Set<string>()
      for (const candidate of packCandidates) for (const path of candidate.loosePaths) loosePaths.add(path)
      for (let start = 0, packNumber = 0; start < packCandidates.length; packNumber++) {
        const first = packCandidates[start]
        const folder = first.record.path.split("/").slice(0, -1).join("/")
        const group: typeof packCandidates = []
        let bytes = 0
        while (start < packCandidates.length && group.length < PACK_MAX_FILES) {
          const candidate = packCandidates[start]
          const candidateFolder = candidate.record.path.split("/").slice(0, -1).join("/")
          if (group.length > 0 && candidateFolder !== folder) break
          if (group.length > 0 && bytes + candidate.plaintext.byteLength > PACK_MAX_PLAINTEXT_BYTES) break
          group.push(candidate)
          bytes += candidate.plaintext.byteLength
          start++
        }
        const packed = await this.codec.preparePack(`${journalId}-${packNumber}`, group)
        files.push({
          ...packed.file,
          progressItems: group.map(candidate => ({ fileId: candidate.record.fileId, path: candidate.record.path })),
        })
        for (const record of packed.records) {
          recordsById.set(record.fileId, { ...record, path: group.find(item => item.record.fileId === record.fileId)!.record.path })
          const journal = journalChanges.find(change => change.fileId === record.fileId)
          if (journal) journal.after = descriptorFor({ ...record, path: journal.path })
        }
      }
      for (let index = files.length - 1; index >= 0; index--) if (loosePaths.has(files[index].path)) files.splice(index, 1)
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
    const completedPushIds = new Set<string>()
    const completePush = (item: V4GitTreeProgressItem, currentPath = item.path): void => {
      if (completedPushIds.has(item.fileId)) return
      completedPushIds.add(item.fileId)
      pushCompleted++
      this.report({ currentPath, currentDirection: "push", push: directional(pushCompleted, pushTotal) })
    }
    const uploadedPushIds = new Set(files.flatMap(file => (file.progressItems ?? []).map(item => item.fileId)))
    const stagedPushItems: V4GitTreeProgressItem[] = [
      ...pushes.map(change => ({ fileId: change.fileId, path: change.path })),
      ...migrationDeletionPushItems,
    ]
    for (const item of stagedPushItems) {
      if (!uploadedPushIds.has(item.fileId)) completePush(item)
    }
    let latestUploadPath: string | undefined
    const published = await publishV4TreeChanges(this.input.github, {
      message: `obsidian-sync-v4:${journalId}`,
      files,
      deletions: [...deletions],
      expectedHeadSha: ref?.sha ?? null,
      onLogicalFileUploadStarted: item => {
        latestUploadPath = item.path
        this.report({
          phase: "uploading",
          currentPath: item.path,
          currentDirection: "push",
          push: directional(pushCompleted, pushTotal),
        })
      },
      onLogicalFileUploaded: item => completePush(item, latestUploadPath ?? item.path),
      onUploadsComplete: () => this.report({
        phase: "committing",
        currentPath: undefined,
        currentDirection: undefined,
        push: directional(pushCompleted, pushTotal),
      }),
    })
    this.replaceIndex(finalRecords, head, published.commitSha)
    const mode = options.operation === "forcePush" ? "force-push" : pulledFiles > 0 ? "pull-push" : "push"
    return { mode, operation: options.operation, changedFiles, pushedFiles: pushes.length, pulledFiles, commitSha: published.commitSha }
  }

  private async loadRemoteConfig(commitSha: string | undefined, operation: V4SyncOperation): Promise<V4RemoteConfig | null> {
    const configFile = await this.input.github.getFileBytes(V4_CONFIG_PATH, commitSha)
    if (!configFile) return null
    const config = decodeV4RemoteConfig(configFile.bytes)
    if (config.repoId !== this.input.config.repoId) throw new Error("V4 remote repository identity mismatch.")
    assertV4PathLayoutCompatible(config, this.input.config, operation)
    return config
  }

  private async loadRemote(commitSha: string | undefined, config: V4RemoteConfig | null, operation: V4SyncOperation): Promise<V4RemoteState | null> {
    if (!config) return null
    const headFile = await this.input.github.getFileBytes(V4_HEAD_PATH, commitSha)
    if (!headFile) throw new Error("V4 remote head is missing.")
    const head = await decodeV4RemoteHead(headFile.bytes, config, this.input.keyring)
    const records: V4IndexFileRecord[] = []
    for (const bucket of Object.keys(head.shardHashes)) {
      const cached = isV4LocalIndexShardConsistent(this.input.index, bucket, head.shardHashes[bucket])
        ? this.input.index.shards[bucket]
        : undefined
      if (cached) {
        assertV4RemoteShardRecords({ bucket, records: cached.records }, bucket, config)
        records.push(...Object.values(cached.records))
        continue
      }
      const file = await this.input.github.getFileBytes(v4RemoteShardPath(bucket, config.mode), commitSha)
      if (!file) throw new Error(`V4 remote shard is missing: ${bucket}`)
      records.push(...Object.values((await decodeV4RemoteShard(file.bytes, bucket, config, this.input.keyring)).records))
    }
    await assertV4RemoteRecordSet(records, config, this.input.keyring)
    return { config, head, records, commitSha: commitSha ?? "" }
  }

  private remoteFromLocalIndex(commitSha: string, config: V4RemoteConfig): V4RemoteState {
    return {
      config,
      head: {
        formatVersion: 4,
        mode: this.input.index.mode,
        epoch: this.input.index.epoch,
        generation: this.input.index.generation,
        journalId: "",
        shardHashes: { ...this.input.index.shardHashes },
        updatedAt: 0,
        deviceId: this.input.index.deviceId,
      },
      records: recordsFromIndex(this.input.index).map(record => ({ ...record, partPaths: record.partPaths ? [...record.partPaths] : undefined })),
      commitSha,
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

  private async scanLocal(baseRecords: V4IndexFileRecord[], changes: V4QueuedChange[], identitySeedByPath?: ReadonlyMap<string, string>): Promise<V4LogicalFile[]> {
    this.report({ phase: "scanning-local", currentPath: undefined, currentDirection: undefined })
    const pathChanges = changes.filter((change): change is Exclude<V4QueuedChange, { type: "rescan" }> => change.type !== "rescan")
    const hasFolderChange = pathChanges.some(change => change.type === "folderRename" || change.type === "folderDelete")
    if (changes.length > 0 && pathChanges.length === changes.length && !hasFolderChange && baseRecords.length > 0 && this.input.vault.stat) {
      const byPath = new Map(logical(baseRecords).map(file => [file.path, file]))
      for (const change of pathChanges) {
        if (change.type === "delete") { byPath.delete(change.path); continue }
        const previous = change.type === "replace" ? undefined : change.type === "rename" ? byPath.get(change.oldPath) : byPath.get(change.path)
        if (change.type === "replace") { byPath.delete(change.oldPath); byPath.delete(change.path) }
        if (change.type === "rename") byPath.delete(change.oldPath)
        this.report({ phase: "scanning-local", currentPath: change.path, currentDirection: undefined })
        const stat = await this.input.vault.stat(change.path)
        if (!stat) { byPath.delete(change.path); continue }
        this.report({ phase: "hashing", currentPath: change.path, currentDirection: undefined })
        const content = await this.readLocal(change.path)
        byPath.set(change.path, {
          path: change.path,
          fileId: previous?.fileId ?? await this.newFileId(change.path),
          hash: await sha256Hex(content),
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
    const files = await this.input.vault.listFiles()
    return Promise.all(files.map(async file => {
      this.report({ phase: "scanning-local", currentPath: file.path, currentDirection: undefined })
      const existing = identityByPath.get(file.path)
      const unchangedStat = existing && existing.size === file.size && existing.mtime === file.mtime
      if (!unchangedStat) this.report({ phase: "hashing", currentPath: file.path, currentDirection: undefined })
      return {
        path: file.path,
        fileId: identitySeedByPath?.get(file.path) ?? existing?.fileId ?? await this.newFileId(file.path),
        hash: unchangedStat ? existing.plaintextSha256 : await sha256Hex(await this.readLocal(file.path)),
        size: file.size,
        mtime: file.mtime,
      }
    }))
  }

  private async applyPull(
    change: V4PlannedChange,
    records: Map<string, V4IndexFileRecord>,
    remoteCommitSha: string | undefined,
    onCompleted: () => void,
    cachedBytes?: Uint8Array,
    cachedMtime?: number,
  ): Promise<void> {
    if (change.kind === "delete") {
      this.report({ phase: "applying", currentPath: change.path, currentDirection: "pull" })
      await this.input.vault.delete(change.path)
      onCompleted()
      return
    }
    const record = records.get(change.fileId)
    if (!record && cachedBytes === undefined) throw new Error(`Missing V4 remote record for ${change.path}`)
    let bytes = cachedBytes
    if (bytes === undefined) {
      this.report({ phase: "downloading", currentPath: change.path, currentDirection: "pull" })
      bytes = await this.readRecord(record!, remoteCommitSha)
    }
    this.report({ phase: "applying", currentPath: change.path, currentDirection: "pull" })
    if (change.kind === "rename" && change.previousPath) await this.input.vault.delete(change.previousPath)
    await this.input.vault.write(change.path, bytes, cachedMtime ?? record!.mtime)
    this.localReadCache.set(change.path, bytes)
    onCompleted()
  }

  private async readLocal(path: string): Promise<Uint8Array> {
    const cached = this.localReadCache.get(path)
    if (cached) return cached
    const bytes = await this.input.vault.read(path)
    this.localReadCache.set(path, bytes)
    return bytes
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
