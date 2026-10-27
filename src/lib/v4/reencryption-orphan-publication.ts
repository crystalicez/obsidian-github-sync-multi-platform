import { sha256Hex, utf8ToBytes } from "../bytes"
import type { GitHubClient } from "../github-api"
import type { GitHubCreateTreeEntry } from "../github-git-types"
import { throwIfV4Aborted } from "./cancellation"
import type { V4Keyring } from "./crypto"
import { assertV4ReencryptionJournalObjectReceipt } from "./reencryption-recovery-journal"
import type { V4ReencryptionStagingResult } from "./reencryption-staging-receipts"
import type { V4RemoteConfig, V4RemoteHead } from "./protocol-types"
import { assertV4OrphanReencryptionRoot, type V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import { assertV4RemoteRecordSet, buildV4RemoteMetadata } from "./remote-index"
import type { V4GitHubFrozenBackupVerificationReport } from "./reencryption-trusted-loader"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"
import { computeV4GitBlobSha1 } from "./git-blob-identity"

const SHA = /^[0-9a-f]{40}$/u
const SAFE_TOKEN = /^[A-Za-z0-9_-]{8,128}$/u

/** Internal writer: constructs Git objects but NEVER creates or changes a ref. */
type OrphanGitWriter = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" |
  "getGitRefOrNull" | "getGitCommit" | "getTreeAt" |
  "createGitBlob" | "createGitTree" | "createGitCommit">
type OrphanGitPublisher = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch" |
  "getGitRefOrNull" | "getGitCommit" | "createGitRef">

export interface V4OrphanStagedCommitInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly github: OrphanGitWriter
  readonly verifiedBackup: V4GitHubFrozenBackupVerificationReport
  readonly sourceConfig: V4RemoteConfig
  readonly destinationConfig: V4RemoteConfig
  readonly destinationKeyring: V4Keyring
  readonly sourceTreeSha: string
  readonly staged: V4ReencryptionStagingResult
  /** New device-only metadata. Must not use the source journalId. */
  readonly deviceId: string
  readonly journalId: string
  readonly createdAt: number
  readonly assertExclusiveMigrationLease: () => Promise<void>
  readonly signal?: AbortSignal | undefined
}

/** A non-authorizing, immutable Git root candidate. */
export interface V4PreparedOrphanCommit {
  readonly integrityScope: "unreferenced-encrypted-orphan-commit"
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly physicalRepositoryId: number
  readonly sourceTreeSha: string
  readonly treeSha: string
  readonly commitSha: string
  readonly verifiedFileCount: number
  readonly stagedCiphertextObjectCount: number
  readonly encryptedMetadataObjectCount: number
  readonly deviceId: string
  readonly journalId: string
  readonly createdAt: number
  readonly sourceAndBackupPreserved: true
  readonly rootHasZeroParents: true
  readonly backupProvenanceVerified: false
  readonly installedRestoreVerified: false
  readonly refPublished: false
  readonly cutoverAuthorized: false
}

function expectedFullName(plan: V4OrphanReencryptionPlan): string {
  const parts = plan.destinationRepoId.split("#")
  if (parts.length !== 2 || parts[1] !== plan.destinationBranch) {
    throw new Error("Re-encryption orphan writer destination branch identity mismatch.")
  }
  return parts[0]!
}

async function assertWriterIdentity(
  github: Pick<GitHubClient, "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch">,
  plan: V4OrphanReencryptionPlan,
  signal?: AbortSignal,
): Promise<void> {
  throwIfV4Aborted(signal)
  if (github.branchName !== plan.destinationBranch) {
    throw new Error("Re-encryption destination writer must be scoped to its exact orphan branch.")
  }
  const repo = await github.getRepositoryIdentity()
  throwIfV4Aborted(signal)
  if (!repo || repo.id !== plan.physicalRepositoryId
    || repo.fullName.toLowerCase() !== expectedFullName(plan).toLowerCase()) {
    throw new Error("Re-encryption destination writer physical GitHub repository identity mismatch.")
  }
  const defaultBranch = await github.getRepositoryDefaultBranch()
  throwIfV4Aborted(signal)
  if (defaultBranch === plan.destinationBranch) {
    throw new Error("Re-encryption destination must never be the GitHub default branch.")
  }
}

async function assertAbsent(
  github: Pick<GitHubClient, "getGitRefOrNull">, signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < 2; i++) {
    throwIfV4Aborted(signal)
    const ref = await github.getGitRefOrNull()
    throwIfV4Aborted(signal)
    if (ref !== null) throw new Error("Re-encryption destination branch is already present; refusing overwrite.")
  }
}

