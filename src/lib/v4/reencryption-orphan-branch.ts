import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import { decodeV4RemoteConfig } from "./remote-index"

/**
 * Owner-approved topology A: fresh orphan (zero-parent) commit on a NEW
 * branch of the SAME physical GitHub repository. Source branch stays intact.
 *
 * This pure contract does not publish, create refs, migrate data or assert
 * that a complete backup / multi-device cutover has been verified.
 */
export interface V4OrphanReencryptionTopologyInput {
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly sourcePhysicalRepositoryId: number
  readonly destinationPhysicalRepositoryId: number
  readonly expectedPhysicalRepositoryId: number
  readonly defaultBranch: string
}

export interface V4OrphanReencryptionPlan {
  readonly kind: "same-repository-new-orphan-branch"
  readonly status: "blocked-pending-migration-implementation"
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly physicalRepositoryId: number
  readonly destinationBranch: string
}

/**
 * Two independent EXACT target-ref absence probes and stable source/physical
 * repository observations. These must be provided by trusted GitHub API reads.
 * A probe result is not an atomic CAS or permission to publish; GitHub's ref
 * creation must still fail on collision and unknown outcomes need reconciliation.
 */
export interface V4OrphanRefObservationsInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly observedSourceCommitShaBefore: unknown
  readonly observedSourceCommitShaAfter: unknown
  readonly destinationFirstObservation: unknown
  readonly destinationSecondObservation: unknown
  readonly observedPhysicalRepositoryIdBefore: number
  readonly observedPhysicalRepositoryIdAfter: number
}

export interface V4OrphanRefObservationsProof {
  readonly proof: "prepublication-ref-observations-only"
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly independentlyObservedAbsentCount: 2
}

export function assertV4OrphanDestinationRefObservations(
  input: V4OrphanRefObservationsInput,
): V4OrphanRefObservationsProof {
  if (input.plan.kind !== "same-repository-new-orphan-branch"
    || input.plan.status !== "blocked-pending-migration-implementation") {
    throw new Error("Re-encryption destination is not an approved orphan-branch plan.")
  }
  assertCommitSha(input.plan.pinnedSourceCommitSha, "pinned source commit SHA")
  if (input.observedSourceCommitShaBefore !== input.plan.pinnedSourceCommitSha
    || input.observedSourceCommitShaAfter !== input.plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption source branch HEAD changed or cannot be verified.")
  }
  if (input.destinationFirstObservation !== null || input.destinationSecondObservation !== null) {
    throw new Error("Re-encryption destination branch is present or its absence is ambiguous.")
  }
  assertPhysicalId(input.plan.physicalRepositoryId)
  if (input.observedPhysicalRepositoryIdBefore !== input.plan.physicalRepositoryId
    || input.observedPhysicalRepositoryIdAfter !== input.plan.physicalRepositoryId) {
    throw new Error("Re-encryption physical repository identity changed during preflight.")
  }
  return Object.freeze({
    proof: "prepublication-ref-observations-only",
    destinationRepoId: input.plan.destinationRepoId,
    pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
    independentlyObservedAbsentCount: 2,
  })
}

export interface V4OrphanRootProofInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly candidateCommit: {
    readonly sha: string
    readonly treeSha: string
    readonly parentShas: readonly string[]
  }
  readonly sourceTreeSha: string
  readonly sourceConfigBytes: Uint8Array
  readonly destinationConfigBytes: Uint8Array
}

export interface V4OrphanRootTopologyProof {
  readonly proof: "orphan-commit-topology-only"
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  readonly destinationTreeSha: string
  readonly parentCount: 0
}

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u

function parseRepoId(value: unknown): { owner: string; repo: string; branch: string; fullName: string } {
  if (typeof value !== "string") throw new Error("Invalid V4 re-encryption repository identity.")
  const parts = value.split("#")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid V4 re-encryption repository identity.")
  }
  const names = parts[0].split("/")
  if (names.length !== 2) throw new Error("Invalid V4 re-encryption repository coordinates.")
  const owner = names[0]!
  const repo = names[1]!
  const branch = parts[1]
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { owner, repo, branch, fullName: `${owner}/${repo}` }
}

function assertPhysicalId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid physical GitHub repository identity.")
  }
}

function assertCommitSha(sha: unknown, label: string): asserts sha is string {
  if (typeof sha !== "string" || !FULL_GIT_SHA.test(sha)) {
    throw new Error(`Re-encryption ${label} requires a full lowercase 40-character Git SHA.`)
  }
}

