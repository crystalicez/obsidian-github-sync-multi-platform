import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session"

const enc = (value: string) => new TextEncoder().encode(value)

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  operations: string[] = []

  async listFiles() {
    return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime }))
  }
  async stat(path: string) {
    const file = this.files.get(path)
    return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null
  }
  async read(path: string) {
    const file = this.files.get(path)
    if (!file) throw new Error(`Missing local file: ${path}`)
    return new Uint8Array(file.bytes)
  }
  async write(path: string, bytes: Uint8Array, mtime?: number) {
    this.operations.push(`write:${path}`)
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() })
  }
  async trash(path: string) {
    this.operations.push(`trash:${path}`)
    this.files.delete(path)
  }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()

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
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref")
    await this.createGitRef(sha)
  }
}

function config(): V4RemoteConfig {
  return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" }
}

function liveRecords(index: V4LocalIndex) {
  return Object.values(index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted)
}

function recordAt(index: V4LocalIndex, path: string) {
  const record = liveRecords(index).find(candidate => candidate.path === path)
  assert.ok(record, `missing record ${path}`)
  return record
}

function cloneVault(source: MemoryVault): MemoryVault {
  const target = new MemoryVault()
  target.files = new Map([...source.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]))
  return target
}

function session(github: MemoryGitHub, vault: MemoryVault, index: V4LocalIndex, now = () => 515151) {
  return new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0, now })
}

async function folderFixture() {
  const github = new MemoryGitHub()
  const remoteVault = new MemoryVault()
  remoteVault.files.set("folder/edited.md", { bytes: enc("edited-base\n"), mtime: 1 })
  remoteVault.files.set("folder/untouched.md", { bytes: enc("untouched-base\n"), mtime: 1 })
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session(github, remoteVault, remoteIndex).sync({ operation: "forcePush", allowThresholdOverride: false })

  const localVault = cloneVault(remoteVault)
  const localIndex = structuredClone(remoteIndex)
  localIndex.deviceId = "local"
  return {
    github,
    remoteVault,
    remoteIndex,
    localVault,
    localIndex,
    editedFileId: recordAt(remoteIndex, "folder/edited.md").fileId,
    untouchedFileId: recordAt(remoteIndex, "folder/untouched.md").fileId,
  }
}

async function freshPull(github: MemoryGitHub): Promise<{ vault: MemoryVault; index: V4LocalIndex }> {
  const vault = new MemoryVault()
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "fresh", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session(github, vault, index).sync({ operation: "forcePull", allowThresholdOverride: false })
  return { vault, index }
}

function sortedPaths(vault: MemoryVault): string[] {
  return [...vault.files.keys()].sort()
}

function conflictCopies(vault: MemoryVault): string[] {
  return sortedPaths(vault).filter(path => path.includes(".conflict-remote-"))
}

test("remote folder rename versus stale edited descendant keeps edited lineage canonical and moves untouched sibling", async () => {
  const fixture = await folderFixture()
  fixture.remoteVault.files.delete("folder/edited.md")
  fixture.remoteVault.files.delete("folder/untouched.md")
  fixture.remoteVault.files.set("moved/edited.md", { bytes: enc("edited-base\n"), mtime: 2 })
  fixture.remoteVault.files.set("moved/untouched.md", { bytes: enc("untouched-base\n"), mtime: 2 })
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderRename", oldPath: "folder", path: "moved", mtime: 2 }],
  })

  fixture.localVault.files.set("folder/edited.md", { bytes: enc("stale-local-edit\n"), mtime: 3 })
  await session(fixture.github, fixture.localVault, fixture.localIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "modify", path: "folder/edited.md", mtime: 3 }],
  })

  const copyPath = "moved/edited.conflict-remote-local-515151.md"
  assert.deepEqual(sortedPaths(fixture.localVault), ["folder/edited.md", copyPath, "moved/untouched.md"].sort())
  assert.deepEqual(fixture.localVault.files.get("folder/edited.md")?.bytes, enc("stale-local-edit\n"))
  assert.deepEqual(fixture.localVault.files.get(copyPath)?.bytes, enc("edited-base\n"))
  assert.deepEqual(fixture.localVault.files.get("moved/untouched.md")?.bytes, enc("untouched-base\n"))
  assert.equal(recordAt(fixture.localIndex, "folder/edited.md").fileId, fixture.editedFileId)
  assert.equal(recordAt(fixture.localIndex, "moved/untouched.md").fileId, fixture.untouchedFileId)
  assert.notEqual(recordAt(fixture.localIndex, copyPath).fileId, fixture.editedFileId)
  assert.deepEqual(conflictCopies(fixture.localVault), [copyPath])

  const fresh = await freshPull(fixture.github)
  assert.deepEqual(sortedPaths(fresh.vault), sortedPaths(fixture.localVault))
  assert.equal(recordAt(fresh.index, "folder/edited.md").fileId, fixture.editedFileId)
  assert.equal(recordAt(fresh.index, "moved/untouched.md").fileId, fixture.untouchedFileId)
  assert.equal(recordAt(fresh.index, copyPath).fileId, recordAt(fixture.localIndex, copyPath).fileId)
})