function validateBackup(
  plan: V4OrphanReencryptionPlan,
  proof: V4GitHubFrozenBackupVerificationReport,
  staged: V4ReencryptionStagingResult,
  expectedSourceTreeSha: string,
): void {
  if (!proof || proof.integrityScope !== "authenticated-frozen-backup-all-live-objects"
    || proof.backupContentsReadbackVerified !== true
    || proof.destinationPublicationAuthorized !== false || proof.cutoverAuthorized !== false
    || proof.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || proof.pinnedSourceTreeSha !== expectedSourceTreeSha
    || !proof.backupRepoId.startsWith(expectedFullName(plan) + "#")
    || proof.backupRepoId === plan.sourceRepoId
    || proof.backupRepoId === plan.destinationRepoId
    || proof.verifiedFileCount !== staged.preview.finalizedFileCount
    || proof.verifiedPlaintextBytes !== staged.preview.totalPlaintextBytes) {
    throw new Error("Re-encryption orphan commit requires full authenticated pinned backup parity.")
  }
}

function pathsOf(record: V4ReencryptionStagingResult["records"][number]): readonly string[] {
  return record.storage === "chunked" ? record.partPaths ?? [] : [record.remotePath]
}

/**
 * D96: Prepare actual encrypted metadata Git blobs, root Git tree and a
 * ZERO-PARENT orphan commit. Calls createGitBlob/tree/commit ONLY. These Git
 * objects are otherwise unreachable until a separate deliberate create-ref.
 *
 * Not connected to the Wizard. A real caller must supply a trusted, durable
 * migration journal and recovery lease; structural callback fakes are not
 * platform WAL proofs. A lost Git response is ambiguous; do not auto-retry
 * this high-level orchestration or assume an orphan root is reachable.
 */
