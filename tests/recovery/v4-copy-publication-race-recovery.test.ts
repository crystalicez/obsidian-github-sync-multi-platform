import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"
import { createEmptyV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { isV4PublicationRaceError } from "../../src/lib/v4/publication-race"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import {
  createV4RecoveryStore,
  discardV4RecoveryStages,
  markV4RecoveryIndexCommitted,
  recoverV4PendingState,
} from "../../src/lib/v4/recovery-store"
import { createV4StagingStore, type V4StagingStore } from "../../src/lib/v4/staging-store"
import { V4SyncSession, type V4SessionVault, type V4SyncRunState } from "../../src/lib/v4/sync-session"

const enc = (value: string) => new TextEncoder().encode(value)

class MemoryRecoveryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  async read(path: string) { return this.values.get(path)! }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

function memoryStaging(): V4StagingStore {
  const files = new Map<string, Uint8Array>()
  return createV4StagingStore({
    root: "stage",
    wholeBufferCeilingBytes: 1024 * 1024,
    randomId: (() => { let id = 0; return () => `stage${++id}` })(),
    backend: {
      boundedAppend: true,
      async write(path, bytes) { files.set(path, new Uint8Array(bytes)) },
      async append(path, bytes) {
        const before = files.get(path) ?? new Uint8Array()
        const joined = new Uint8Array(before.byteLength + bytes.byteLength)
        joined.set(before)
        joined.set(bytes, before.byteLength)
        files.set(path, joined)
      },
      async remove(path) { files.delete(path) },
      async openSource(path, size) {
        const bytes = files.get(path)
        if (!bytes || bytes.byteLength !== size) throw new Error(`Missing stage ${path}`)
        return createV4WholeBufferContentSource(new Uint8Array(bytes))
      },
      async freeBytes() { return Number.MAX_SAFE_INTEGER },
    },
  })
}

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  readonly staging = memoryStaging()

  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })) }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null }
  async read(path: string) {
    const file = this.files.get(path)
    if (!file) throw new Error(`Missing ${path}`)
    return new Uint8Array(file.bytes)
  }
  async write(path: string, bytes: Uint8Array, mtime = Date.now()) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime }) }
  async trash(path: string) { this.files.delete(path) }
}

class RacingMemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()
  beforeNextUpdate?: () => Promise<void>

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path)
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null
  }
  async getGitRefOrNull() { return this.ref }
  async ensureGitRepositoryInitialized() { return null }
  async getGitCommit(sha: string) {
    const value = this.commits.get(sha)
    if (!value) throw new Error(`Missing commit ${sha}`)
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }
  }
  async getTreeAt(treeSha: string) {
    const tree = this.trees.get(treeSha) ?? new Map<string, Uint8Array>()
    return {
      sha: treeSha,
      url: "",
      truncated: false,
      tree: [...tree.entries()].map(([path, bytes], index) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: `tree-blob-${index}`,
        size: bytes.byteLength,
        url: "",
      })),
    }
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`
    this.blobs.set(sha, new Uint8Array(bytes))
    return sha
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined)
    for (const entry of entries) {
      if (entry.sha === null) tree.delete(entry.path)
      else tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!))
    }
    const sha = `tree-${this.trees.size + 1}`
    this.trees.set(sha, tree)
    return sha
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`
    this.commits.set(sha, { treeSha, parents, message })
    return sha
  }
  async createGitRef(sha: string) {
    this.ref = { ref: "refs/heads/main", sha, type: "commit" }
    this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha))
  }
  async updateGitRef(sha: string, expected?: string) {
    const hook = this.beforeNextUpdate
    this.beforeNextUpdate = undefined
    if (hook) await hook()
    if (expected && this.ref?.sha !== expected) {
      throw Object.assign(new Error("competing ref update"), { status: 422 })
    }
    await this.createGitRef(sha)
  }
}

const config: V4RemoteConfig = {
  formatVersion: V4_FORMAT_VERSION,
  mode: "plaintext",
  repoId: "owner/repo#main",
  pathLayout: "plaintext-v1",
}

function session(input: {
  github: RacingMemoryGitHub
  vault: MemoryVault
  index: V4LocalIndex
  runState?: V4SyncRunState
  recoveryStore?: ReturnType<typeof createV4RecoveryStore>
  now?: () => number
}) {
  return new V4SyncSession({
    github: input.github,
    vault: input.vault,
    index: input.index,
    config,
    conflictPolicy: "copy",
    abortChangePercent: 0,
    runState: input.runState,
    recoveryStore: input.recoveryStore,
    now: input.now,
  })
}

function cloneVault(source: MemoryVault): MemoryVault {
  const target = new MemoryVault()
  target.files = new Map([...source.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]))
  return target
}

function liveRecords(index: V4LocalIndex) {
  return Object.values(index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted)
}

function recordAt(index: V4LocalIndex, path: string) {
  const record = liveRecords(index).find(candidate => candidate.path === path)
  assert.ok(record, `missing record ${path}`)
  return record
}

async function freshPull(github: RacingMemoryGitHub) {
  const vault = new MemoryVault()
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "fresh", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session({ github, vault, index }).sync({ operation: "forcePull", allowThresholdOverride: false })
  return { vault, index }
}

