import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubTree } from "../../src/lib/github-api"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, V4_HEAD_PATH, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types"
import { V4SyncSession } from "../../src/lib/v4/sync-session"

function config(): V4RemoteConfig {
  return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" }
}

test("plugin publication tree verification bounds non-recursive Git tree reads", async () => {
  const directoryCount = 3_000
  const transportReadLimit = 4_200
  let treeReads = 0

  const github = {
    async getTreeAt(treeSha: string): Promise<GitHubTree> {
      treeReads++
      if (treeReads > transportReadLimit) {
        throw new Error("test transport tree read budget exceeded")
      }
      if (treeSha === "before-root" || treeSha === "after-root") {
        const side = treeSha.startsWith("before") ? "before" : "after"
        return {
          sha: treeSha,
          url: "",
          truncated: false,
          tree: Array.from({ length: directoryCount }, (_, index) => ({
            path: `dir-${index.toString().padStart(4, "0")}`,
            mode: "040000",
            type: "tree" as const,
            sha: `${side}-tree-${index}`,
            url: "",
          })),
        }
      }
      return { sha: treeSha, url: "", truncated: false, tree: [] }
    },
  }

  const session = new V4SyncSession({
    github: github as never,
    vault: {} as never,
    index: createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "local", mode: "plaintext" }),
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
  }) as unknown as {
    changedGitTreeLeaves(beforeTreeSha: string | undefined, afterTreeSha: string | undefined, prefix?: string): Promise<unknown[]>
  }

  await assert.rejects(
    () => session.changedGitTreeLeaves("before-root", "after-root"),
    /publication.*tree.*(?:budget|limit)|tree.*verification.*(?:budget|limit)/iu,
  )
  assert.ok(treeReads <= transportReadLimit, `publication verification performed ${treeReads} tree reads`)
})


test("plugin publication ancestry shares one aggregate tree-read budget", async () => {
  const candidateCount = 3
  const chainDepth = 900
  let treeReads = 0
  const currentHead: V4RemoteHead = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "plaintext",
    epoch: 1,
    generation: 2,
    journalId: "journal-current",
    shardHashes: {},
    updatedAt: 2,
    deviceId: "remote",
  }
  const parentHead: V4RemoteHead = {
    ...currentHead,
    generation: 1,
    journalId: "journal-parent",
    updatedAt: 1,
  }
  const currentHeadBytes = new TextEncoder().encode(JSON.stringify(currentHead))
  const parentHeadBytes = new TextEncoder().encode(JSON.stringify(parentHead))

  const github = {
    async getGitCommit(sha: string) {
      const candidate = /^candidate-(\d+)$/u.exec(sha)
      if (candidate) {
        return {
          sha,
          treeSha: `candidate-tree-${candidate[1]}-0`,
          parentShas: [`base-${candidate[1]}`],
          message: `obsidian-sync-v4:${currentHead.journalId}`,
        }
      }
      const base = /^base-(\d+)$/u.exec(sha)
      if (base) {
        return {
          sha,
          treeSha: `base-tree-${base[1]}-0`,
          parentShas: [],
          message: "base",
        }
      }
      throw new Error(`unexpected commit: ${sha}`)
    },
    async getFileBytes(path: string, ref?: string) {
      assert.equal(path, V4_HEAD_PATH)
      if (ref?.startsWith("candidate-")) return { bytes: currentHeadBytes, sha: "a".repeat(40) }
      if (ref?.startsWith("base-")) return { bytes: parentHeadBytes, sha: "b".repeat(40) }
      return null
    },
    async getTreeAt(treeSha: string): Promise<GitHubTree> {
      treeReads++
      const match = /^(candidate|base)-tree-(\d+)-(\d+)$/u.exec(treeSha)
      if (!match) throw new Error(`unexpected tree: ${treeSha}`)
      const [, side, candidateIndex, depthText] = match
      const depth = Number(depthText)
      if (depth < chainDepth) {
        return {
          sha: treeSha,
          url: "",
          truncated: false,
          tree: [{
            path: "d",
            mode: "040000",
            type: "tree" as const,
            sha: `${side}-tree-${candidateIndex}-${depth + 1}`,
            url: "",
          }],
        }
      }
      return {
        sha: treeSha,
        url: "",
        truncated: false,
        tree: [{
          path: "leaf.md",
          mode: "100644",
          type: "blob" as const,
          sha: (side === "candidate" ? "c" : "d").repeat(40),
          size: 1,
          url: "",
        }],
      }
    },
  }

  const session = new V4SyncSession({
    github: github as never,
    vault: {} as never,
    index: createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "local", mode: "plaintext" }),
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
  }) as unknown as {
    findVerifiedPluginPublication(remote: unknown, tip: unknown): Promise<unknown>
  }

  const remote = {
    config: config(),
    head: currentHead,
    records: [],
    commitSha: "external-tip",
  }
  const tip = {
    sha: "external-tip",
    treeSha: "external-tree",
    parentShas: Array.from({ length: candidateCount }, (_, index) => `candidate-${index}`),
    message: "external",
  }

  await assert.rejects(
    () => session.findVerifiedPluginPublication(remote, tip),
    /publication|ancestry/iu,
  )
  assert.ok(treeReads <= 4_096, `ancestry publication verification performed ${treeReads} tree reads`)
})

test("plugin publication ancestry duplicate-parent fanout stays within CPU budget", async () => {
  const duplicateCount = 100_000
  let commitReads = 0
  const currentHead: V4RemoteHead = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "plaintext",
    epoch: 1,
    generation: 2,
    journalId: "journal-current",
    shardHashes: {},
    updatedAt: 2,
    deviceId: "remote",
  }

  const github = {
    async getGitCommit(sha: string) {
      commitReads++
      assert.equal(sha, "duplicate-parent")
      return {
        sha,
        treeSha: "duplicate-tree",
        parentShas: [],
        message: "external",
      }
    },
  }

  const session = new V4SyncSession({
    github: github as never,
    vault: {} as never,
    index: createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "local", mode: "plaintext" }),
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
  }) as unknown as {
    findVerifiedPluginPublication(remote: unknown, tip: unknown): Promise<unknown>
  }

  const remote = {
    config: config(),
    head: currentHead,
    records: [],
    commitSha: "external-tip",
  }
  const tip = {
    sha: "external-tip",
    treeSha: "external-tree",
    parentShas: Array(duplicateCount).fill("duplicate-parent"),
    message: "external",
  }

  const started = process.cpuUsage()
  await assert.rejects(
    () => session.findVerifiedPluginPublication(remote, tip),
    /publication|ancestry/iu,
  )
  const elapsed = process.cpuUsage(started)
  assert.equal(commitReads, 1, "duplicate ancestry parents must not cause duplicate commit reads")
  assert.ok(
    elapsed.user + elapsed.system < 250_000,
    `ancestry duplicate-parent traversal used ${elapsed.user + elapsed.system}µs CPU`,
  )
})
