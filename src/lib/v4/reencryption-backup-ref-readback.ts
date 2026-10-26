import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import type { GitHubClient, GitHubRepositoryIdentity } from "../github-api"
import type { GitHubGitCommit } from "../github-git-types"
import { throwIfV4Aborted } from "./cancellation"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"

const GIT_SHA = /^[0-9a-f]{40}$/u

type ReadOnlyGit = Pick<GitHubClient, "getRepositoryIdentity" | "getGitRef" | "getGitCommit">

export interface V4SameRepositoryBackupRefReadbackInput {
  /** Two separately branch-scoped GitHub clients; never mutate either branch. */
  readonly source: ReadOnlyGit
  readonly backup: ReadOnlyGit
  readonly plan: V4SameRepoReencryptionBackupBranchProposal
  /** Tree SHA from a separately authenticated, exact-commit source inventory. */
  readonly expectedSourceTreeSha: string
  readonly signal?: AbortSignal | undefined
}

export interface V4SameRepositoryBackupRefReadbackReport {
  readonly integrityScope: "same-repository-backup-ref-pointer-only"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly pinnedSourceTreeSha: string
  readonly refAndCommitPointersMatch: true
  readonly backupCreationProven: false
  readonly backupContentsReadbackVerified: false
  readonly independentStorageVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
  readonly oldBranchDeletionAuthorized: false
}

function parseRepoId(repoId: string): { fullName: string; branch: string } {
  if (typeof repoId !== "string") throw new Error("Invalid re-encryption backup repository identity.")
  const match = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(repoId)
  if (!match) throw new Error("Invalid re-encryption backup repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { fullName: owner + "/" + repo, branch }
}

function validatePlan(plan: V4SameRepoReencryptionBackupBranchProposal, treeSha: string) {
  if (!plan || plan.proof !== "owner-approved-same-repo-backup-topology-only"
    || plan.status !== "blocked-pending-safe-backup-ref-implementation"
    || !Number.isSafeInteger(plan.physicalRepositoryId) || plan.physicalRepositoryId < 1
    || !GIT_SHA.test(plan.pinnedSourceCommitSha) || !GIT_SHA.test(treeSha)
    || plan.actualBackupCreated !== false || plan.independentStorageVerified !== false
    || plan.permissionToPublish !== false || plan.cutoverAuthorized !== false
    || plan.oldBranchDeletionAuthorized !== false) {
    throw new Error("Re-encryption backup ref requires a blocked approved plan and exact source tree SHA.")
  }
  const source = parseRepoId(plan.sourceRepoId)
  const backup = parseRepoId(plan.backupRepoId)
  const destination = parseRepoId(plan.destinationRepoId)
  if (source.fullName.toLowerCase() !== backup.fullName.toLowerCase()
    || source.fullName.toLowerCase() !== destination.fullName.toLowerCase()
    || source.branch === backup.branch || backup.branch === destination.branch
    || source.branch === destination.branch || backup.branch !== plan.backupBranch) {
    throw new Error("Re-encryption backup plan repository or branch identity mismatch.")
  }
  return { source, backup }
}

function assertIdentity(identity: GitHubRepositoryIdentity, id: number, fullName: string): void {
  if (!identity || identity.id !== id || typeof identity.fullName !== "string"
    || identity.fullName.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error("Re-encryption backup physical GitHub repository identity mismatch.")
  }
}

function assertCommit(commit: GitHubGitCommit, pinned: string, tree: string): void {
  if (!commit || commit.sha !== pinned || commit.treeSha !== tree
    || !Array.isArray(commit.parentShas)
    || commit.parentShas.some(sha => typeof sha !== "string" || !GIT_SHA.test(sha))) {
    throw new Error("Re-encryption backup immutable Git commit/tree identity mismatch.")
  }
}

/**
 * D89: READ-ONLY branch/commit pointer inspection. A backup ref pointing at
 * the exact source commit shares the original Git object tree. This is NOT
 * proof that our writer created the ref, that every reachable blob can be
 * read/decrypted, or that an independent backup exists. Stale-client fencing,
 * durable WAL, full restore and cutover remain mandatory separate gates.
 *
 * Double observations detect changes at their sample points, not transient
 * ABA changes between reads. Do not use this result as an atomic ref CAS.
 */
export async function inspectV4SameRepositoryBackupRef(
  input: V4SameRepositoryBackupRefReadbackInput,
): Promise<V4SameRepositoryBackupRefReadbackReport> {
  throwIfV4Aborted(input.signal)
  const { source, backup } = validatePlan(input.plan, input.expectedSourceTreeSha)
  const { physicalRepositoryId: physicalId, pinnedSourceCommitSha: pinned } = input.plan
  const { expectedSourceTreeSha: tree } = input
  const checkIdentity = async (client: ReadOnlyGit) => {
    throwIfV4Aborted(input.signal)
    const identity = await client.getRepositoryIdentity()
    throwIfV4Aborted(input.signal)
    assertIdentity(identity, physicalId, source.fullName)
  }
  const checkRef = async (client: ReadOnlyGit, branch: string) => {
    throwIfV4Aborted(input.signal)
    const ref = await client.getGitRef()
    throwIfV4Aborted(input.signal)
    if (!ref || ref.ref !== `refs/heads/${branch}`
      || ref.type !== "commit" || ref.sha !== pinned) {
      throw new Error("Re-encryption backup Git ref is absent, ambiguous or changed from the pinned source commit.")
    }
  }
  await checkIdentity(input.source)
  await checkIdentity(input.backup)
  await checkRef(input.source, source.branch)
  await checkRef(input.backup, backup.branch)
  throwIfV4Aborted(input.signal)
  const sourceCommit = await input.source.getGitCommit(pinned)
  throwIfV4Aborted(input.signal)
  assertCommit(sourceCommit, pinned, tree)
  const backupCommit = await input.backup.getGitCommit(pinned)
  throwIfV4Aborted(input.signal)
  assertCommit(backupCommit, pinned, tree)
  if (sourceCommit.parentShas.length !== backupCommit.parentShas.length
    || sourceCommit.parentShas.some((sha, i) => sha !== backupCommit.parentShas[i])) {
    throw new Error("Re-encryption backup commit ancestry differs from the pinned source.")
  }
  await checkRef(input.source, source.branch)
  await checkRef(input.backup, backup.branch)
  await checkIdentity(input.source)
  await checkIdentity(input.backup)
  return Object.freeze({
    integrityScope: "same-repository-backup-ref-pointer-only",
    backupRepoId: input.plan.backupRepoId,
    pinnedSourceCommitSha: pinned,
    pinnedSourceTreeSha: tree,
    refAndCommitPointersMatch: true,
    backupCreationProven: false,
    backupContentsReadbackVerified: false,
    independentStorageVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    oldBranchDeletionAuthorized: false,
  })
}