test("Copy conflict survives a publication race/replan exactly once with stable identity and committed recovery", async () => {
  const github = new RacingMemoryGitHub()
  const remoteVault = new MemoryVault()
  remoteVault.files.set("shared.md", { bytes: enc("base\n"), mtime: 1 })
  const remoteIndex = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "remote", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session({ github, vault: remoteVault, index: remoteIndex }).sync({ operation: "forcePush", allowThresholdOverride: false })

  const localVault = cloneVault(remoteVault)
  const localIndex = structuredClone(remoteIndex)
  localIndex.deviceId = "local"
  const originalFileId = recordAt(localIndex, "shared.md").fileId

  remoteVault.files.set("shared.md", { bytes: enc("remote-competitor\n"), mtime: 2 })
  await session({ github, vault: remoteVault, index: remoteIndex }).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "modify", path: "shared.md", mtime: 2 }],
  })

  localVault.files.set("shared.md", { bytes: enc("local-canonical\n"), mtime: 3 })
  const adapter = new MemoryRecoveryAdapter()
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId })
  const runState: V4SyncRunState = { runId: "copy-race-run", conflictCopies: new Map(), conflictCopyStages: new Map() }
  const now = () => 515151

  github.beforeNextUpdate = async () => {
    remoteVault.files.set("winner.md", { bytes: enc("winner\n"), mtime: 4 })
    await session({ github, vault: remoteVault, index: remoteIndex }).sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "winner.md", mtime: 4 }],
    })
  }

  let attempts = 0
  let reservedPathAfterRace: string | undefined
  let reservedFileIdAfterRace: string | undefined
  let reservedStageIdAfterRace: string | undefined
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt
    try {
      await session({ github, vault: localVault, index: localIndex, runState, recoveryStore, now }).sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "modify", path: "shared.md", mtime: 3 }],
      })
      break
    } catch (error) {
      assert.equal(attempt, 1)
      assert.equal(isV4PublicationRaceError(error), true)
      const reservation = runState.conflictCopies.get(originalFileId)
      assert.ok(reservation)
      const stage = runState.conflictCopyStages?.get(reservation.fileId)
      assert.ok(stage)
      reservedPathAfterRace = reservation.path
      reservedFileIdAfterRace = reservation.fileId
      reservedStageIdAfterRace = stage.stage.stageId

      const pending = await recoveryStore.load()
      assert.equal(pending?.header.phase, "publish-intent")
      assert.equal(pending?.header.runId, "copy-race-run")
      const currentHead = (await github.getGitRefOrNull())?.sha ?? null
      const recovered = await recoverV4PendingState({
        store: recoveryStore,
        snapshot: pending!,
        io: localVault,
        currentRemoteHead: currentHead,
        publicationGithub: github,
      })
      assert.equal(recovered.replanRequired, true)
      assert.equal(recovered.snapshot.header.phase, "replan-required")
      assert.equal(recovered.snapshot.header.verifiedRemoteHead, undefined)
      const keepStageIds = new Set([...runState.conflictCopyStages?.values() ?? []].map(copy => copy.stage.stageId))
      await discardV4RecoveryStages(recovered.snapshot, localVault, keepStageIds)
    }
  }

  assert.equal(attempts, 2)
  const reservation = runState.conflictCopies.get(originalFileId)
  assert.ok(reservation)
  assert.equal(reservation.path, reservedPathAfterRace)
  assert.equal(reservation.fileId, reservedFileIdAfterRace)
  assert.equal(runState.conflictCopyStages?.get(reservation.fileId)?.stage.stageId, reservedStageIdAfterRace)

  const copyPath = "shared.conflict-remote-local-515151.md"
  assert.equal(reservation.path, copyPath)
  assert.deepEqual([...localVault.files.keys()].sort(), [copyPath, "shared.md", "winner.md"])
  assert.deepEqual(localVault.files.get("shared.md")?.bytes, enc("local-canonical\n"))
  assert.deepEqual(localVault.files.get(copyPath)?.bytes, enc("remote-competitor\n"))
  assert.deepEqual(localVault.files.get("winner.md")?.bytes, enc("winner\n"))
  assert.equal(recordAt(localIndex, "shared.md").fileId, originalFileId)
  assert.equal(recordAt(localIndex, copyPath).fileId, reservation.fileId)
  assert.equal(liveRecords(localIndex).filter(record => record.path === copyPath).length, 1)
  assert.equal(localIndex.remoteCommitSha, github.ref?.sha)

  await markV4RecoveryIndexCommitted(recoveryStore, "copy-race-run")
  const terminal = await recoveryStore.load()
  assert.equal(terminal?.header.phase, "index-committed")
  assert.equal(terminal?.header.runId, "copy-race-run")

  const fresh = await freshPull(github)
  assert.deepEqual([...fresh.vault.files.keys()].sort(), [...localVault.files.keys()].sort())
  assert.deepEqual(fresh.vault.files.get("shared.md")?.bytes, enc("local-canonical\n"))
  assert.deepEqual(fresh.vault.files.get(copyPath)?.bytes, enc("remote-competitor\n"))
  assert.equal(recordAt(fresh.index, "shared.md").fileId, originalFileId)
  assert.equal(recordAt(fresh.index, copyPath).fileId, reservation.fileId)
})
