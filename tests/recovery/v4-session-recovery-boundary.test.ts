import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"
import { createEmptyV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import { createV4RecoveryStore } from "../../src/lib/v4/recovery-store"
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session"
import type { V4StageRef, V4StagedSink, V4StagingStore } from "../../src/lib/v4/staging-store"

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

class RecoveryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  constructor(private readonly events: string[]) {}
  async read(path: string) { return this.values.get(path)! }
  async write(path: string, value: string) {
    this.values.set(path, value)
    const parsed = JSON.parse(value) as { phase?: string; candidateCommitSha?: string; journalId?: string }
    this.events.push(`recovery:${parsed.phase}:${parsed.candidateCommitSha ?? ""}:${parsed.journalId ?? ""}`)
  }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

class MemoryStaging implements V4StagingStore {
  readonly stages = new Map<string, Uint8Array>()
  private next = 0
  pathFor(stageId: string) { return `stage/${stageId}.bin` }
  async beginStage(options: { expectedSize: number; mtime: number }): Promise<V4StagedSink> {
    const stageId = `s${++this.next}`
    const chunks: Uint8Array[] = []
    return {
      append: async bytes => { chunks.push(new Uint8Array(bytes)) },
      finish: async result => {
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        assert.equal(bytes.byteLength, options.expectedSize)
        this.stages.set(stageId, bytes)
        return { stageId, hash: result.plaintextSha256, size: result.size, mtime: options.mtime }
      },
      abort: async () => { this.stages.delete(stageId) },
    }
  }
  async stageSource(): Promise<never> { throw new Error("not used") }
  async open(ref: Pick<V4StageRef, "stageId" | "size">) { return createV4WholeBufferContentSource(this.stages.get(ref.stageId)!) }
  async remove(ref: Pick<V4StageRef, "stageId">) { this.stages.delete(ref.stageId) }
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  readonly staging = new MemoryStaging()
  constructor(private readonly events: string[] = []) {}
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })) }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null }
  async read(path: string) { return new Uint8Array(this.files.get(path)!.bytes) }
  async write(path: string, bytes: Uint8Array, mtime = 0) { this.events.push(`vault-write:${path}`); this.files.set(path, { bytes: new Uint8Array(bytes), mtime }) }
  async trash(path: string) { this.events.push(`vault-trash:${path}`); this.files.delete(path) }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()
  constructor(private readonly events: string[] = []) {}
  async getGitRefOrNull() { return this.ref }
  async ensureGitRepositoryInitialized() { return null }
  async getFileBytes(path: string, ref?: string) {
    const tree = ref ? this.trees.get(this.commits.get(ref)!.treeSha) : undefined
    const bytes = tree?.get(path) ?? this.files.get(path)
    return bytes ? { bytes: new Uint8Array(bytes), sha: `sha-${path}` } : null
  }
  async getGitCommit(sha: string) { const c = this.commits.get(sha)!; return { sha, treeSha: c.treeSha, parentShas: c.parents, message: c.message } }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined)
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!))
    const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`
    this.commits.set(sha, { treeSha, parents, message })
    this.events.push(`commit:${sha}`)
    return sha
  }
  async createGitRef(sha: string) { this.events.push(`ref:${sha}`); this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)) }
  async updateGitRef(sha: string, expected?: string) { assert.equal(this.ref?.sha, expected); await this.createGitRef(sha) }
}

const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "owner/repo#main", pathLayout: "plaintext-v1" }

async function seedRemote(github: MemoryGitHub) {
  const vault = new MemoryVault()
  vault.files.set("remote.md", { bytes: encode("remote-body"), mtime: 10 })
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "seed", mode: "plaintext" })
  await new V4SyncSession({ github, vault, index, config, conflictPolicy: "copy", abortChangePercent: 0, now: (() => { let n = 100; return () => ++n })() }).sync({ operation: "forcePush" })
}

test("normal publication persists exact candidate publish-intent before mutating the ref", async () => {
  const events: string[] = []
  const github = new MemoryGitHub(events)
  const vault = new MemoryVault(events)
  vault.files.set("local.md", { bytes: encode("body"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "device", mode: "plaintext" })
  const adapter = new RecoveryAdapter(events)
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId })
  const runState = { runId: "run-stable", conflictCopies: new Map() }
  await new V4SyncSession({ github, vault, index, config, conflictPolicy: "copy", abortChangePercent: 0, recoveryStore, runState } as never).sync({ operation: "forcePush" })

  const commitEvent = events.findIndex(event => event.startsWith("commit:commit-"))
  const intentEvent = events.findIndex(event => event.startsWith("recovery:publish-intent:commit-"))
  const refEvent = events.findIndex(event => event.startsWith("ref:commit-"))
  const verifiedEvent = events.findIndex(event => event.startsWith("recovery:remote-verified:commit-"))
  assert.ok(commitEvent >= 0 && intentEvent > commitEvent && refEvent > intentEvent && verifiedEvent > refEvent, events.join("\n"))
  const latest = await recoveryStore.load()
  assert.equal(latest?.header.runId, "run-stable")
  assert.ok(latest?.header.journalId)
  assert.equal(latest?.header.candidateCommitSha, github.ref?.sha)
})

test("pure pull persists remote-verified without journalId before the first final vault mutation", async () => {
  const github = new MemoryGitHub()
  await seedRemote(github)
  const events: string[] = []
  const vault = new MemoryVault(events)
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "pull-device", mode: "plaintext" })
  const adapter = new RecoveryAdapter(events)
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId })
  const runState = { runId: "pull-run", conflictCopies: new Map() }
  await new V4SyncSession({ github, vault, index, config, conflictPolicy: "copy", abortChangePercent: 0, recoveryStore, runState } as never).sync({ operation: "forcePull" })

  const verified = events.findIndex(event => event.startsWith("recovery:remote-verified:"))
  const write = events.findIndex(event => event === "vault-write:remote.md")
  assert.ok(verified >= 0 && write > verified, events.join("\n"))
  const latest = await recoveryStore.load()
  assert.equal(latest?.header.runId, "pull-run")
  assert.equal(latest?.header.journalId, undefined)
  assert.equal(latest?.header.verifiedRemoteHead, github.ref?.sha)
  assert.equal(decode(vault.files.get("remote.md")!.bytes), "remote-body")
})
