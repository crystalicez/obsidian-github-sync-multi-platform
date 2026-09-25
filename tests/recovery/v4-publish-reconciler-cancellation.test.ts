import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubGitCommit, GitHubGitRef } from "../../src/lib/github-git-types"
import { V4CancelledError } from "../../src/lib/v4/cancellation"
import { reconcileV4CandidatePublication, type V4PublishReconcilerGithub } from "../../src/lib/v4/publish-reconciler"

class CancellingGraph implements V4PublishReconcilerGithub {
  ref: GitHubGitRef | null = { ref: "refs/heads/main", sha: "tip", type: "commit" }
  constructor(private readonly controller: AbortController) {}

  async getGitRefOrNull() { return this.ref }

  async getGitCommit(sha: string): Promise<GitHubGitCommit> {
    if (sha === "candidate") {
      this.controller.abort("cancel-during-candidate-read")
      throw Object.assign(new Error("candidate read failed"), { status: 503 })
    }
    return { sha, treeSha: `tree-${sha}`, parentShas: ["base"], message: "external" }
  }
}

async function capture(task: () => Promise<unknown>): Promise<unknown> {
  try {
    await task()
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

test("reconciler canonicalizes cancellation that happens during a failing commit read", async () => {
  const controller = new AbortController()
  const github = new CancellingGraph(controller)

  const error = await capture(() => reconcileV4CandidatePublication(github, {
    candidateCommitSha: "candidate",
    expectedHeadSha: "base",
    journalId: "cancel-test",
    signal: controller.signal,
  }))

  assert.ok(error instanceof V4CancelledError)
  assert.equal(error.reason, "cancel-during-candidate-read")
})
