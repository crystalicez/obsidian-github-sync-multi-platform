import type { GitHubGitCommit, GitHubGitRef } from "../github-git-types"
import { throwIfV4Aborted } from "./cancellation"

export interface V4PublishReconcilerGithub {
  getGitRefOrNull(): Promise<GitHubGitRef | null>
  getGitCommit(sha: string): Promise<GitHubGitCommit>
}

export type V4PublishReconcileStatus = "published" | "published-advanced" | "not-published" | "diverged" | "indeterminate"
export type V4PublishReconcileEvidence =
  | "candidate-head"
  | "candidate-ancestor"
  | "marker-equivalent"
  | "expected-head"
  | "unrelated-head"
  | "traversal-limit"
  | "ancestry-read-failure"
export type V4PublishReconcileIndeterminateReason = "traversal-limit" | "ancestry-read-failure"

export interface V4PublishReconcileResult {
  status: V4PublishReconcileStatus
  evidence: V4PublishReconcileEvidence
  currentHeadSha: string | null
  publishedCommitSha?: string
  verifiedHeadSha?: string
  indeterminateReason?: V4PublishReconcileIndeterminateReason
}

export interface V4PublishReconcileInput {
  candidateCommitSha: string
  expectedHeadSha: string | null
  journalId?: string
  maxCommits?: number
  signal?: AbortSignal
}

function sameParents(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function markerFor(journalId: string | undefined): string | undefined {
  return journalId ? `obsidian-sync-v4:${journalId}` : undefined
}

export async function reconcileV4CandidatePublication(
  github: V4PublishReconcilerGithub,
  input: V4PublishReconcileInput,
): Promise<V4PublishReconcileResult> {
  throwIfV4Aborted(input.signal)
  const ref = await github.getGitRefOrNull()
  throwIfV4Aborted(input.signal)
  const currentHeadSha = ref?.sha ?? null
  if (currentHeadSha === input.candidateCommitSha) {
    return {
      status: "published",
      evidence: "candidate-head",
      currentHeadSha,
      publishedCommitSha: input.candidateCommitSha,
      verifiedHeadSha: currentHeadSha ?? undefined,
    }
  }
  if (currentHeadSha === input.expectedHeadSha) {
    return { status: "not-published", evidence: "expected-head", currentHeadSha }
  }
  if (!currentHeadSha) return { status: "diverged", evidence: "unrelated-head", currentHeadSha }

  const marker = markerFor(input.journalId)
  let candidate: GitHubGitCommit | undefined
  let incompleteAncestry = false
  if (marker) {
    try {
      candidate = await github.getGitCommit(input.candidateCommitSha)
      throwIfV4Aborted(input.signal)
    } catch (error) {
      if (input.signal?.aborted) throw error
      incompleteAncestry = true
    }
  }

  const queue = [currentHeadSha]
  const visited = new Set<string>()
  const maxCommits = Math.max(1, Math.floor(input.maxCommits ?? 256))
  let markerEquivalent: GitHubGitCommit | undefined

  while (queue.length > 0 && visited.size < maxCommits) {
    throwIfV4Aborted(input.signal)
    const sha = queue.shift()!
    if (visited.has(sha)) continue
    visited.add(sha)
    if (sha === input.candidateCommitSha) {
      return {
        status: "published-advanced",
        evidence: "candidate-ancestor",
        currentHeadSha,
        publishedCommitSha: input.candidateCommitSha,
        verifiedHeadSha: currentHeadSha,
      }
    }
    if (sha === input.expectedHeadSha) continue
    let current: GitHubGitCommit
    try {
      current = await github.getGitCommit(sha)
      throwIfV4Aborted(input.signal)
    } catch (error) {
      if (input.signal?.aborted) throw error
      incompleteAncestry = true
      continue
    }
    if (
      !markerEquivalent
      && marker
      && candidate
      && current.message === marker
      && current.treeSha === candidate.treeSha
      && sameParents(current.parentShas, candidate.parentShas)
    ) markerEquivalent = current
    for (const parent of current.parentShas) if (!visited.has(parent)) queue.push(parent)
  }

  if (markerEquivalent) {
    return {
      status: "published-advanced",
      evidence: "marker-equivalent",
      currentHeadSha,
      publishedCommitSha: markerEquivalent.sha,
      verifiedHeadSha: currentHeadSha,
    }
  }
  if (queue.length > 0) {
    return {
      status: "indeterminate",
      evidence: "traversal-limit",
      currentHeadSha,
      indeterminateReason: "traversal-limit",
    }
  }
  if (incompleteAncestry) {
    return {
      status: "indeterminate",
      evidence: "ancestry-read-failure",
      currentHeadSha,
      indeterminateReason: "ancestry-read-failure",
    }
  }
  return { status: "diverged", evidence: "unrelated-head", currentHeadSha }
}
