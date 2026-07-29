import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubGitCommit, GitHubGitRef } from "../../src/lib/github-git-types"
import {
  reconcileV4CandidatePublication,
  type V4PublishReconcilerGithub,
} from "../../src/lib/v4/publish-reconciler"
import {
  createV4RecoveryStore,
  reconcileV4RecoveryPublishIntent,
} from "../../src/lib/v4/recovery-store"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

class GraphGithub implements V4PublishReconcilerGithub {
  ref: GitHubGitRef | null = null
  readonly commits = new Map<string, GitHubGitCommit>()
  reads: string[] = []
  async getGitRefOrNull() { return this.ref }
  async getGitCommit(sha: string) {
    this.reads.push(sha)
    const commit = this.commits.get(sha)
    if (!commit) throw Object.assign(new Error(`missing:${sha}`), { status: 404 })
    return commit
  }
}

function commit(sha: string, treeSha: string, parentShas: string[], message?: string): GitHubGitCommit {
  return { sha, treeSha, parentShas, message }
}

test("publish reconciliation uses exact candidate head evidence without marker search", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "candidate", type: "commit" }
  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j1",
  })
  assert.equal(result.status, "published")
  assert.equal(result.evidence, "candidate-head")
  assert.deepEqual(github.reads, [])
})

test("publish reconciliation recognizes the exact candidate in advanced ancestry", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
  github.commits.set("later", commit("later", "t2", ["candidate"], "external"))
  github.commits.set("candidate", commit("candidate", "t1", ["base"], "obsidian-sync-v4:j1"))
  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j1",
  })
  assert.equal(result.status, "published-advanced")
  assert.equal(result.evidence, "candidate-ancestor")
  assert.equal(result.verifiedHeadSha, "later")
})

test("marker fallback requires the candidate tree and parents to match", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
  github.commits.set("candidate", commit("candidate", "tree-candidate", ["base"], "obsidian-sync-v4:j1"))
  github.commits.set("later", commit("later", "tree-later", ["equivalent"], "external"))
  github.commits.set("equivalent", commit("equivalent", "tree-candidate", ["base"], "obsidian-sync-v4:j1"))
  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j1",
  })
  assert.equal(result.status, "published-advanced")
  assert.equal(result.evidence, "marker-equivalent")
  assert.equal(result.publishedCommitSha, "equivalent")
})

test("unchanged expected head is direct evidence that an ambiguous ref mutation did not publish", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "base", type: "commit" }
  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j1",
  })
  assert.equal(result.status, "not-published")
  assert.equal(result.evidence, "expected-head")
})

class MemoryAdapter implements V4LocalIndexAdapter {
  values = new Map<string, string>()
  async read(path: string) { return this.values.get(path)! }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

test("recovery publish-intent becomes remote-verified only for the exact candidate head", async () => {
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run1",
    journalId: "j1",
    phase: "publish-intent",
    expectedRemoteHead: "base",
    candidateCommitSha: "candidate",
    payload: { mutations: [], completedMutationIds: [] },
  })
  const reconciled = await reconcileV4RecoveryPublishIntent({
    store,
    snapshot,
    result: {
      status: "published",
      evidence: "candidate-head",
      currentHeadSha: "candidate",
      publishedCommitSha: "candidate",
      verifiedHeadSha: "candidate",
    },
  })
  assert.equal(reconciled.header.phase, "remote-verified")
  assert.equal(reconciled.header.verifiedRemoteHead, "candidate")
})

test("recovery marks advanced or divergent publication evidence for replan instead of replaying the ref", async () => {
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run2",
    journalId: "j2",
    phase: "publish-intent",
    expectedRemoteHead: "base",
    candidateCommitSha: "candidate",
    payload: { mutations: [], completedMutationIds: [] },
  })
  const reconciled = await reconcileV4RecoveryPublishIntent({
    store,
    snapshot,
    result: {
      status: "published-advanced",
      evidence: "candidate-ancestor",
      currentHeadSha: "later",
      publishedCommitSha: "candidate",
      verifiedHeadSha: "later",
    },
  })
  assert.equal(reconciled.header.phase, "replan-required")
  assert.equal(reconciled.header.candidateCommitSha, "candidate")
})

test("startup recovery reconciles an advanced head through exact candidate ancestry before replanning", async () => {
  const { recoverV4PendingState } = await import("../../src/lib/v4/recovery-store")
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run3",
    journalId: "j3",
    phase: "publish-intent",
    expectedRemoteHead: "base",
    candidateCommitSha: "candidate",
    payload: { mutations: [], completedMutationIds: [] },
  })
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
  github.commits.set("candidate", commit("candidate", "tree", ["base"], "obsidian-sync-v4:j3"))
  github.commits.set("later", commit("later", "later-tree", ["candidate"], "external"))
  const recovered = await recoverV4PendingState({
    store,
    snapshot,
    io: {
      listFiles: async () => [],
      read: async () => new Uint8Array(),
      write: async () => {},
      trash: async () => {},
    },
    currentRemoteHead: "later",
    publicationGithub: github,
  })
  assert.equal(recovered.replanRequired, true)
  assert.equal(recovered.snapshot.header.phase, "replan-required")
  assert.equal(recovered.snapshot.header.verifiedRemoteHead, "candidate")
  assert.equal(github.reads.includes("later"), true)
})