test("remote folder delete versus stale edited descendant preserves edited file and deletes untouched sibling", async () => {
  const fixture = await folderFixture()
  fixture.remoteVault.files.clear()
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderDelete", path: "folder", mtime: 2 }],
  })

  fixture.localVault.files.set("folder/edited.md", { bytes: enc("stale-local-edit\n"), mtime: 3 })
  await session(fixture.github, fixture.localVault, fixture.localIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "modify", path: "folder/edited.md", mtime: 3 }],
  })

  assert.deepEqual(sortedPaths(fixture.localVault), ["folder/edited.md"])
  assert.deepEqual(fixture.localVault.files.get("folder/edited.md")?.bytes, enc("stale-local-edit\n"))
  assert.equal(recordAt(fixture.localIndex, "folder/edited.md").fileId, fixture.editedFileId)
  assert.deepEqual(conflictCopies(fixture.localVault), [])
  assert.equal(liveRecords(fixture.localIndex).some(record => record.fileId === fixture.untouchedFileId), false)

  const fresh = await freshPull(fixture.github)
  assert.deepEqual(sortedPaths(fresh.vault), ["folder/edited.md"])
  assert.equal(recordAt(fresh.index, "folder/edited.md").fileId, fixture.editedFileId)
})

test("remote folder delete versus stale delete-recreate descendant keeps recreated identity new", async () => {
  const fixture = await folderFixture()
  fixture.remoteVault.files.clear()
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderDelete", path: "folder", mtime: 2 }],
  })

  fixture.localVault.files.delete("folder/edited.md")
  fixture.localVault.files.set("folder/edited.md", { bytes: enc("recreated-local\n"), mtime: 4 })
  await session(fixture.github, fixture.localVault, fixture.localIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [
      { type: "delete", path: "folder/edited.md", mtime: 3 },
      { type: "modify", path: "folder/edited.md", mtime: 4 },
    ],
  })

  assert.deepEqual(sortedPaths(fixture.localVault), ["folder/edited.md"])
  assert.deepEqual(fixture.localVault.files.get("folder/edited.md")?.bytes, enc("recreated-local\n"))
  assert.notEqual(recordAt(fixture.localIndex, "folder/edited.md").fileId, fixture.editedFileId)
  assert.equal(liveRecords(fixture.localIndex).some(record => record.fileId === fixture.editedFileId), false)
  assert.equal(liveRecords(fixture.localIndex).some(record => record.fileId === fixture.untouchedFileId), false)
  assert.deepEqual(conflictCopies(fixture.localVault), [])

  const fresh = await freshPull(fixture.github)
  assert.deepEqual(sortedPaths(fresh.vault), ["folder/edited.md"])
  assert.equal(recordAt(fresh.index, "folder/edited.md").fileId, recordAt(fixture.localIndex, "folder/edited.md").fileId)
})

