import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../../src/lib/github-git-types"
import {
  createV4CandidateCommit,
  publishV4CandidateRef,
  type V4GitTreeGithub,
} from "../../src/lib/v4/git-tree-writer"

function commit(sha: string, treeSha: string, parentShas: string[], message?: string): GitHubGitCommit {
  return { sha, treeSha, parentShas, message }
}

class WriterGithub implements V4GitTreeGithub {
  ref: GitHubGitRef | null = null
  commits = new Map<string, GitHubGitCommit>()
  updateCalls = 0
  createCalls = 0
  refReads = 0
  failRefReadAt = new Set<number>()
  afterRefReadFailure?: () => void
  mutationError: unknown
  afterMutationFailure?: () => void
  failCommitReads = new Set<string>()

  async getGitRefOrNull() {
    this.refReads++
    if (this.failRefReadAt.has(this.refReads)) {
      this.afterRefReadFailure?.()
      throw new Error(`ref-read-${this.refReads}-failed`)
    }
    return this.ref
  }
  async ensureGitRepositoryInitialized() { return this.ref }
  async getGitCommit(sha: string) {
    if (this.failCommitReads.has(sha)) throw Object.assign(new Error(`commit-read-${sha}-failed`), { status: 503 })
    const found = this.commits.get(sha)
    if (!found) throw Object.assign(new Error(`missing:${sha}`), { status: 404 })
    return found
  }
  async createGitBlob(_bytes: Uint8Array) { return "blob" }
  async createGitTree(_entries: GitHubCreateTreeEntry[], _baseTree?: string) { return "candidate-tree" }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = "candidate"
    this.commits.set(sha, commit(sha, treeSha, parents, message))
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

async function existingCandidate(github: WriterGithub, journalId: string) {
  github.ref = { ref: "refs/heads/main", sha: "base", type: "commit" }
  github.commits.set("base", commit("base", "tree-base", [], "base"))
  return createV4CandidateCommit(github, {
    base: { ref: github.ref, previousHeadSha: "base", baseTreeSha: "tree-base" },
    message: `obsidian-sync-v4:${journalId}`,
    entries: [],
  })
}

async function capture(task: () => Promise<unknown>): Promise<unknown> {
  try {
    await task()
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

test("pre-publish ref read failure is not reclassified as an ambiguous post-publish race", async () => {
  const github = new WriterGithub()
  const candidate = await existingCandidate(github, "pre-read")
  github.failRefReadAt.add(1)
  github.afterRefReadFailure = () => {
    github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
  }

  const error = await capture(() => publishV4CandidateRef(github, candidate)) as Error & { code?: string }

  assert.match(error.message, /ref-read-1-failed/iu)
  assert.equal(error.code, undefined)
  assert.equal(github.updateCalls, 0)
})

test("definitive ref failure with unchanged expected head preserves the original error without retry", async () => {
  const github = new WriterGithub()
  const candidate = await existingCandidate(github, "definitive")
  const original = Object.assign(new Error("validation failed"), { status: 422 })
  github.mutationError = original

  const error = await capture(() => publishV4CandidateRef(github, candidate))

  assert.equal(error, original)
  assert.equal(github.updateCalls, 1)
})

test("reconciliation current-head read failure preserves the original mutation failure", async () => {
  const github = new WriterGithub()
  const candidate = await existingCandidate(github, "head-read")
  const original = Object.assign(new Error("mutation failed"), { status: 422 })
  github.mutationError = original
  github.failRefReadAt.add(2)

  const error = await capture(() => publishV4CandidateRef(github, candidate))

  assert.equal(error, original)
  assert.equal(github.updateCalls, 1)
})

test("advanced head with incomplete ancestry becomes typed unknown race and retains original cause", async () => {
  const github = new WriterGithub()
  const candidate = await existingCandidate(github, "incomplete")
  const original = Object.assign(new Error("ref rejected"), { status: 422 })
  github.mutationError = original
  github.afterMutationFailure = () => {
    github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
    github.commits.set("later", commit("later", "tree-later", ["unreadable"], "external"))
    github.failCommitReads.add("unreadable")
  }

  const error = await capture(() => publishV4CandidateRef(github, candidate)) as Record<string, unknown>

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "post-publish")
  assert.equal(error.expectedHeadSha, "base")
  assert.equal(error.observedHeadSha, "later")
  assert.equal(error.publicationOutcome, "unknown")
  assert.equal(error.cause, original)
  assert.equal(github.updateCalls, 1)
})

test("marker-equivalent publication in advanced ancestry becomes typed published race", async () => {
  const github = new WriterGithub()
  const candidate = await existingCandidate(github, "equivalent")
  const original = Object.assign(new Error("lost response"), { status: 502 })
  github.mutationError = original
  github.afterMutationFailure = () => {
    github.commits.set("equivalent", commit("equivalent", candidate.treeSha, ["base"], candidate.message))
    github.commits.set("later", commit("later", "tree-later", ["equivalent"], "external"))
    github.ref = { ref: "refs/heads/main", sha: "later", type: "commit" }
  }

  const error = await capture(() => publishV4CandidateRef(github, candidate)) as Record<string, unknown>

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "post-publish")
  assert.equal(error.observedHeadSha, "later")
  assert.equal(error.publicationOutcome, "published")
  assert.equal(error.cause, original)
})

test("empty-branch publication failure remains original when no competing head can be observed", async () => {
  const github = new WriterGithub()
  const candidate = await createV4CandidateCommit(github, {
    base: { ref: null },
    message: "obsidian-sync-v4:empty-failure",
    entries: [],
  })
  const original = Object.assign(new Error("create ref failed"), { status: 500 })
  github.mutationError = original

  const error = await capture(() => publishV4CandidateRef(github, candidate))

  assert.equal(error, original)
  assert.equal(github.createCalls, 1)
})
