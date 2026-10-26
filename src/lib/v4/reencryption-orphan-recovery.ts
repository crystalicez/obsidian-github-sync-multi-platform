import { assertSafeGitHubBranch } from "../github-config"
import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import type { V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import {
  verifyV4ReencryptionDestinationExactCommit,
  type V4ReencryptionDestinationExactCommitInput,
} from "./reencryption-destination-exact-commit"
import type { V4PreparedOrphanCommit } from "./reencryption-orphan-publication"

const SHA = /^[a-f0-9]{40}$/u

/** Deliberately provides no create, update or delete GitHub method. */
export type V4OrphanRecoveryReader = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" |
  "getGitRef" | "getGitRefOrNull" | "getGitCommit" | "getTreeAt" | "getBlob"
>

export interface V4OrphanPublicationRecoveryInput extends Omit<V4ReencryptionDestinationExactCommitInput,
  "github" | "destinationCommitSha" | "plan"> {
  readonly github: V4OrphanRecoveryReader
  readonly plan: V4OrphanReencryptionPlan
  readonly prepared: V4PreparedOrphanCommit
}

export type V4OrphanRecoveryOutcome =
  | "destination-not-observed"
  | "destination-occupied-by-unexpected-commit"
  | "destination-pinned-and-fully-verified"

export interface V4OrphanPublicationRecoveryReport {
  readonly integrityScope: "read-only-orphan-ref-and-complete-ciphertext-reconciliation"
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly expectedOrphanCommitSha: string
  readonly outcome: V4OrphanRecoveryOutcome
  readonly destinationContentsVerified: boolean
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly refPublicationProvenByThisRun: false
  readonly automaticallyRetryCreateAuthorized: false
  readonly overwriteAuthorized: false
  readonly backupRestoreVerified: false
  readonly localCutoverAuthorized: false
}

/**
 * D97. Use after an ambiguous ref creation response or crash.
 *
 * Two consistent absent observations are NOT a proof that it is safe to
 * create/retry a ref. An exact matching ref is authenticated by fully reading
 * and decrypting the published orphan Git commit and every live file, and
 * checking the branch ref again. A wrong key/blob/ref is an ERROR, never a
 * partial success. The result is read-only evidence, NOT a cutover token.
 *
 * This deliberately does not check the old Source branch HEAD: it is allowed
 * to advance independently per D90.
 */
export async function inspectV4ReencryptionOrphanAfterAmbiguousPublication(
  input: V4OrphanPublicationRecoveryInput,
): Promise<V4OrphanPublicationRecoveryReport> {
  throwIfV4Aborted(input.signal)
  const { plan, prepared, github } = input
  if (!plan || plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || !prepared || prepared.integrityScope !== "unreferenced-encrypted-orphan-commit"
    || prepared.destinationRepoId !== plan.destinationRepoId
    || prepared.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || prepared.physicalRepositoryId !== plan.physicalRepositoryId
    || prepared.sourceTreeSha !== input.sourceTreeSha
    || !SHA.test(prepared.treeSha) || !SHA.test(prepared.commitSha)
    || !SHA.test(plan.pinnedSourceCommitSha)
    || prepared.refPublished !== false || prepared.rootHasZeroParents !== true
    || prepared.cutoverAuthorized !== false || prepared.sourceAndBackupPreserved !== true
    || prepared.verifiedFileCount !== input.expectedRecords.length
    || prepared.stagedCiphertextObjectCount !== input.expectedReceipts.length) {
    throw new Error("Re-encryption orphan recovery requires an exact approved unpublished candidate.")
  }
  const selected = plan.destinationRepoId.split("#")
  const fullName = selected[0]
  if (selected.length !== 2 || selected[1] !== plan.destinationBranch
    || !fullName || fullName.split("/").length !== 2
    || github.branchName !== plan.destinationBranch) {
    throw new Error("Re-encryption orphan recovery wrong repository or branch scope.")
  }
  assertSafeGitHubBranch(plan.destinationBranch)
  const ensureRepo = async () => {
    throwIfV4Aborted(input.signal)
    const identity = await github.getRepositoryIdentity()
    throwIfV4Aborted(input.signal)
    if (!identity || identity.id !== plan.physicalRepositoryId
      || identity.fullName.toLowerCase() !== fullName.toLowerCase()) {
      throw new Error("Re-encryption orphan recovery physical GitHub repository mismatch.")
    }
  }
  const ensureDefault = async (): Promise<string> => {
    throwIfV4Aborted(input.signal)
    const branch = await github.getRepositoryDefaultBranch()
    throwIfV4Aborted(input.signal)
    assertSafeGitHubBranch(branch)
    if (branch === plan.destinationBranch) {
      throw new Error("Re-encryption orphan destination cannot be the GitHub default branch.")
    }
    return branch
  }
  const readRef = async () => {
    throwIfV4Aborted(input.signal)
    const ref = await github.getGitRefOrNull()
    throwIfV4Aborted(input.signal)
    if (ref && (ref.ref !== `refs/heads/${plan.destinationBranch}`
      || ref.type !== "commit" || !SHA.test(ref.sha))) {
      throw new Error("Re-encryption orphan recovery returned malformed or wrong Git ref.")
    }
    return ref?.sha ?? null
  }
  await ensureRepo()
  const defaultBranch = await ensureDefault()
  const first = await readRef()
  const second = await readRef()
  if (first !== second) {
    throw new Error("Re-encryption orphan ref changed between recovery observations.")
  }
  let outcome: V4OrphanRecoveryOutcome
  let fileCount = 0
  let bytes = "0"
  if (second === null) {
    outcome = "destination-not-observed"
  } else if (second !== prepared.commitSha) {
    outcome = "destination-occupied-by-unexpected-commit"
  } else {
    // Both observations match the orphan candidate. The full verifier must
    // re-authenticate exact reachable metadata/blob set with the NEW key.
    const verified = await verifyV4ReencryptionDestinationExactCommit({
      github, plan,
      destinationCommitSha: prepared.commitSha,
      sourceTreeSha: input.sourceTreeSha,
      sourceConfig: input.sourceConfig,
      expectedDestinationConfig: input.expectedDestinationConfig,
      expectedRecords: input.expectedRecords,
      expectedReceipts: input.expectedReceipts,
      destinationPassphrase: input.destinationPassphrase,
      signal: input.signal,
    })
    throwIfV4Aborted(input.signal)
    if (verified.integrityScope !== "exact-orphan-commit-all-live-content"
      || verified.cutoverAuthorized !== false || verified.permissionToPublish !== false
      || verified.destinationCommitSha !== prepared.commitSha
      || verified.verifiedFileCount !== prepared.verifiedFileCount
      || verified.verifiedRemoteObjectCount !== prepared.stagedCiphertextObjectCount) {
      throw new Error("Re-encryption orphan full-content recovery report is incomplete.")
    }
    const after = await readRef()
    if (after !== prepared.commitSha) {
      throw new Error("Re-encryption orphan ref moved during content recovery.")
    }
    fileCount = verified.verifiedFileCount
    bytes = verified.totalVerifiedPlaintextBytes
    outcome = "destination-pinned-and-fully-verified"
  }
  await ensureRepo()
  const laterDefault = await ensureDefault()
  if (laterDefault !== defaultBranch) {
    throw new Error("Re-encryption orphan GitHub default branch changed during recovery.")
  }
  const finalRef = await readRef()
  if (finalRef !== first) {
    throw new Error("Re-encryption orphan ref changed during recovery final observation.")
  }
  return Object.freeze({
    integrityScope: "read-only-orphan-ref-and-complete-ciphertext-reconciliation",
    destinationRepoId: plan.destinationRepoId,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    expectedOrphanCommitSha: prepared.commitSha,
    outcome,
    destinationContentsVerified: outcome === "destination-pinned-and-fully-verified",
    verifiedFileCount: fileCount,
    verifiedPlaintextBytes: bytes,
    refPublicationProvenByThisRun: false,
    automaticallyRetryCreateAuthorized: false,
    overwriteAuthorized: false,
    backupRestoreVerified: false,
    localCutoverAuthorized: false,
  })
}