test("nested folder rename chain reaches only the final folder while preserving stale conflict semantics", async () => {
  const fixture = await folderFixture()
  fixture.remoteVault.files.clear()
  fixture.remoteVault.files.set("final/edited.md", { bytes: enc("edited-base\n"), mtime: 3 })
  fixture.remoteVault.files.set("final/untouched.md", { bytes: enc("untouched-base\n"), mtime: 3 })
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [
      { type: "folderRename", oldPath: "folder", path: "middle", mtime: 2 },
      { type: "folderRename", oldPath: "middle", path: "final", mtime: 3 },
    ],
  })

  fixture.localVault.files.set("folder/edited.md", { bytes: enc("stale-local-edit\n"), mtime: 4 })
  await session(fixture.github, fixture.localVault, fixture.localIndex).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "modify", path: "folder/edited.md", mtime: 4 }],
  })

  const copyPath = "final/edited.conflict-remote-local-515151.md"
  assert.deepEqual(sortedPaths(fixture.localVault), ["final/untouched.md", "folder/edited.md", copyPath].sort())
  assert.equal(sortedPaths(fixture.localVault).some(path => path.startsWith("middle/")), false)
  assert.equal(recordAt(fixture.localIndex, "folder/edited.md").fileId, fixture.editedFileId)
  assert.equal(recordAt(fixture.localIndex, "final/untouched.md").fileId, fixture.untouchedFileId)
  assert.deepEqual(conflictCopies(fixture.localVault), [copyPath])

  const fresh = await freshPull(fixture.github)
  assert.deepEqual(sortedPaths(fresh.vault), sortedPaths(fixture.localVault))
  assert.equal(sortedPaths(fresh.vault).some(path => path.startsWith("middle/")), false)
})

test("case-only folder rename preserves descendant identities without conflict copies", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  vault.files.set("Folder/a.md", { bytes: enc("a\n"), mtime: 1 })
  vault.files.set("Folder/b.md", { bytes: enc("b\n"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "case", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session(github, vault, index).sync({ operation: "forcePush", allowThresholdOverride: false })
  const aId = recordAt(index, "Folder/a.md").fileId
  const bId = recordAt(index, "Folder/b.md").fileId

  vault.files.delete("Folder/a.md")
  vault.files.delete("Folder/b.md")
  vault.files.set("folder/a.md", { bytes: enc("a\n"), mtime: 2 })
  vault.files.set("folder/b.md", { bytes: enc("b\n"), mtime: 2 })
  await session(github, vault, index).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderRename", oldPath: "Folder", path: "folder", mtime: 2 }],
  })

  assert.deepEqual(sortedPaths(vault), ["folder/a.md", "folder/b.md"])
  assert.equal(recordAt(index, "folder/a.md").fileId, aId)
  assert.equal(recordAt(index, "folder/b.md").fileId, bId)
  assert.deepEqual(conflictCopies(vault), [])

  const fresh = await freshPull(github)
  assert.deepEqual(sortedPaths(fresh.vault), sortedPaths(vault))
  assert.equal(recordAt(fresh.index, "folder/a.md").fileId, aId)
  assert.equal(recordAt(fresh.index, "folder/b.md").fileId, bId)
})

test("folder rename into an NFC/case-equivalent namespace fails before remote mutation", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  vault.files.set("folder/café.md", { bytes: enc("primary\n"), mtime: 1 })
  vault.files.set("spare/café.md", { bytes: enc("different identity\n"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "collision", mode: "plaintext", pathLayout: "plaintext-v1" })
  await session(github, vault, index).sync({ operation: "forcePush", allowThresholdOverride: false })
  const headBefore = github.ref?.sha

  const moved = vault.files.get("spare/café.md")!
  vault.files.delete("spare/café.md")
  vault.files.set("FOLDER/CAFÉ.md", { bytes: new Uint8Array(moved.bytes), mtime: 2 })

  await assert.rejects(
    session(github, vault, index).sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "folderRename", oldPath: "spare", path: "FOLDER", mtime: 2 }],
    }),
    /V4 path collision/iu,
  )

  assert.equal(github.ref?.sha, headBefore)
  assert.deepEqual(conflictCopies(vault), [])
  assert.deepEqual(sortedPaths(vault), ["FOLDER/CAFÉ.md", "folder/café.md"].sort())
})
