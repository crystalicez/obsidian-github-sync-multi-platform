import type { GitHubClient } from "../github-api"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"

type ReadOnlyGit = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" | "getGitRef" | "getGitCommit">

export interface V4ReencryptionCandidateGitRefsInput {
  /** A local, UNTRUSTED saved candidate. This check does not authenticate it. */
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly backupGit: ReadOnlyGit
  readonly destinationGit: ReadOnlyGit
  readonly assertLiveOwner: () => void
}

export interface V4ReencryptionCandidateGitRefsReport {
  readonly integrityScope: "read-only-untrusted-remote-ref-topology"
  readonly observation: "candidate-remote-refs-observed-untrusted" | "manual-recovery-required"
  readonly destinationOrphanTopologyObserved: boolean
  readonly backupContentsAuthenticated: false
  readonly fullDestinationContentsReverified: false
  readonly walAuthenticated: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-untrusted-remote-ref-topology" as const,
  backupContentsAuthenticated: false as const,
  fullDestinationContentsReverified: false as const,
  walAuthenticated: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ReencryptionCandidateGitRefsReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  destinationOrphanTopologyObserved: false,
})

/**
 * Check only the candidate's remote topology: two refs, exact pinned commit
 * trees, orphan destination, shared physical repository, stable default branch.
 * No local contract MAC, file decryption, WAL, Backup content or Sync authority
 * is inferred from a matching Git ref. D248 still requires all independent proofs.
 */
export async function inspectV4ReencryptionCandidateGitRefs(
  input: V4ReencryptionCandidateGitRefsInput,
): Promise<V4ReencryptionCandidateGitRefsReport> {
  try {
    const { contract, backupGit, destinationGit, assertLiveOwner } = input
    if (!contract || !backupGit || !destinationGit
      || backupGit === destinationGit || typeof assertLiveOwner !== "function") return MANUAL
    assertV4ReencryptionCutoverSnapshotContract(contract)
    const id = contract.identity
    const [sourceRepo, sourceBranch] = id.sourceRepoId.split("#")
    const [backupRepo, backupBranch] = id.backupRepoId.split("#")
    const [destinationRepo, destinationBranch] = id.destinationRepoId.split("#")
    if (!sourceRepo || !sourceBranch || !backupBranch || !destinationBranch
      || sourceRepo !== backupRepo || sourceRepo !== destinationRepo
      || backupGit.branchName !== backupBranch
      || destinationGit.branchName !== destinationBranch) return MANUAL

    const contractText = JSON.stringify(contract)
    const pinned = {
      backup: {
        repo: backupGit.getRepositoryIdentity,
        branch: backupGit.branchName, defaultBranch: backupGit.getRepositoryDefaultBranch,
        ref: backupGit.getGitRef, commit: backupGit.getGitCommit,
      },
      destination: {
        repo: destinationGit.getRepositoryIdentity,
        branch: destinationGit.branchName, defaultBranch: destinationGit.getRepositoryDefaultBranch,
        ref: destinationGit.getGitRef, commit: destinationGit.getGitCommit,
      },
    }
    const check = () => {
      assertLiveOwner()
      if (input.contract !== contract || JSON.stringify(contract) !== contractText
        || input.backupGit !== backupGit || input.destinationGit !== destinationGit
        || input.assertLiveOwner !== assertLiveOwner
        || backupGit.getRepositoryIdentity !== pinned.backup.repo
        || backupGit.getRepositoryDefaultBranch !== pinned.backup.defaultBranch
        || backupGit.getGitRef !== pinned.backup.ref
        || backupGit.getGitCommit !== pinned.backup.commit
        || backupGit.branchName !== pinned.backup.branch
        || destinationGit.getRepositoryIdentity !== pinned.destination.repo
        || destinationGit.getRepositoryDefaultBranch !== pinned.destination.defaultBranch
        || destinationGit.getGitRef !== pinned.destination.ref
        || destinationGit.getGitCommit !== pinned.destination.commit
        || destinationGit.branchName !== pinned.destination.branch) {
        throw Error("D251 GitHub Backup/Destination owner or candidate changed.")
      }
    }
    const scan = async () => {
      check()
      const backupRepoIdentity = await pinned.backup.repo.call(backupGit)
      check()
      const destinationRepoIdentity = await pinned.destination.repo.call(destinationGit)
      check()
      const backupDefault = await pinned.backup.defaultBranch.call(backupGit)
      check()
      const destinationDefault = await pinned.destination.defaultBranch.call(destinationGit)
      check()
      const backupRef = await pinned.backup.ref.call(backupGit)
      check()
      const destinationRef = await pinned.destination.ref.call(destinationGit)
      check()
      const backupCommit = await pinned.backup.commit.call(backupGit, id.sourceCommitSha)
      check()
      const destinationCommit = await pinned.destination.commit.call(destinationGit, id.destinationCommitSha)
      check()
      if (!Number.isSafeInteger(backupRepoIdentity.id) || backupRepoIdentity.id <= 0
        || destinationRepoIdentity.id !== backupRepoIdentity.id
        || backupRepoIdentity.fullName.toLowerCase() !== sourceRepo.toLowerCase()
        || destinationRepoIdentity.fullName !== backupRepoIdentity.fullName
        || backupDefault !== destinationDefault
        || backupDefault === backupBranch || backupDefault === destinationBranch
        || backupRef.ref !== "refs/heads/" + backupBranch || backupRef.type !== "commit"
        || backupRef.sha !== id.sourceCommitSha
        || destinationRef.ref !== "refs/heads/" + destinationBranch
        || destinationRef.type !== "commit" || destinationRef.sha !== id.destinationCommitSha
        || backupCommit.sha !== id.sourceCommitSha || backupCommit.treeSha !== id.sourceTreeSha
        || destinationCommit.sha !== id.destinationCommitSha
        || destinationCommit.treeSha !== id.destinationTreeSha
        || !Array.isArray(destinationCommit.parentShas)
        || destinationCommit.parentShas.length !== 0) {
        throw Error("D251 local candidate and remote Git ref topology differ.")
      }
      return JSON.stringify({ backupRepoIdentity, backupDefault, destinationRef, backupRef,
        backupCommit, destinationCommit })
    }
    const before = await scan()
    check()
    if (await scan() !== before) return MANUAL
    check()
    return Object.freeze({
      ...BASE, observation: "candidate-remote-refs-observed-untrusted" as const,
      destinationOrphanTopologyObserved: true,
    })
  } catch {
    return MANUAL
  }
}
