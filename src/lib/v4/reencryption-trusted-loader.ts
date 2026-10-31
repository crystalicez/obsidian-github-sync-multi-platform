import { fromBase64Url } from "../bytes"
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import type { GitHubClient, GitHubRepositoryIdentity, GitHubTree } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { readImmutableGitFile } from "./immutable-git-read"
import { verifyV4ReencryptionSourceObjects, type V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"
import { decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, v4RemoteShardPath, type V4RemoteShard } from "./remote-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH } from "./protocol-types"
import type { V4SameRepoReencryptionBackupBranchProposal } from "./reencryption-owner-decisions"

/**
 * Trusted read-only bridge between the public GitHub Git API and D69's
 * all-live-object verifier. Uses immutable commit/tree/blob lookups ONLY.
 *
 * A passed GitHub client must be scoped to the exact, already-approved repo
 * and branch. This is not a migration/rotation/cutover entrypoint.
 */
export interface V4GitHubReencryptionSourceInput {
  readonly github: Pick<GitHubClient, "getRepositoryIdentity" | "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">
  readonly expectedRepoId: string
  readonly expectedBranch: string
  readonly passphrase: string
  readonly signal?: AbortSignal | undefined
}

interface V4GitHubVerifiedSnapshotInput extends V4GitHubReencryptionSourceInput {
  /** A frozen backup ref can point to a commit whose config still names the original source branch. */
  readonly expectedPinnedCommitSha?: string | undefined
  readonly expectedSourceTreeSha?: string | undefined
  readonly expectedPhysicalRepositoryId?: number | undefined
  /** D95: only the source fork preflight can permit later source HEAD drift. */
  readonly sourceRefPolicy?: "require-stable-head" | "pinned-immutable-commit" | undefined
}

export interface V4GitHubFrozenBackupVerificationInput {
  readonly github: V4GitHubReencryptionSourceInput["github"] & Pick<GitHubClient, "branchName">
  readonly plan: V4SameRepoReencryptionBackupBranchProposal
  readonly expectedSourceTreeSha: string
  readonly passphrase: string
  readonly signal?: AbortSignal | undefined
}

export interface V4GitHubFrozenBackupVerificationReport {
  readonly integrityScope: "authenticated-frozen-backup-all-live-objects"
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly pinnedSourceTreeSha: string
  readonly verifiedFileCount: number
  readonly verifiedRemoteObjectCount: number
  readonly verifiedPlaintextBytes: string
  readonly backupContentsReadbackVerified: true
  readonly backupCreationProven: false
  readonly installedObsidianRestoreVerified: false
  readonly independentStorageVerified: false
  readonly destinationPublicationAuthorized: false
  readonly cutoverAuthorized: false
}

function assertCommitIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Re-encryption source ref must identify a full immutable Git commit SHA.")
  }
}

function clearKeyring(keyring: V4Keyring): void {
  for (const part of [keyring.masterKey, keyring.pathKey, keyring.contentKey, keyring.indexKey, keyring.journalKey]) {
    part.fill(0)
  }
}

