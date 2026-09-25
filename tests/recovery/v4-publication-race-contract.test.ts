import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../../src/lib/github-git-types"
import {
  createV4CandidateCommit,
  publishV4CandidateRef,
  resolveV4PublicationBase,
  type V4GitTreeGithub,
} from "../../src/lib/v4/git-tree-writer"
import {
  reconcileV4CandidatePublication,
  type V4PublishReconcilerGithub,
} from "../../src/lib/v4/publish-reconciler"
import {
  createV4RecoveryStore,
  reconcileV4RecoveryPublishIntent,
} from "../../src/lib/v4/recovery-store"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

function commit(sha: string, treeSha: string, parentShas: string[], message?: string): GitHubGitCommit {
  return { sha, treeSha, parentShas, message }
}

class GraphGithub implements V4PublishReconcilerGithub {
  ref: GitHubGitRef | null = null
  readonly commits = new Map<string, GitHubGitCommit>()
  failReads = new Set<string>()

  async getGitRefOrNull() { return this.ref }
  async getGitCommit(sha: string) {
    if (this.failReads.has(sha)) throw Object.assign(new Error(`read failed:${sha}`), { status: 503 })
    const value = this.commits.get(sha)
    if (!value) throw Object.assign(new Error(`missing:${sha}`), { status: 404 })
    return value
  }
}

test("publication reconciliation is indeterminate when the ancestry traversal bound is exhausted", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "tip", type: "commit" }
  github.commits.set("candidate", commit("candidate", "tc", ["base"], "obsidian-sync-v4:j1"))
  github.commits.set("tip", commit("tip", "t3", ["p2"], "external-3"))
  github.commits.set("p2", commit("p2", "t2", ["p1"], "external-2"))
  github.commits.set("p1", commit("p1", "t1", ["base"], "external-1"))

  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j1",
    maxCommits: 2,
  }) as { status: string; currentHeadSha: string | null; indeterminateReason?: string }

  assert.equal(result.status, "indeterminate")
  assert.equal(result.currentHeadSha, "tip")
  assert.equal(result.indeterminateReason, "traversal-limit")
})

test("publication reconciliation is indeterminate when ancestry cannot be read completely", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "tip", type: "commit" }
  github.commits.set("candidate", commit("candidate", "tc", ["base"], "obsidian-sync-v4:j2"))
  github.commits.set("tip", commit("tip", "t2", ["unreadable"], "external"))
  github.failReads.add("unreadable")

  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j2",
  }) as { status: string; currentHeadSha: string | null; indeterminateReason?: string }

  assert.equal(result.status, "indeterminate")
  assert.equal(result.currentHeadSha, "tip")
  assert.equal(result.indeterminateReason, "ancestry-read-failure")
})

test("candidate metadata read failure cannot become a false unrelated-head conclusion when marker equivalence matters", async () => {
  const github = new GraphGithub()
  github.ref = { ref: "refs/heads/main", sha: "tip", type: "commit" }
  github.failReads.add("candidate")
  github.commits.set("tip", commit("tip", "tree", ["base"], "obsidian-sync-v4:j3"))

  const result = await reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "j3",
  }) as { status: string; indeterminateReason?: string }

  assert.equal(result.status, "indeterminate")
  assert.equal(result.indeterminateReason, "ancestry-read-failure")
})

class MemoryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  async read(path: string) { return this.values.get(path)! }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

test("advanced publication evidence triggers recovery replan without inventing a verified remote head", async () => {
  const store = createV4RecoveryStore({ adapter: new MemoryAdapter(), root: "recovery", repoId: "o/r#main" })
  const snapshot = await store.save({
    runId: "run-advanced",
    journalId: "j4",
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
    } as never,
  })

  assert.equal(reconciled.header.phase, "replan-required")
  assert.equal(reconciled.header.verifiedRemoteHead, undefined)
})

test("indeterminate publication evidence triggers recovery replan without a verified remote head", async () => {
  const store = createV4RecoveryStore({ adapter: new MemoryAdapter(), root: "recovery", repoId: "o/r#main" })
  const snapshot = await store.save({
    runId: "run-indeterminate",
    journalId: "j5",
    phase: "publish-intent",
    expectedRemoteHead: "base",
    candidateCommitSha: "candidate",
    payload: { mutations: [], completedMutationIds: [] },
  })

  const reconciled = await reconcileV4RecoveryPublishIntent({
    store,
    snapshot,
    result: {
      status: "indeterminate",
      evidence: "ancestry-read-failure",
      currentHeadSha: "later",
      indeterminateReason: "ancestry-read-failure",
    } as never,
  })

  assert.equal(reconciled.header.phase, "replan-required")
  assert.equal(reconciled.header.verifiedRemoteHead, undefined)
})

class WriterGithub implements V4GitTreeGithub {
  ref: GitHubGitRef | null = null
  readonly commits = new Map<string, GitHubGitCommit>()
  updateCalls = 0
  createCalls = 0
  mutationError: unknown = undefined
  afterMutationFailure?: () => void