export async function prepareV4ReencryptionOrphanCommit(
  input: V4OrphanStagedCommitInput,
): Promise<V4PreparedOrphanCommit> {
  const { plan, github, staged, sourceConfig, destinationConfig } = input
  const check = async () => {
    throwIfV4Aborted(input.signal)
    await input.assertExclusiveMigrationLease()
    throwIfV4Aborted(input.signal)
  }
  await check()
  if (plan?.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || !SHA.test(plan.pinnedSourceCommitSha) || !SHA.test(input.sourceTreeSha)
    || !SAFE_TOKEN.test(input.deviceId) || !SAFE_TOKEN.test(input.journalId)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 1
    || sourceConfig.repoId !== plan.sourceRepoId
    || destinationConfig.repoId !== plan.destinationRepoId
    || destinationConfig.mode !== "encrypted" || sourceConfig.mode !== "encrypted"
    || destinationConfig.kdfParams?.salt === sourceConfig.kdfParams?.salt) {
    throw new Error("Re-encryption orphan commit plan, encryption or metadata inputs are invalid.")
  }
  if (!staged || staged.preview.integrityScope !== "staged-immutable-blobs-only"
    || staged.preview.permissionToPublish !== false || staged.preview.cutoverAuthorized !== false
    || staged.preview.backupVerified !== false || staged.preview.destinationReadbackVerified !== false
    || staged.preview.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || staged.preview.destinationRepoId !== plan.destinationRepoId
    || !Array.isArray(staged.records) || !Array.isArray(staged.receipts)
    || staged.records.length !== staged.preview.finalizedFileCount
    || staged.receipts.length !== staged.preview.validatedReceiptCount) {
    throw new Error("Re-encryption orphan commit requires finalized staged ciphertext evidence.")
  }
  validateBackup(plan, input.verifiedBackup, staged, input.sourceTreeSha)
  await assertV4RemoteRecordSet([...staged.records], destinationConfig, input.destinationKeyring)
  const byBucket = new Map<string, typeof staged.records[number][]>()
  const objectPaths = new Set<string>()
  for (const record of staged.records) {
    if (record.deleted || record.dirty) {
      throw new Error("Re-encryption orphan commit cannot retain dirty/deleted files.")
    }
    const bucket = record.pathId.slice(0, 2)
    const values = byBucket.get(bucket) ?? []
    values.push(record)
    byBucket.set(bucket, values)
    for (const path of pathsOf(record)) {
      if (objectPaths.has(path)) throw new Error("Re-encryption orphan destination duplicated an object path.")
      objectPaths.add(path)
    }
  }
  const receipts = new Map<string, string>()
  for (const receipt of staged.receipts) {
    assertV4ReencryptionJournalObjectReceipt(receipt)
    if (receipts.has(receipt.path) || !objectPaths.has(receipt.path)) {
      throw new Error("Re-encryption orphan staged receipt is duplicate or unexpected.")
    }
    receipts.set(receipt.path, receipt.sha)
  }
  if (objectPaths.size !== receipts.size) {
    throw new Error("Re-encryption orphan is missing staged ciphertext receipts.")
  }
  const hashes: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [bucket, records] of byBucket) {
    records.sort((a, b) => a.pathId.localeCompare(b.pathId))
    hashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify(records)))
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    deviceId: input.deviceId, journalId: input.journalId,
    updatedAt: input.createdAt, shardHashes: hashes,
  }
  const metadata = await buildV4RemoteMetadata({
    config: destinationConfig, head, records: [...staged.records],
    keyring: input.destinationKeyring,
  })
  const paths = new Set(receipts.keys())
  for (const file of metadata) {
    if (paths.has(file.path) || file.bytes.byteLength < 1
      || file.bytes.byteLength > V4_GITHUB_REST_SAFE_WRITER_BYTES) {
      throw new Error("Re-encryption orphan metadata collided with ciphertext or exceeded transport limit.")
    }
    paths.add(file.path)
  }
  await assertWriterIdentity(github, plan, input.signal)
  await assertAbsent(github, input.signal)
  await check()
  const entries: GitHubCreateTreeEntry[] = [...receipts].map(([path, sha]) =>
    ({ path, sha, type: "blob" as const, mode: "100644" as const }))
  for (const file of metadata) {
    await check()
    const expected = computeV4GitBlobSha1(file.bytes)
    const actual = await github.createGitBlob(file.bytes)
    throwIfV4Aborted(input.signal)
    if (actual !== expected || computeV4GitBlobSha1(file.bytes) !== expected) {
      throw new Error("Re-encryption orphan metadata Git blob SHA or contents changed.")
    }
    entries.push({ path: file.path, sha: actual, type: "blob", mode: "100644" })
  }
  await check()
  // CRITICAL: NO base_tree supplied and NO source commit parents.
  const treeSha = await github.createGitTree(entries)
  if (!SHA.test(treeSha)) throw new Error("Re-encryption orphan root tree SHA is malformed.")
  await check()
  const commitSha = await github.createGitCommit(
    "obsidian-sync-v4:re-encrypted-orphan-root",
    treeSha, [], { originalCannotBeReachable: true },
  )
  if (!SHA.test(commitSha) || commitSha === plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption orphan root commit SHA is malformed or reused.")
  }
  const candidate = await github.getGitCommit(commitSha)
  throwIfV4Aborted(input.signal)
  const expectedMetadataConfig = metadata.find(x => x.path === ".obsidian-github-sync-v4/config.json")
  if (!expectedMetadataConfig) throw new Error("Re-encryption orphan root has no committed config.")
  assertV4OrphanReencryptionRoot({
    plan, candidateCommit: candidate, sourceTreeSha: input.sourceTreeSha,
    sourceConfigBytes: utf8ToBytes(JSON.stringify(sourceConfig)),
    destinationConfigBytes: expectedMetadataConfig.bytes,
  })
  if (candidate.treeSha !== treeSha) throw new Error("Re-encryption orphan candidate root tree differs.")
  const storedTree = await github.getTreeAt(treeSha, true)
  throwIfV4Aborted(input.signal)
  if (storedTree.sha !== treeSha || storedTree.truncated !== false || !Array.isArray(storedTree.tree)) {
    throw new Error("Re-encryption orphan tree readback is incomplete.")
  }
  const observed = new Map<string, string>()
  for (const entry of storedTree.tree) {
    if (entry.type !== "blob" || entry.mode !== "100644" || observed.has(entry.path) || !SHA.test(entry.sha)) {
      throw new Error("Re-encryption orphan contains unexpected Git tree entries.")
    }
    observed.set(entry.path, entry.sha)
  }
  if (observed.size !== entries.length || entries.some(entry => observed.get(entry.path) !== entry.sha)) {
    throw new Error("Re-encryption orphan tree readback is missing, duplicated or substituted.")
  }
  await assertAbsent(github, input.signal)
  await assertWriterIdentity(github, plan, input.signal)
  await check()
  return Object.freeze({
    integrityScope: "unreferenced-encrypted-orphan-commit",
    destinationRepoId: plan.destinationRepoId,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    physicalRepositoryId: plan.physicalRepositoryId,
    sourceTreeSha: input.sourceTreeSha, treeSha, commitSha,
    verifiedFileCount: staged.records.length,
    stagedCiphertextObjectCount: staged.receipts.length,
    encryptedMetadataObjectCount: metadata.length,
    deviceId: input.deviceId, journalId: input.journalId,
    createdAt: input.createdAt,
    sourceAndBackupPreserved: true,
    rootHasZeroParents: true,
    backupProvenanceVerified: false,
    installedRestoreVerified: false,
    refPublished: false,
    cutoverAuthorized: false,
  })
}

