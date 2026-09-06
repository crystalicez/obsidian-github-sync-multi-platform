import assert from "node:assert/strict"
import test from "node:test"
import { TFile } from "obsidian"

import { toBase64Url } from "../../src/lib/bytes"
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session"

const enc = (value: string) => new TextEncoder().encode(value)

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  hiddenRef: { ref: string; sha: string; type: string } | null = null
  revealAtRefRead: number | undefined
  refReads = 0
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path)
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null
  }

  async getGitRefOrNull() {
    this.refReads++
    if (!this.ref && this.hiddenRef && this.refReads === this.revealAtRefRead) this.ref = this.hiddenRef
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

class MemorySessionVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>()
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

function runtimeFixture(githubClient: MemoryGitHub, bytes: Uint8Array) {
  const vault = new MemoryObsidianVault()
  vault.set("secret.md", bytes, 7)
  const ignoredFiles = new Set<string>()
  const plugin = {
    settings: {
      syncEnabled: true,
      syncOnLocalChange: true,
      githubOwner: "o",
      githubRepo: "r",
      githubBranch: "main",
      encryptionMode: "encrypted",
      encryptionPassphrase: "winner-passphrase",
      ignorePathRegex: "",
      syncObsidianConfig: false,
      syncBookmarks: false,
      syncPlugins: false,
      conflictPolicy: "copy",
      abortChangePercent: 0,
      vault: "encrypted-loser",
      consoleLoggingEnabled: false,
    },
    manifest: { id: "runtime-encrypted-winner-test" },
    app: {
      vault,
      fileManager: { async trashFile(file: TFile) { vault.bytes.delete(file.path); vault.files.delete(file.path) } },
    },
    githubClient,
    ignoredFiles,
    isWatchEnabled: true,
    isSyncInProgress: false,
    addIgnoredFile(path: string) { ignoredFiles.add(path) },
    removeIgnoredFile(path: string) { ignoredFiles.delete(path) },
    enableWatch() { this.isWatchEnabled = true },
  }
  return { plugin, vault }
}

function bufferBytes(value: BufferSource): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

test("encrypted speculative bootstrap retries with the winner KDF salt before decrypting remote state", async () => {
  const repoId = "o/r#main"
  const passphrase = "winner-passphrase"
  const winnerSalt = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)
  const winnerConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId,
    pathLayout: expectedV4PathLayout("encrypted"),
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1_000, salt: toBase64Url(winnerSalt) },
  }
  const winnerKeyring = await deriveV4Keyring({ passphrase, repoId, salt: winnerSalt, iterations: 1_000 })
  const github = new MemoryGitHub()
  const winnerVault = new MemorySessionVault()
  const secret = enc("encrypted winner state\n")
  winnerVault.files.set("secret.md", { bytes: secret, mtime: 7 })
  const winnerIndex = createEmptyV4LocalIndex({
    repoId,
    deviceId: "winner",
    mode: "encrypted",
    pathLayout: expectedV4PathLayout("encrypted"),
  })
  await new V4SyncSession({
    github,
    vault: winnerVault,
    index: winnerIndex,
    config: winnerConfig,
    keyring: winnerKeyring,
    conflictPolicy: "copy",
    abortChangePercent: 0,
  }).sync({ operation: "forcePush", allowThresholdOverride: false })

  assert.ok(github.ref)
  github.hiddenRef = github.ref
  github.ref = null
  github.refReads = 0
  github.revealAtRefRead = 3

  const observedKdfSalts: Uint8Array[] = []
  const originalDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle)
  crypto.subtle.deriveBits = (async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
    const algorithm = args[0] as { name?: string; salt?: BufferSource }
    if (algorithm.name === "PBKDF2" && algorithm.salt) observedKdfSalts.push(new Uint8Array(bufferBytes(algorithm.salt)))
    return originalDeriveBits(...args)
  }) as typeof crypto.subtle.deriveBits

  const { plugin, vault } = runtimeFixture(github, secret)
  const runtime = new V4PluginRuntime(plugin as never)
  const attempts: number[] = []
  const unsubscribe = runtime.subscribeProgress(snapshot => attempts.push(snapshot.attempt))
  try {
    await runtime.manualSync()
  } finally {
    unsubscribe()
    crypto.subtle.deriveBits = originalDeriveBits as typeof crypto.subtle.deriveBits
  }

  assert.equal(runtime.progressSnapshot.attempt, 2)
  assert.equal(Math.max(...attempts), 2)
  assert.ok(observedKdfSalts.length >= 3, "expected speculative keyring, bootstrap recovery key, and winner keyring derivations")
  assert.notDeepEqual(observedKdfSalts[0], winnerSalt, "attempt 1 must use a distinct speculative KDF salt")
  assert.equal(observedKdfSalts.some(salt => Buffer.from(salt).equals(Buffer.from(winnerSalt))), true, "attempt 2 must derive from the winner KDF salt")
  assert.deepEqual(vault.bytes.get("secret.md"), secret)
  assert.equal(github.ref?.sha, github.hiddenRef?.sha)
  runtime.dispose()
})