  async getGitRefOrNull() { return this.ref }
  async ensureGitRepositoryInitialized() { return this.ref }
  async getGitCommit(sha: string) {
    const found = this.commits.get(sha)
    if (found) return found
    return commit(sha, `tree-${sha}`, [], "external")
  }
  async createGitBlob(_bytes: Uint8Array) { return "blob" }
  async createGitTree(_entries: GitHubCreateTreeEntry[], _baseTree?: string) { return "candidate-tree" }
  async createGitCommit(message: string, tree: string, parents: string[]) {
    const sha = "candidate"
    this.commits.set(sha, commit(sha, tree, parents, message))
    return sha
  }
  async createGitRef(sha: string) {
    this.createCalls++
    if (this.mutationError) {
      this.afterMutationFailure?.()
      throw this.mutationError
    }
    this.ref = { ref: "refs/heads/main", sha, type: "commit" }
  }
  async updateGitRef(sha: string, _expectedSha?: string) {
    this.updateCalls++
    if (this.mutationError) {
      this.afterMutationFailure?.()
      throw this.mutationError
    }
    this.ref = { ref: "refs/heads/main", sha, type: "commit" }
  }
}

async function captureError(task: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await task()
  } catch (error) {
    return error as Record<string, unknown>
  }
  throw new Error("expected task to reject")
}

test("pre-publish head mismatch is a structured publication race and performs no mutation", async () => {
  const github = new WriterGithub()
  github.ref = { ref: "refs/heads/main", sha: "observed", type: "commit" }

  const error = await captureError(() => resolveV4PublicationBase(github, "expected"))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "pre-publish")
  assert.equal(error.expectedHeadSha, "expected")
  assert.equal(error.observedHeadSha, "observed")
  assert.equal(error.publicationOutcome, "not-published")
  assert.equal(github.updateCalls, 0)
  assert.equal(github.createCalls, 0)
})

test("definitive ref failure is reconciled and becomes a typed race when another head won", async () => {
  const github = new WriterGithub()
  github.ref = { ref: "refs/heads/main", sha: "base", type: "commit" }
  const candidate = await createV4CandidateCommit(github, {
    base: { ref: github.ref, previousHeadSha: "base", baseTreeSha: "tree-base" },
    message: "obsidian-sync-v4:j6",
    entries: [],
  })
  const original = Object.assign(new Error("validation failed"), { status: 422 })
  github.mutationError = original
  github.afterMutationFailure = () => {
    github.ref = { ref: "refs/heads/main", sha: "winner", type: "commit" }
    github.commits.set("winner", commit("winner", "tree-winner", ["base"], "external"))
  }

  const error = await captureError(() => publishV4CandidateRef(github, candidate))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "post-publish")
  assert.equal(error.expectedHeadSha, "base")
  assert.equal(error.observedHeadSha, "winner")
  assert.equal(error.publicationOutcome, "unknown")
  assert.equal(error.cause, original)
  assert.equal(github.updateCalls, 1)
})

test("candidate found in advanced ancestry reports typed race with publication proven", async () => {
  const github = new WriterGithub()
  github.ref = { ref: "refs/heads/main", sha: "base", type: "commit" }
  const candidate = await createV4CandidateCommit(github, {
    base: { ref: github.ref, previousHeadSha: "base", baseTreeSha: "tree-base" },
    message: "obsidian-sync-v4:j7",
    entries: [],
  })
  const original = Object.assign(new Error("lost response"), { name: "V4GitMutationOutcomeUnknownError", retryClass: "reachable-ref" })
  github.mutationError = original
  github.afterMutationFailure = () => {
    github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
    github.commits.set("later", commit("later", "tree-later", [candidate.commitSha], "external"))
  }

  const error = await captureError(() => publishV4CandidateRef(github, candidate))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "post-publish")
  assert.equal(error.observedHeadSha, "later")
  assert.equal(error.publicationOutcome, "published")
  assert.equal(error.cause, original)
  assert.equal(github.updateCalls, 1)
})

test("empty-branch create race is classified as bootstrap publication race", async () => {
  const github = new WriterGithub()
  const candidate = await createV4CandidateCommit(github, {
    base: { ref: null },
    message: "obsidian-sync-v4:j8",
    entries: [],
  })
  const original = Object.assign(new Error("ref already exists"), { status: 422 })
  github.mutationError = original
  github.afterMutationFailure = () => {
    github.ref = { ref: "refs/heads/main", sha: "winner", type: "commit" }
    github.commits.set("winner", commit("winner", "tree-winner", [], "external"))
  }

  const error = await captureError(() => publishV4CandidateRef(github, candidate))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "bootstrap-publish")
  assert.equal(error.expectedHeadSha, null)
  assert.equal(error.observedHeadSha, "winner")
  assert.equal(error.publicationOutcome, "unknown")
  assert.equal(error.cause, original)
  assert.equal(github.createCalls, 1)
})