async function verifyGitHubReencryptionSnapshotAtRef(
  input: V4GitHubVerifiedSnapshotInput,
): Promise<V4ReencryptionVerifiedSource> {
  throwIfV4Aborted(input.signal)
  assertSafeGitHubBranch(input.expectedBranch)
  const match = typeof input.expectedRepoId === "string"
    ? /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(input.expectedRepoId) : null
  if (!match) throw new Error("Re-encryption expected repository identity is malformed.")
  const [, selectedOwner, selectedName, configBranch] = match
  assertSafeGitHubRepositoryCoordinates(selectedOwner ?? "", selectedName ?? "")
  assertSafeGitHubBranch(configBranch ?? "")
  if (input.expectedPinnedCommitSha === undefined && configBranch !== input.expectedBranch) {
    throw new Error("Re-encryption expected repository identity and branch do not match.")
  }
  if (input.expectedPinnedCommitSha !== undefined) assertCommitIdentity(input.expectedPinnedCommitSha)
  if (input.expectedSourceTreeSha !== undefined) assertCommitIdentity(input.expectedSourceTreeSha)
  const selectedRepo = `${selectedOwner}/${selectedName}`
  const assertPhysicalRepo = (value: GitHubRepositoryIdentity): number => {
    if (!value || typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id <= 0
      || typeof value.fullName !== "string"
      || value.fullName.toLowerCase() !== selectedRepo.toLowerCase()) {
      throw new Error("Re-encryption GitHub repository identity mismatch.")
    }
    return value.id
  }
  throwIfV4Aborted(input.signal)
  const initialPhysicalId = assertPhysicalRepo(await input.github.getRepositoryIdentity())
  if (input.expectedPhysicalRepositoryId !== undefined
    && initialPhysicalId !== input.expectedPhysicalRepositoryId) {
    throw new Error("Re-encryption GitHub physical repository ID differs from the pinned source.")
  }
  throwIfV4Aborted(input.signal)
  const expectedRef = `refs/heads/${input.expectedBranch}`
  const observe = async (): Promise<string> => {
    throwIfV4Aborted(input.signal)
    const ref = await input.github.getGitRef()
    throwIfV4Aborted(input.signal)
    if (ref.ref !== expectedRef || ref.type !== "commit") {
      throw new Error("Re-encryption source ref or branch identity mismatch.")
    }
    assertCommitIdentity(ref.sha)
    return ref.sha
  }

  const pinned = await observe()
  if (input.expectedPinnedCommitSha !== undefined && pinned !== input.expectedPinnedCommitSha) {
    throw new Error("Re-encryption frozen backup branch is not pinned to the authenticated source commit.")
  }
  // Bounded metadata cache: avoid O(files × Git-path-depth) request growth.
  // Never cache ciphertext blobs or skip verification on a cache hit.
  const TREE_CACHE_MAX_NODES = 8_192
  const TREE_CACHE_MAX_SINGLE_NODES = 2_048
  const treeCache = new Map<string, GitHubTree>()
  let cachedNodeCount = 0
  let commitPromise: ReturnType<typeof input.github.getGitCommit> | undefined
  const readCommit = (sha: string) => {
    if (sha !== pinned) throw new Error("Re-encryption immutable commit changed.")
    commitPromise ??= input.github.getGitCommit(sha).then(commit => {
      if (!commit || commit.sha !== pinned || !/^[0-9a-f]{40}$/u.test(commit.treeSha)
        || !Array.isArray(commit.parentShas)
        || commit.parentShas.some(parent => !/^[0-9a-f]{40}$/u.test(parent))) {
        throw new Error("Re-encryption immutable Git commit identity mismatch or invalid ancestry.")
      }
      if (input.expectedSourceTreeSha !== undefined && commit.treeSha !== input.expectedSourceTreeSha) {
        throw new Error("Re-encryption frozen backup root Git tree differs from the authenticated source.")
      }
      return commit
    })
    return commitPromise
  }
  const readTree = async (sha: string): Promise<GitHubTree> => {
    throwIfV4Aborted(input.signal)
    const cached = treeCache.get(sha)
    if (cached) return cached
    const tree = await input.github.getTreeAt(sha, false)
    throwIfV4Aborted(input.signal)
    if (tree.sha !== sha) throw new Error("Re-encryption immutable Git tree identity mismatch.")
    if (tree.truncated !== false) {
      throw new Error("Re-encryption immutable Git tree is incomplete or truncated.")
    }
    if (!Array.isArray(tree.tree) || tree.tree.length > TREE_CACHE_MAX_SINGLE_NODES) return tree
    while (cachedNodeCount + tree.tree.length > TREE_CACHE_MAX_NODES && treeCache.size) {
      const first = treeCache.keys().next().value
      if (first === undefined) break
      const evicted = treeCache.get(first)
      cachedNodeCount -= evicted?.tree.length ?? 0
      treeCache.delete(first)
    }
    treeCache.set(sha, tree)
    cachedNodeCount += tree.tree.length
    return tree
  }
  // Do not use /contents?ref=... here: exact immutable tree traversal proves
  // each requested path is reachable from the SAME committed Git tree.
  const immutableReader = async (path: string, exactSha: string): Promise<Uint8Array | null> => {
    throwIfV4Aborted(input.signal)
    if (exactSha !== pinned) throw new Error("Re-encryption reader refused a different source commit.")
    const found = await readImmutableGitFile(path, pinned, {
      getCommit: readCommit,
      getTree: readTree,
      getBlob: async sha => {
        throwIfV4Aborted(input.signal)
        const bytes = await input.github.getBlob(sha)
        throwIfV4Aborted(input.signal)
        // A successful GitHub response is not proof that the bytes belong to
        // the blob SHA named in the authenticated immutable Git tree.
        assertV4GitBlobIdentity(bytes, sha)
        return bytes
      },
    })
    throwIfV4Aborted(input.signal)
    return found?.bytes ?? null
  }

  const configBytes = await immutableReader(V4_CONFIG_PATH, pinned)
  if (!configBytes) throw new Error("Re-encryption source config is missing from pinned commit.")
  const config = decodeV4RemoteConfig(configBytes)
  if (config.repoId !== input.expectedRepoId) {
    throw new Error("Re-encryption source repository identity does not match.")
  }
  if (config.mode !== "encrypted" || config.pathLayout !== "opaque-stable-v1"
    || config.kdf !== "PBKDF2-SHA-256" || config.algorithm !== "AES-GCM" || !config.kdfParams) {
    throw new Error("Re-encryption source config requires a supported encrypted KDF and layout.")
  }

  const salt = fromBase64Url(config.kdfParams.salt)
  let keyring: V4Keyring | undefined
  try {
    throwIfV4Aborted(input.signal)
    keyring = await deriveV4Keyring({
      passphrase: input.passphrase, repoId: config.repoId,
      salt, iterations: config.kdfParams.iterations,
    })
    throwIfV4Aborted(input.signal)
    const headBytes = await immutableReader(V4_HEAD_PATH, pinned)
    if (!headBytes) throw new Error("Re-encryption source head is missing from pinned commit.")
    const head = await decodeV4RemoteHead(headBytes, config, keyring)
    const shards: Record<string, V4RemoteShard> = Object.create(null) as Record<string, V4RemoteShard>
    for (const bucket of Object.keys(head.shardHashes)) {
      throwIfV4Aborted(input.signal)
      const shardBytes = await immutableReader(v4RemoteShardPath(bucket, config.mode), pinned)
      if (!shardBytes) throw new Error("Re-encryption source index shard is missing from pinned commit.")
      shards[bucket] = await decodeV4RemoteShard(shardBytes, bucket, config, keyring)
    }
    const verified = await verifyV4ReencryptionSourceObjects({
      config, head, shards, keyring, pinnedSourceCommitSha: pinned,
      sourceRefPolicy: input.sourceRefPolicy,
      readCurrentSourceHeadSha: observe,
      readPinnedObject: immutableReader,
      signal: input.signal,
    })
    throwIfV4Aborted(input.signal)
    const finalPhysicalId = assertPhysicalRepo(await input.github.getRepositoryIdentity())
    throwIfV4Aborted(input.signal)
    if (finalPhysicalId !== initialPhysicalId) {
      throw new Error("Re-encryption GitHub repository identity switched during verification.")
    }
    return verified
  } finally {
    salt.fill(0)
    if (keyring) clearKeyring(keyring)
  }
}

