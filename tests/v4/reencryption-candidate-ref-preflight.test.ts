import assert from "node:assert/strict"
import test from "node:test"
import { inspectV4ReencryptionCandidateGitRefs } from "../../src/lib/v4/reencryption-candidate-ref-preflight"
import type { V4ReencryptionCutoverSnapshotContract } from "../../src/lib/v4/reencryption-cutover-snapshot-contract"

const src = "1".repeat(40), srcTree = "2".repeat(40)
const dst = "3".repeat(40), dstTree = "4".repeat(40)

function scenario() {
  const contract: V4ReencryptionCutoverSnapshotContract = {
    transactionId: "a".repeat(32),
    identity: {
      runId: "rekey_d251", walGeneration: 10, indexRoot: "github-sync-v4-index",
      deviceId: "device_d251", sourceRepoId: "owner/repo#source",
      backupRepoId: "owner/repo#rekey/backup_d251",
      destinationRepoId: "owner/repo#rekey/dest_d251",
      sourceCommitSha: src, sourceTreeSha: srcTree,
      destinationCommitSha: dst, destinationTreeSha: dstTree,
      manifestSha256: "b".repeat(64),
      sourcePassphraseSecretId: "old-d251", destinationPassphraseSecretId: "new-d251",
    },
    sourceIndexSha256: "c".repeat(64), destinationShadowSha256: "d".repeat(64),
    preparedEvidenceSha256: "e".repeat(64), walSnapshotSha256: "f".repeat(64),
    sourceSettingsSha256: "1".repeat(64), destinationSettingsSha256: "2".repeat(64),
  }
  const state = { id: 97, sha: dst, tree: dstTree, parents: [] as string[],
    defaultBranch: "source", live: true, calls: 0, onRead: () => {} }
  const git = (branchName: string, sha: string, tree: string) => ({
    branchName,
    async getRepositoryIdentity() { state.calls++; state.onRead(); return { id: state.id, fullName: "owner/repo" } },
    async getRepositoryDefaultBranch() { return state.defaultBranch },
    async getGitRef() { return { ref: "refs/heads/" + branchName, type: "commit" as const,
      sha: branchName === "rekey/dest_d251" ? state.sha : sha } },
    async getGitCommit(commitSha: string) { return { sha: commitSha,
      treeSha: branchName === "rekey/dest_d251" ? state.tree : tree,
      parentShas: branchName === "rekey/dest_d251" ? state.parents : [src] } },
  })
  const input = { contract, backupGit: git("rekey/backup_d251", src, srcTree),
    destinationGit: git("rekey/dest_d251", dst, dstTree),
    assertLiveOwner() { if (!state.live) throw Error("owner revoked") } }
  return { state, input }
}

test("D251 double-observes physical repo and exact orphan refs without recovery authority", async () => {
  const s = scenario(), report = await inspectV4ReencryptionCandidateGitRefs(s.input)
  assert.equal(report.observation, "candidate-remote-refs-observed-untrusted")
  assert.equal(report.destinationOrphanTopologyObserved, true)
  assert.equal(report.fullDestinationContentsReverified, false)
  assert.equal(report.walAuthenticated, false)
  assert.equal(report.backupContentsAuthenticated, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.remoteWritesAuthorized, false)
  assert.ok(s.state.calls >= 4)
})

test("D251 denies moved, foreign, non-orphan and mutable remote scopes", async () => {
  const mutations = [
    (s: ReturnType<typeof scenario>) => { s.state.sha = src },
    (s: ReturnType<typeof scenario>) => { s.state.tree = srcTree },
    (s: ReturnType<typeof scenario>) => { s.state.parents = [src] },
    (s: ReturnType<typeof scenario>) => { s.state.defaultBranch = "rekey/dest_d251" },
    (s: ReturnType<typeof scenario>) => { s.state.id = 0 },
    (s: ReturnType<typeof scenario>) => { s.input.destinationGit.branchName = "other" },
    (s: ReturnType<typeof scenario>) => { s.state.onRead = () => { s.state.live = false } },
    (s: ReturnType<typeof scenario>) => {
      s.state.onRead = () => {
        s.input.destinationGit.getGitRef = async () =>
          ({ ref: "refs/heads/rekey/dest_d251", type: "commit", sha: dst })
      }
    },
  ]
  for (const mutate of mutations) {
    const s = scenario(); mutate(s)
    const report = await inspectV4ReencryptionCandidateGitRefs(s.input)
    assert.equal(report.observation, "manual-recovery-required")
    assert.equal(report.localCutoverAuthorized, false)
  }
})