export function planV4OrphanReencryptionDestination(
  input: V4OrphanReencryptionTopologyInput,
): V4OrphanReencryptionPlan {
  const source = parseRepoId(input.sourceRepoId)
  const destination = parseRepoId(input.destinationRepoId)
  assertSafeGitHubBranch(input.defaultBranch)
  assertCommitSha(input.sourceCommitSha, "source commit SHA")
  for (const id of [input.sourcePhysicalRepositoryId, input.destinationPhysicalRepositoryId, input.expectedPhysicalRepositoryId]) {
    assertPhysicalId(id)
  }
  if (input.sourcePhysicalRepositoryId !== input.expectedPhysicalRepositoryId
    || input.destinationPhysicalRepositoryId !== input.expectedPhysicalRepositoryId) {
    throw new Error("Re-encryption source and destination must be the same approved physical GitHub repository.")
  }
  if (source.fullName.toLowerCase() !== destination.fullName.toLowerCase()) {
    throw new Error("Re-encryption destination must be a branch in the SAME GitHub repository.")
  }
  if (source.branch === destination.branch) {
    throw new Error("Re-encryption destination branch must be distinct from the source branch.")
  }
  if (destination.branch === input.defaultBranch) {
    throw new Error("Re-encryption destination cannot be the GitHub repository default branch.")
  }
  return Object.freeze({
    kind: "same-repository-new-orphan-branch",
    status: "blocked-pending-migration-implementation",
    sourceRepoId: input.sourceRepoId,
    destinationRepoId: input.destinationRepoId,
    pinnedSourceCommitSha: input.sourceCommitSha,
    physicalRepositoryId: input.expectedPhysicalRepositoryId,
    destinationBranch: destination.branch,
  })
}

/**
 * Confirms only proposed Git commit ROOT topology and new V4 encrypted
 * configuration. This is not an authenticity proof of reachable tree blobs.
 * A separate exact-commit/second-device full-content check remains mandatory.
 */
export function assertV4OrphanReencryptionRoot(
  input: V4OrphanRootProofInput,
): V4OrphanRootTopologyProof {
  const { plan, candidateCommit, sourceTreeSha } = input
  if (plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation") {
    throw new Error("Re-encryption orphan root requires the approved same-repository topology.")
  }
  const source = parseRepoId(plan.sourceRepoId)
  const destination = parseRepoId(plan.destinationRepoId)
  if (source.fullName.toLowerCase() !== destination.fullName.toLowerCase() || source.branch === destination.branch) {
    throw new Error("Re-encryption destination root has an invalid source/destination identity.")
  }
  assertPhysicalId(plan.physicalRepositoryId)
  assertCommitSha(plan.pinnedSourceCommitSha, "source commit SHA")
  assertCommitSha(candidateCommit.sha, "new root commit SHA")
  assertCommitSha(candidateCommit.treeSha, "new root tree SHA")
  assertCommitSha(sourceTreeSha, "source tree SHA")
  if (!Array.isArray(candidateCommit.parentShas) || candidateCommit.parentShas.length !== 0) {
    throw new Error("Re-encryption destination root commit must have zero parents and must not inherit source ancestry.")
  }
  if (candidateCommit.sha === plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption destination must have a fresh root commit SHA.")
  }
  if (candidateCommit.treeSha === sourceTreeSha) {
    throw new Error("Re-encryption destination root must not reuse source tree.")
  }

  const oldConfig = decodeV4RemoteConfig(input.sourceConfigBytes)
  const newConfig = decodeV4RemoteConfig(input.destinationConfigBytes)
  if (oldConfig.repoId !== plan.sourceRepoId
    || oldConfig.mode !== "encrypted" || oldConfig.pathLayout !== "opaque-stable-v1"
    || oldConfig.algorithm !== "AES-GCM" || oldConfig.kdf !== "PBKDF2-SHA-256" || !oldConfig.kdfParams) {
    throw new Error("Re-encryption source configuration does not match pinned encrypted V4 source.")
  }
  if (newConfig.repoId !== plan.destinationRepoId
    || newConfig.mode !== "encrypted" || newConfig.pathLayout !== "opaque-stable-v1"
    || newConfig.algorithm !== "AES-GCM" || newConfig.kdf !== "PBKDF2-SHA-256"
    || !newConfig.kdfParams) {
    throw new Error("Re-encryption destination requires new encrypted V4 configuration and repository identity.")
  }
  assertV4Pbkdf2Iterations(newConfig.kdfParams.iterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
  if (newConfig.kdfParams.salt === oldConfig.kdfParams.salt) {
    throw new Error("Re-encryption destination must generate a fresh KDF salt.")
  }
  return Object.freeze({
    proof: "orphan-commit-topology-only",
    destinationRepoId: plan.destinationRepoId,
    destinationCommitSha: candidateCommit.sha,
    destinationTreeSha: candidateCommit.treeSha,
    parentCount: 0,
  })
}