/**
 * D96 low-level create-ONLY ref operation. A caller MUST write a crash-durable
 * publication intent before invoking this, and reconcile an ambiguous API
 * outcome by reads, never retry blindly. Excluded from the GUI until D86 WAL.
 */
export async function publishV4ReencryptionOrphanRef(input: {
  readonly github: OrphanGitPublisher
  readonly plan: V4OrphanReencryptionPlan
  readonly prepared: V4PreparedOrphanCommit
  /** Required external fail-closed durability/lease boundary (not implemented by this helper). */
  readonly assertDurablePublicationIntent: () => Promise<void>
  readonly assertExclusiveMigrationLease: () => Promise<void>
  readonly signal?: AbortSignal | undefined
}): Promise<{
  readonly status: "destination-ref-create-confirmed"
  readonly commitSha: string
  readonly originalSourceBranchUnchangedByThisOperation: true
  readonly destinationContentReadbackVerified: false
  readonly installedRestoreVerified: false
  readonly cutoverAuthorized: false
}> {
  const { plan, prepared, github, signal } = input
  throwIfV4Aborted(signal)
  if (!prepared || prepared.integrityScope !== "unreferenced-encrypted-orphan-commit"
    || prepared.refPublished !== false || prepared.cutoverAuthorized !== false
    || prepared.destinationRepoId !== plan.destinationRepoId
    || prepared.pinnedSourceCommitSha !== plan.pinnedSourceCommitSha
    || prepared.physicalRepositoryId !== plan.physicalRepositoryId
    || !SHA.test(prepared.commitSha) || !SHA.test(prepared.treeSha)
    || prepared.rootHasZeroParents !== true) {
    throw new Error("Re-encryption orphan publication requires the verified unreferenced candidate.")
  }
  // TypeScript readonly is not a runtime proof. A recovered or caller-built
  // candidate may be mutable even when normal preparation returns a frozen
  // object. Pin the exact verified identity before any asynchronous reads.
  const pinnedPrepared = Object.freeze({ ...prepared })
  const pinnedIdentity = JSON.stringify(pinnedPrepared)
  const assertCandidateUnchanged = () => {
    if (JSON.stringify(prepared) !== pinnedIdentity) {
      throw new Error("Re-encryption prepared candidate changed after validation; refusing Git ref mutation.")
    }
  }
  await input.assertExclusiveMigrationLease()
  await assertWriterIdentity(github, plan, signal)
  await assertAbsent(github, signal)
  const commit = await github.getGitCommit(pinnedPrepared.commitSha)
  throwIfV4Aborted(signal)
  if (commit.sha !== pinnedPrepared.commitSha || commit.treeSha !== pinnedPrepared.treeSha
    || commit.parentShas.length !== 0) {
    throw new Error("Re-encryption orphan publication root ancestry/commit changed.")
  }
  assertCandidateUnchanged()
  await input.assertDurablePublicationIntent()
  throwIfV4Aborted(signal)
  await input.assertExclusiveMigrationLease()
  await assertAbsent(github, signal)
  await assertWriterIdentity(github, plan, signal)
  throwIfV4Aborted(signal)
  // Never send a commit SHA that differs from the root we authenticated
  // before WAL intent; no awaited work between final check and Git POST.
  assertCandidateUnchanged()
  // Ambiguous HTTP response must propagate. Exactly ONE create attempt.
  await github.createGitRef(pinnedPrepared.commitSha)
  throwIfV4Aborted(signal)
  for (let i = 0; i < 2; i++) {
    const ref = await github.getGitRefOrNull()
    throwIfV4Aborted(signal)
    if (!ref || ref.ref !== `refs/heads/${plan.destinationBranch}`
      || ref.type !== "commit" || ref.sha !== pinnedPrepared.commitSha) {
      throw new Error("Re-encryption orphan destination ref publication is not confirmed.")
    }
  }
  await assertWriterIdentity(github, plan, signal)
  assertCandidateUnchanged()
  return Object.freeze({
    status: "destination-ref-create-confirmed",
    commitSha: pinnedPrepared.commitSha,
    originalSourceBranchUnchangedByThisOperation: true,
    destinationContentReadbackVerified: false,
    installedRestoreVerified: false,
    cutoverAuthorized: false,
  })
}
