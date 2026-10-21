import assert from "node:assert/strict"
import test from "node:test"

import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto"
import { V4_METADATA_MAX_BYTES } from "../../src/lib/v4/metadata-bounds"
import { V4HistoryService } from "../../src/lib/v4/history-service"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"

const repoId = "owner/repo#main"
const enc = new TextEncoder()
const commit = { sha: "c", message: "obsidian-sync-v4:j1", authorName: "test", authoredAt: "2026-10-21T00:00:00Z",
  parentShas: [], source: "plugin" as const, journalId: "j1" }
const page = { journalId: "j1", page: 0, pageCount: 1, changes: [] }

for (const mode of ["plaintext", "encrypted"] as const) {
  test(`history journal ${mode} rejects over-budget wire bytes before JSON/decrypt`, async () => {
    const keyring = mode === "encrypted"
      ? await deriveV4Keyring({ passphrase: "example", repoId, salt: enc.encode("salt"), iterations: 10 })
      : undefined
    const config: V4RemoteConfig = {
      formatVersion: 4, mode, repoId, pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    }
    let current = mode === "encrypted"
      ? await encryptV4Payload(keyring!.journalKey, enc.encode(JSON.stringify(page)), { kind: "journal", aad: `${repoId}:j1:0` })
      : enc.encode(JSON.stringify(page))
    const github = {
      async listCommits() { return [] },
      async getFileBytes() { return { bytes: current, sha: "sha" } },
      async getGitCommit(sha: string) { return { sha, treeSha: "tree", parentShas: [] } },
      async getTreeAt(): Promise<never> { throw Error("unexpected tree") },
      async getBlob(): Promise<never> { throw Error("unexpected blob") },
    }
    const service = new V4HistoryService({ github, config, keyring })
    assert.deepEqual(await service.getCommitChanges(commit), [])

    current = new Uint8Array(V4_METADATA_MAX_BYTES.journal + (mode === "encrypted" ? 34 : 1)).fill(32)
    await assert.rejects(() => service.getCommitChanges(commit), /V4 journal metadata exceeds.*byte limit/u)
  })
}