/** Original D70 source preflight: config identity and observed ref are the same branch. */
export function verifyGitHubReencryptionSource(
  input: V4GitHubReencryptionSourceInput,
): Promise<V4ReencryptionVerifiedSource> {
  return verifyGitHubReencryptionSnapshotAtRef(input)
}

/**
 * D95: obtain ONE authenticated source Git ref first, then authenticate the
 * whole logical vault from its exact immutable SHA. Other old-branch devices
 * may advance their branch HEAD during this read without invalidating the
 * already pinned snapshot. Never treat this read-only report as write approval.
 */
export function verifyGitHubReencryptionForkSource(
  input: V4GitHubReencryptionSourceInput,
): Promise<V4ReencryptionVerifiedSource> {
  return verifyGitHubReencryptionSnapshotAtRef({
    ...input, sourceRefPolicy: "pinned-immutable-commit",
  })
}

/**
 * D94: authenticate EVERY live ciphertext object THROUGH the already-created
 * frozen backup branch, without requiring the original source branch to stop
 * Syncing. The V4 config still identifies the original old-key source branch,
 * not the backup ref used to retain the pinned original commit.
 *
 * This is read-only independent GitHub readback of source ciphertext. It
 * proves neither backup creation provenance nor local restore durability.
 */
export async function verifyGitHubFrozenReencryptionBackup(
  input: V4GitHubFrozenBackupVerificationInput,
): Promise<V4GitHubFrozenBackupVerificationReport> {
  throwIfV4Aborted(input.signal)
  const { plan } = input
  if (!plan || plan.proof !== "owner-approved-same-repo-backup-topology-only"
    || plan.status !== "blocked-pending-safe-backup-ref-implementation"
    || plan.actualBackupCreated !== false || plan.backupReadbackVerified !== false
    || plan.permissionToPublish !== false || plan.cutoverAuthorized !== false
    || plan.oldBranchDeletionAuthorized !== false
    || !Number.isSafeInteger(plan.physicalRepositoryId) || plan.physicalRepositoryId < 1
    || !/^[0-9a-f]{40}$/u.test(plan.pinnedSourceCommitSha)
    || !/^[0-9a-f]{40}$/u.test(input.expectedSourceTreeSha)) {
    throw new Error("Frozen backup full readback requires a blocked authenticated snapshot proposal.")
  }
  const sourceId = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(plan.sourceRepoId)
  const backupId = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(plan.backupRepoId)
  const destinationId = /^([^#/]+)\/([^#/]+)#(.+)$/u.exec(plan.destinationRepoId)
  if (!sourceId || !backupId || !destinationId) {
    throw new Error("Frozen backup branch repository identities are invalid.")
  }
  const names = [sourceId, backupId, destinationId].map(value => `${value[1]}/${value[2]}`.toLowerCase())
  if (names.some(value => value !== names[0])
    || new Set([sourceId[3], backupId[3], destinationId[3]]).size !== 3
    || backupId[3] !== plan.backupBranch
    || input.github.branchName !== backupId[3]) {
    throw new Error("Frozen backup GitHub branch scope, repository or three-branch topology mismatch.")
  }
  const verified = await verifyGitHubReencryptionSnapshotAtRef({
    github: input.github,
    expectedRepoId: plan.sourceRepoId,
    expectedBranch: plan.backupBranch,
    expectedPinnedCommitSha: plan.pinnedSourceCommitSha,
    expectedSourceTreeSha: input.expectedSourceTreeSha,
    expectedPhysicalRepositoryId: plan.physicalRepositoryId,
    passphrase: input.passphrase,
    signal: input.signal,
  })
  throwIfV4Aborted(input.signal)
  return Object.freeze({
    integrityScope: "authenticated-frozen-backup-all-live-objects",
    backupRepoId: plan.backupRepoId,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    pinnedSourceTreeSha: input.expectedSourceTreeSha,
    verifiedFileCount: verified.verifiedFileCount,
    verifiedRemoteObjectCount: verified.verifiedRemoteObjectCount,
    verifiedPlaintextBytes: verified.totalVerifiedPlaintextBytes,
    backupContentsReadbackVerified: true,
    backupCreationProven: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
  })
}
