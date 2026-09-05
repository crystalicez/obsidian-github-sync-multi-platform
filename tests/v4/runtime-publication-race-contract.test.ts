import assert from "node:assert/strict"
import test from "node:test"
import { TFile } from "obsidian"

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()
  nextRefReadError: unknown
  refReads = 0

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path)
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null
  }
  async getGitRefOrNull() {
    this.refReads++
    if (this.nextRefReadError) {
      const error = this.nextRefReadError
      this.nextRefReadError = undefined
      throw error
    }
    return this.ref
  }
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
    if (expected && this.ref?.sha !== expected) throw Object.assign(new Error("CAS rejected"), { status: 422 })
    await this.createGitRef(sha)
  }
}

class MemoryObsidianVault {
  configDir = ".obsidian"
  readonly bytes = new Map<string, Uint8Array>()
  readonly files = new Map<string, TFile>()

  set(path: string, bytes: Uint8Array, mtime: number): void {
    this.bytes.set(path, new Uint8Array(bytes))
    let file = this.files.get(path)
    if (!file) {
      file = new TFile(path, bytes)
      this.files.set(path, file)
    }
    file.stat = { size: bytes.byteLength, mtime }
  }

  getFiles() { return [...this.files.values()] }
  getAbstractFileByPath(path: string) { return this.files.get(path) ?? null }
  async readBinary(file: TFile) { return new Uint8Array(this.bytes.get(file.path) ?? new Uint8Array()).buffer }
  async modifyBinary(file: TFile, buffer: ArrayBuffer) { this.set(file.path, new Uint8Array(buffer), Date.now()) }
  async createBinary(path: string, buffer: ArrayBuffer) { this.set(path, new Uint8Array(buffer), Date.now()); return this.files.get(path)! }
  async createFolder(_path: string) {}
}

function pluginFixture() {
  const githubClient = new MemoryGitHub()
  const vault = new MemoryObsidianVault()
  const ignoredFiles = new Set<string>()
  const plugin = {
    settings: {
      syncEnabled: true,
      syncOnLocalChange: true,
      githubOwner: "o",
      githubRepo: "r",
      githubBranch: "main",
      encryptionMode: "plaintext",
      encryptionPassphrase: "",
      ignorePathRegex: "",
      syncObsidianConfig: false,
      syncBookmarks: false,
      syncPlugins: false,
      conflictPolicy: "copy",
      abortChangePercent: 0,
      vault: "runtime-race-device",
      consoleLoggingEnabled: false,
    },
    manifest: { id: "runtime-race-test" },
    app: {
      vault,
      fileManager: {
        async trashFile(file: TFile) {
          vault.bytes.delete(file.path)
          vault.files.delete(file.path)
        },
      },
    },
    githubClient,
    ignoredFiles,
    isWatchEnabled: true,
    isSyncInProgress: false,
    addIgnoredFile(path: string) { ignoredFiles.add(path) },
    removeIgnoredFile(path: string) { ignoredFiles.delete(path) },
    enableWatch() { this.isWatchEnabled = true },
  }
  return { plugin, githubClient, vault }
}

async function initializeFixture() {
  const fixture = pluginFixture()
  fixture.vault.set("note.md", new TextEncoder().encode("base\n"), 1)
  const runtime = new V4PluginRuntime(fixture.plugin as never)
  await runtime.forcePush()
  assert.ok(fixture.githubClient.ref?.sha)
  return { ...fixture, runtime }
}

test("runtime does not retry an arbitrary stale-ref message without structured race evidence", async () => {
  const { runtime, githubClient, vault } = await initializeFixture()
  vault.set("note.md", new TextEncoder().encode("changed\n"), 2)
  githubClient.nextRefReadError = new Error("stale ref")
  const attempts: number[] = []
  const unsubscribe = runtime.subscribeProgress(snapshot => attempts.push(snapshot.attempt))

  await runtime.manualSync()
  unsubscribe()

  assert.equal(runtime.progressSnapshot.lifecycle, "failed")
  assert.equal(Math.max(...attempts), 1)
  runtime.dispose()
})

test("runtime retries a structured publication race even when its message has no stale-head wording", async () => {
  const { runtime, githubClient, vault } = await initializeFixture()
  vault.set("note.md", new TextEncoder().encode("changed\n"), 2)
  githubClient.nextRefReadError = Object.assign(new Error("concurrent publication"), {
    code: "V4_PUBLICATION_RACE",
    phase: "pre-publish",
    expectedHeadSha: githubClient.ref!.sha,
    observedHeadSha: "other",
    publicationOutcome: "not-published",
  })
  const attempts: number[] = []
  const unsubscribe = runtime.subscribeProgress(snapshot => attempts.push(snapshot.attempt))

  await runtime.manualSync()
  unsubscribe()

  assert.equal(runtime.progressSnapshot.lifecycle, "success")
  assert.equal(Math.max(...attempts), 2)
  runtime.dispose()
})

test("force operations preserve typed publication-race outer retry compatibility", async () => {
  for (const operation of ["forcePush", "forcePull"] as const) {
    const { runtime, githubClient } = await initializeFixture()
    githubClient.nextRefReadError = Object.assign(new Error(`typed ${operation} race`), {
      code: "V4_PUBLICATION_RACE",
      phase: "pre-publish",
      expectedHeadSha: githubClient.ref!.sha,
      observedHeadSha: `other-${operation}`,
      publicationOutcome: "not-published",
      evidence: "pre-publish-head-mismatch",
    })
    const attempts: number[] = []
    const unsubscribe = runtime.subscribeProgress(snapshot => attempts.push(snapshot.attempt))

    await runtime[operation]()
    unsubscribe()

    assert.equal(runtime.progressSnapshot.lifecycle, "success", operation)
    assert.equal(Math.max(...attempts), 2, operation)
    runtime.dispose()
  }
})

test("terminal publication race log retains structured attempt and Git evidence", async () => {
  const { runtime, githubClient, vault, plugin } = await initializeFixture()
  vault.set("note.md", new TextEncoder().encode("changed\n"), 2)
  plugin.settings.consoleLoggingEnabled = true
  const expectedHeadSha = githubClient.ref!.sha
  const originalGetRef = githubClient.getGitRefOrNull.bind(githubClient)
  let racesRemaining = 3
  githubClient.getGitRefOrNull = async () => {
    if (racesRemaining-- > 0) {
      throw Object.assign(new Error("typed race without stale wording"), {
        code: "V4_PUBLICATION_RACE",
        phase: "pre-publish",
        expectedHeadSha,
        observedHeadSha: `other-${3 - racesRemaining}`,
        publicationOutcome: "not-published",
        evidence: "pre-publish-head-mismatch",
      })
    }
    return originalGetRef()
  }
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    await runtime.manualSync()
  } finally {
    console.warn = originalWarn
  }

  const failure = warnings.find(args => args[1] === "V4 sync failed")
  assert.ok(failure)
  const details = failure[2] as Record<string, unknown>
  assert.equal(details.attempt, 3)
  assert.equal(details.publicationPhase, "pre-publish")
  assert.equal(details.expectedHeadSha, expectedHeadSha)
  assert.equal(details.observedHeadSha, "other-3")
  assert.equal(details.publicationOutcome, "not-published")
  assert.equal(details.publicationEvidence, "pre-publish-head-mismatch")
  assert.deepEqual(details.publicationCause, undefined)
  assert.equal(runtime.progressSnapshot.lifecycle, "failed")
  runtime.dispose()
})
