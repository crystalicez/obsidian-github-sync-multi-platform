import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubTree } from "../../src/lib/github-api"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
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
