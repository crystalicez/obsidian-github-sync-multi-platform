import type { GitHubClient, GitHubRepositoryIdentity } from "../github-api"
import type { GitHubGitCommit } from "../github-git-types"
import { throwIfV4Aborted } from "./cancellation"
import type { V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"

/**
 * D93: guarded create-ONLY of the frozen Git ref for the already authenticated
 * source snapshot. NOT connected to the UI or production Sync.
 *
 * Successful pointer publication is NOT full backup-content readback, installed
 * Obsidian restore or permission to publish a destination/cut over. The source
 * branch is NEVER paused or moved; it may legitimately advance from the pinned
 * snapshot after verification, per D90.
 */
type SourceReader = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" | "getGitCommit">
type BackupWriter = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" | "getGitRefOrNull" | "getGitCommit" | "createGitRef">

export interface V4FrozenBackupRefCreationInput {
  readonly plan: V4SameRepoReencryptionBackupBranchProposal
  readonly verifiedSource: V4ReencryptionVerifiedSource
  readonly source: SourceReader
  readonly backup: BackupWriter
  /** Expected immutable tree SHA from a trusted, SHA-pinned Git read. */
  readonly expectedSourceTreeSha: string
  readonly signal?: AbortSignal | undefined
}

export interface V4FrozenBackupRefCreationReport {
  readonly integrityScope: "created-pinned-backup-ref-pointer-only"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly pinnedSourceTreeSha: string
  readonly backupRefCreatedAndReadBack: true
  readonly backupContentsReadbackVerified: false
  readonly installedObsidianRestoreVerified: false
  readonly independentStorageVerified: false
  readonly destinationPublicationAuthorized: false
  readonly cutoverAuthorized: false
  readonly sourceBranchPreserved: true
  readonly oldBranchDeletionAuthorized: false
}

const SHA = /^[a-f0-9]{40}$/u
const repoNameOf = (id: string): string => {
  if (typeof id !== "string" || !/^[^#/]+\/[^#/]+#[^#]+$/u.test(id)) {
    throw new Error("Frozen backup ref has invalid repository identity.")
  }
  return id.split("#")[0]!
}
const branchOf = (id: string): string => id.slice(id.indexOf("#") + 1)

function assertPhysical(identity: GitHubRepositoryIdentity, expectedId: number, name: string): void {
  if (!identity || identity.id !== expectedId || identity.fullName?.toLowerCase() !== name.toLowerCase()) {
    throw new Error("Frozen backup GitHub physical repository identity mismatch.")
  }
}

function assertCommit(value: GitHubGitCommit, pinned: string, treeSha: string): void {
  if (!value || value.sha !== pinned || value.treeSha !== treeSha
    || !Array.isArray(value.parentShas)
    || value.parentShas.some(parent => !SHA.test(parent))) {
    throw new Error("Frozen backup exact-commit tree or ancestry mismatch.")
  }
}

export async function createV4FrozenSameRepositoryBackupRef(
  input: V4FrozenBackupRefCreationInput,
): Promise<V4FrozenBackupRefCreationReport> {
  throwIfV4Aborted(input.signal)
  const { plan, verifiedSource, expectedSourceTreeSha: tree } = input
  if (!plan || plan.proof !== "owner-approved-same-repo-backup-topology-only"
    || plan.status !== "blocked-pending-safe-backup-ref-implementation"
    || plan.actualBackupCreated !== false || plan.permissionToPublish !== false
    || plan.oldBranchDeletionAuthorized !== false
    || !Number.isSafeInteger(plan.physicalRepositoryId) || plan.physicalRepositoryId < 1
    || !SHA.test(plan.pinnedSourceCommitSha) || !SHA.test(tree)
    || !verifiedSource || verifiedSource.integrityScope !== "all-live-objects"
    || verifiedSource.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || !Number.isSafeInteger(verifiedSource.verifiedFileCount) || verifiedSource.verifiedFileCount < 0
    || !/^(?:0|[1-9][0-9]*)$/u.test(verifiedSource.totalVerifiedPlaintextBytes)) {
    throw new Error("Frozen backup requires an authenticated pinned source and blocked 3-branch proposal.")
  }
  const fullName = repoNameOf(plan.sourceRepoId)
  if (repoNameOf(plan.backupRepoId).toLowerCase() !== fullName.toLowerCase()
    || repoNameOf(plan.destinationRepoId).toLowerCase() !== fullName.toLowerCase()) {
    throw new Error("Frozen backup must stay in the same physical GitHub repository.")
  }
  const sourceBranch = branchOf(plan.sourceRepoId)
  const backupBranch = branchOf(plan.backupRepoId)
  const destinationBranch = branchOf(plan.destinationRepoId)
  if (input.source.branchName !== sourceBranch || input.backup.branchName !== backupBranch) {
    throw new Error("Frozen backup GitHub client is scoped to the wrong source or backup branch.")
  }
  if (!backupBranch || !destinationBranch || backupBranch === sourceBranch
    || backupBranch === destinationBranch || backupBranch !== plan.backupBranch
    || destinationBranch === sourceBranch) {
    throw new Error("Frozen backup source, backup and destination refs must be distinct.")
  }
  const checkIdentity = async (client: SourceReader | BackupWriter) => {
    throwIfV4Aborted(input.signal)
    const identity = await client.getRepositoryIdentity()
    throwIfV4Aborted(input.signal)
    assertPhysical(identity, plan.physicalRepositoryId, fullName)
  }
  await checkIdentity(input.source)
  await checkIdentity(input.backup)
  throwIfV4Aborted(input.signal)
  const sourceDefault = await input.source.getRepositoryDefaultBranch()
  throwIfV4Aborted(input.signal)
  const backupDefault = await input.backup.getRepositoryDefaultBranch()
  throwIfV4Aborted(input.signal)
  if (sourceDefault !== backupDefault || sourceDefault === backupBranch || sourceDefault === destinationBranch) {
    throw new Error("Frozen backup default branch changed or conflicts with the backup/destination.")
  }

  const pinned = plan.pinnedSourceCommitSha
  const commit = await input.source.getGitCommit(pinned)
  throwIfV4Aborted(input.signal)
  assertCommit(commit, pinned, tree)
  // Two read probes are non-atomic; an exact create-ONLY POST must still reject
  // any ref that was created after either probe. NEVER update or force a ref.
  for (let probe = 0; probe < 2; probe++) {
    throwIfV4Aborted(input.signal)
    const existing = await input.backup.getGitRefOrNull()
    throwIfV4Aborted(input.signal)
    if (existing !== null) {
      throw new Error("Frozen backup branch already exists; refusing to replace it.")
    }
  }
  // A lost response is AMBIGUOUS. Do not retry this mutation. Any partial or
  // uncertain result leaves the ref for a separate manual recovery/readback.
  throwIfV4Aborted(input.signal)
  if (input.backup.branchName !== backupBranch) {
    throw new Error("Frozen backup GitHub branch scope changed before ref creation.")
  }
  await input.backup.createGitRef(pinned)
  throwIfV4Aborted(input.signal)

  for (let probe = 0; probe < 2; probe++) {
    const observed = await input.backup.getGitRefOrNull()
    throwIfV4Aborted(input.signal)
    if (!observed || observed.ref !== `refs/heads/${backupBranch}`
      || observed.type !== "commit" || observed.sha !== pinned) {
      throw new Error("Frozen backup Git ref publication cannot be confirmed.")
    }
  }
  const committed = await input.backup.getGitCommit(pinned)
  throwIfV4Aborted(input.signal)
  assertCommit(committed, pinned, tree)
  if (committed.parentShas.length !== commit.parentShas.length
    || committed.parentShas.some((sha, index) => sha !== commit.parentShas[index])) {
    throw new Error("Frozen backup and source exact Git commit ancestry mismatch.")
  }
  await checkIdentity(input.source)
  await checkIdentity(input.backup)
  // A ref could have moved between observations; no CAS lock exists. Full
  // restore/readback and destination cutover stay blocked by separate gates.
  return Object.freeze({
    integrityScope: "created-pinned-backup-ref-pointer-only",
    backupRepoId: plan.backupRepoId,
    pinnedSourceCommitSha: pinned,
    pinnedSourceTreeSha: tree,
    backupRefCreatedAndReadBack: true,
    backupContentsReadbackVerified: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
    sourceBranchPreserved: true,
    oldBranchDeletionAuthorized: false,
  })
}
