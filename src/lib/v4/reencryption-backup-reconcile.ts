import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"
import { verifyGitHubFrozenReencryptionBackup } from "./reencryption-trusted-loader"

/**
 * D95: strictly READ-ONLY reconciliation after a potentially ambiguous
 * createGitRef response. A null ref at two instants is NOT permission to retry
 * a creation, and a matching ref is NOT evidence our write created it.
 * Never moves or deletes a ref and never authorizes destination publication.
 */
export interface V4FrozenBackupRecoveryInput {
  readonly plan: V4SameRepoReencryptionBackupBranchProposal
  readonly expectedSourceTreeSha: string
  readonly originalPassphrase: string
  readonly backup: Pick<GitHubClient,
    "branchName" | "getGitRef" | "getGitRefOrNull" |
    "getRepositoryIdentity" | "getRepositoryDefaultBranch" |
    "getGitCommit" | "getTreeAt" | "getBlob">
  readonly signal?: AbortSignal | undefined
}

export type V4FrozenBackupRecoveryOutcome =
  | "ref-unobserved-at-two-checks"
  | "ref-occupied-by-other-commit"
  | "matching-backup-full-readback"

export interface V4FrozenBackupRecoveryReport {
  readonly integrityScope: "ambiguous-backup-create-read-only-reconciliation"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly outcome: V4FrozenBackupRecoveryOutcome
  readonly backupContentsReadbackVerified: boolean
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly creationProven: false
  readonly automaticallyRetryCreateAuthorized: false
  readonly overwriteAuthorized: false
  readonly installedObsidianRestoreVerified: false
  readonly independentStorageVerified: false
  readonly destinationPublicationAuthorized: false
  readonly cutoverAuthorized: false
}

const GIT_SHA = /^[0-9a-f]{40}$/u
function splitRepoId(value: string): { fullName: string; branch: string } {
  if (typeof value !== "string") throw new Error("Frozen backup recovery has invalid repository identity.")
  const match = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(value)
  if (!match) throw new Error("Frozen backup recovery has invalid repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { fullName: owner + "/" + repo, branch }
}

export async function inspectV4FrozenBackupAfterAmbiguousCreate(
  input: V4FrozenBackupRecoveryInput,
): Promise<V4FrozenBackupRecoveryReport> {
  throwIfV4Aborted(input.signal)
  const { plan, backup } = input
  if (!plan || plan.proof !== "owner-approved-same-repo-backup-topology-only"
    || plan.status !== "blocked-pending-safe-backup-ref-implementation"
    || plan.actualBackupCreated !== false || plan.backupReadbackVerified !== false
    || plan.permissionToPublish !== false || plan.cutoverAuthorized !== false
    || plan.oldBranchDeletionAuthorized !== false
    || !Number.isSafeInteger(plan.physicalRepositoryId) || plan.physicalRepositoryId < 1
    || !GIT_SHA.test(plan.pinnedSourceCommitSha) || !GIT_SHA.test(input.expectedSourceTreeSha)) {
    throw new Error("Frozen backup recovery requires a blocked exact-commit backup plan.")
  }
  const source = splitRepoId(plan.sourceRepoId)
  const frozen = splitRepoId(plan.backupRepoId)
  const destination = splitRepoId(plan.destinationRepoId)
  if (source.fullName.toLowerCase() !== frozen.fullName.toLowerCase()
    || source.fullName.toLowerCase() !== destination.fullName.toLowerCase()
    || new Set([source.branch, frozen.branch, destination.branch]).size !== 3
    || frozen.branch !== plan.backupBranch || frozen.branch !== backup.branchName) {
    throw new Error("Frozen backup recovery branch/repository scope mismatch.")
  }
  const checkRepo = async (): Promise<void> => {
    throwIfV4Aborted(input.signal)
    const identity = await backup.getRepositoryIdentity()
    throwIfV4Aborted(input.signal)
    if (identity.id !== plan.physicalRepositoryId
      || identity.fullName.toLowerCase() !== source.fullName.toLowerCase()) {
      throw new Error("Frozen backup recovery physical GitHub repository mismatch.")
    }
  }
  const checkDefault = async (): Promise<string> => {
    throwIfV4Aborted(input.signal)
    const currentDefault = await backup.getRepositoryDefaultBranch()
    throwIfV4Aborted(input.signal)
    assertSafeGitHubBranch(currentDefault)
    if (currentDefault === frozen.branch || currentDefault === destination.branch) {
      throw new Error("Frozen backup recovery cannot use GitHub default branch as backup/destination.")
    }
    return currentDefault
  }

  await checkRepo()
  const expectedDefault = await checkDefault()
  const readRef = async () => {
    throwIfV4Aborted(input.signal)
    const ref = await backup.getGitRefOrNull()
    throwIfV4Aborted(input.signal)
    if (ref && (ref.ref !== `refs/heads/${frozen.branch}`
      || ref.type !== "commit" || !GIT_SHA.test(ref.sha))) {
      throw new Error("Frozen backup recovery found an invalid or unexpected Git ref.")
    }
    return ref
  }

  // Different observations (including 404 -> present) are INCONCLUSIVE,
  // never turn them into a recognized retry/create opportunity.
  const first = await readRef()
  const second = await readRef()
  if (first?.sha !== second?.sha) {
    throw new Error("Frozen backup Git ref changed between recovery observations.")
  }
  let outcome: V4FrozenBackupRecoveryOutcome
  let verifiedFileCount = 0
  let verifiedPlaintextBytes = "0"
  if (!second) {
    outcome = "ref-unobserved-at-two-checks"
  } else if (second.sha !== plan.pinnedSourceCommitSha) {
    outcome = "ref-occupied-by-other-commit"
  } else {
    const fullReadback = await verifyGitHubFrozenReencryptionBackup({
      github: backup,
      plan,
      expectedSourceTreeSha: input.expectedSourceTreeSha,
      passphrase: input.originalPassphrase,
      signal: input.signal,
    })
    throwIfV4Aborted(input.signal)
    const after = await readRef()
    if (!after || after.sha !== plan.pinnedSourceCommitSha) {
      throw new Error("Frozen backup Git ref changed during full readback.")
    }
    verifiedFileCount = fullReadback.verifiedFileCount
    verifiedPlaintextBytes = fullReadback.verifiedPlaintextBytes
    outcome = "matching-backup-full-readback"
  }
  await checkRepo()
  const finalDefault = await checkDefault()
  if (finalDefault !== expectedDefault) {
    throw new Error("Frozen backup GitHub default branch changed during recovery.")
  }
  const finalRef = await readRef()
  if (finalRef?.sha !== second?.sha) {
    throw new Error("Frozen backup Git ref changed during final repository proof.")
  }
  return Object.freeze({
    integrityScope: "ambiguous-backup-create-read-only-reconciliation",
    backupRepoId: plan.backupRepoId,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    outcome,
    backupContentsReadbackVerified: outcome === "matching-backup-full-readback",
    verifiedFileCount,
    verifiedPlaintextBytes,
    creationProven: false,
    automaticallyRetryCreateAuthorized: false,
    overwriteAuthorized: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
  })
}
