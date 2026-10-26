import { fromBase64Url, utf8ToBytes } from "../bytes"
import type { GitHubClient, GitHubTree } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"
import type { V4IndexFileRecord } from "./local-index"
import { assertV4OrphanReencryptionRoot, type V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import { inspectV4ReencryptionInventory } from "./reencryption-inventory"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"
import { decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, v4RemoteShardPath, type V4RemoteShard } from "./remote-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH, type V4RemoteConfig } from "./protocol-types"
import { V4StorageCodec } from "./storage-codec"
import type { V4StagedSink } from "./staging-store"

const FULL_SHA = /^[0-9a-f]{40}$/u
const MAX_TREE_NODES = 100_000

/** This verifier accepts a published, exact orphan COMMIT, not a staged blob list alone. */
export interface V4ReencryptionDestinationExactCommitInput {
  readonly github: Pick<GitHubClient, "getRepositoryIdentity" | "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">
  readonly plan: V4OrphanReencryptionPlan
  /** Explicit immutable commit, never branch name or HEAD. */
  readonly destinationCommitSha: string
  /** Previously authenticated pinned source commit's tree SHA and config. */
  readonly sourceTreeSha: string
  readonly sourceConfig: V4RemoteConfig
  readonly expectedDestinationConfig: V4RemoteConfig
  /** Fully finalized D79 destination record manifest. Do NOT expose file paths in logs. */
  readonly expectedRecords: readonly V4IndexFileRecord[]
  /** All completed D79 ciphertext object receipts. */
  readonly expectedReceipts: readonly V4ReencryptionObjectReceipt[]
  readonly destinationPassphrase: string
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionDestinationExactCommitReport {
  readonly integrityScope: "exact-orphan-commit-all-live-content"
  readonly destinationCommitSha: string
  readonly destinationRepoId: string
  readonly verifiedFileCount: number
  readonly verifiedRemoteObjectCount: number
  readonly totalVerifiedPlaintextBytes: string
  readonly backupVerified: false
  readonly secondDeviceRestored: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
}

const pathsOf = (r: V4IndexFileRecord): readonly string[] =>
  r.storage === "chunked" ? r.partPaths ?? [] : [r.remotePath]

function recordsEqual(a: V4IndexFileRecord, b: V4IndexFileRecord): boolean {
  for (const field of ["path", "pathId", "fileId", "remoteVersion", "remotePath", "plaintextSha256", "size", "mtime",
    "storage", "encryptedPath", "packId", "deleted", "dirty"] as const) {
    if (a[field] !== b[field]) return false
  }
  return (a.partPaths === undefined && b.partPaths === undefined)
    || (a.partPaths !== undefined && b.partPaths !== undefined
      && a.partPaths.length === b.partPaths.length
      && a.partPaths.every((path, i) => path === b.partPaths?.[i]))
}

function ensureIdentity(value: { id: number; fullName: string }, id: number, name: string): void {
  if (!value || value.id !== id || typeof value.fullName !== "string"
    || value.fullName.toLowerCase() !== name.toLowerCase()) {
    throw new Error("Re-encryption destination physical GitHub repository identity mismatch.")
  }
}

function strictTreeMap(tree: GitHubTree, sha: string): Map<string, string> {
  if (tree.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree)
    || tree.tree.length > MAX_TREE_NODES) {
    throw new Error("Re-encryption destination immutable Git tree is truncated, oversized, or mismatched.")
  }
  const map = new Map<string, string>()
  for (const node of tree.tree) {
    if (!node || typeof node.path !== "string" || !node.path || node.path.startsWith("/")
      || node.path.split("/").some(seg => !seg || seg === "." || seg === "..")
      || typeof node.sha !== "string" || !FULL_SHA.test(node.sha)) {
      throw new Error("Re-encryption destination immutable tree contains invalid path or SHA.")
    }
    if (node.type === "tree") {
      if (node.mode !== "040000") throw new Error("Re-encryption destination invalid Git tree mode.")
      continue
    }
    if (node.type !== "blob" || node.mode !== "100644" || map.has(node.path)) {
      throw new Error("Re-encryption destination has duplicate, symlink or unsupported Git blob entry.")
    }
    map.set(node.path, node.sha)
  }
  return map
}

/**
 * A read-only full destination proof at one concrete Git SHA: zero-parent
 * orphan topology, exact tree paths and receipt object identities, authenticated
 * encrypted V4 HEAD/index, and all plaintext hashes/sizes.
 *
 * Does NOT certify an independent backup, source freeze, durable WAL, or a
 * second physical Obsidian device. It NEVER authorizes publishing or cutover.
 */
export async function verifyV4ReencryptionDestinationExactCommit(
  input: V4ReencryptionDestinationExactCommitInput,
): Promise<V4ReencryptionDestinationExactCommitReport> {
  const { github, plan } = input
  throwIfV4Aborted(input.signal)
  if (plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || !FULL_SHA.test(input.destinationCommitSha)
    || input.destinationCommitSha === plan.pinnedSourceCommitSha
    || !Array.isArray(input.expectedRecords) || !Array.isArray(input.expectedReceipts)
    || typeof input.destinationPassphrase !== "string") {
    throw new Error("Re-encryption destination exact-commit input is invalid.")
  }
  const selected = plan.destinationRepoId.split("#")
  if (selected.length !== 2 || selected[1] !== plan.destinationBranch
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(selected[0] ?? "")) {
    throw new Error("Re-encryption destination branch identity mismatch.")
  }
  const checkRepo = async () => {
    throwIfV4Aborted(input.signal)
    ensureIdentity(await github.getRepositoryIdentity(), plan.physicalRepositoryId, selected[0]!)
    throwIfV4Aborted(input.signal)
  }
  const checkRef = async () => {
    throwIfV4Aborted(input.signal)
    const ref = await github.getGitRef()
    throwIfV4Aborted(input.signal)
    if (ref.ref !== `refs/heads/${plan.destinationBranch}`
      || ref.type !== "commit" || ref.sha !== input.destinationCommitSha) {
      throw new Error("Re-encryption destination branch changed or is not pinned to expected Git commit.")
    }
  }
  await checkRepo()
  await checkRef()
  const commit = await github.getGitCommit(input.destinationCommitSha)
  throwIfV4Aborted(input.signal)
  if (!commit || commit.sha !== input.destinationCommitSha) {
    throw new Error("Re-encryption destination Git commit identity differs from the pinned requested SHA.")
  }
  assertV4OrphanReencryptionRoot({
    plan, candidateCommit: commit, sourceTreeSha: input.sourceTreeSha,
    sourceConfigBytes: utf8ToBytes(JSON.stringify(input.sourceConfig)),
    destinationConfigBytes: utf8ToBytes(JSON.stringify(input.expectedDestinationConfig)),
  })
  const tree = await github.getTreeAt(commit.treeSha, true)
  throwIfV4Aborted(input.signal)
  const entries = strictTreeMap(tree, commit.treeSha)
  const getPinnedFile = async (path: string): Promise<Uint8Array> => {
    throwIfV4Aborted(input.signal)
    const sha = entries.get(path)
    if (!sha) throw new Error("Re-encryption destination exact commit is missing required Git object.")
    const bytes = await github.getBlob(sha)
    throwIfV4Aborted(input.signal)
    assertV4GitBlobIdentity(bytes, sha)
    return bytes
  }
  const encodedConfig = await getPinnedFile(V4_CONFIG_PATH)
  const config = decodeV4RemoteConfig(encodedConfig)
  if (JSON.stringify(config) !== JSON.stringify(input.expectedDestinationConfig)) {
    throw new Error("Re-encryption destination committed config differs from finalized settings.")
  }
  if (!config.kdfParams) throw new Error("Re-encryption destination is missing KDF parameters.")
  const salt = fromBase64Url(config.kdfParams.salt)
  let keyring: V4Keyring | undefined
  try {
    keyring = await deriveV4Keyring({
      passphrase: input.destinationPassphrase, repoId: config.repoId,
      salt, iterations: config.kdfParams.iterations,
    })
    throwIfV4Aborted(input.signal)
    const head = await decodeV4RemoteHead(await getPinnedFile(V4_HEAD_PATH), config, keyring)
    const shards: Record<string, V4RemoteShard> = Object.create(null) as Record<string, V4RemoteShard>
    for (const bucket of Object.keys(head.shardHashes)) {
      throwIfV4Aborted(input.signal)
      shards[bucket] = await decodeV4RemoteShard(
        await getPinnedFile(v4RemoteShardPath(bucket, config.mode)), bucket, config, keyring,
      )
    }
    const inventory = await inspectV4ReencryptionInventory({
      config, head, shards, keyring, pinnedSourceCommitSha: input.destinationCommitSha,
    })
    const actual = Object.values(shards).flatMap(shard => Object.values(shard.records))
    if (actual.length !== input.expectedRecords.length || inventory.fileCount !== input.expectedRecords.length
      || actual.some(record => record.deleted || record.dirty)) {
      throw new Error("Re-encryption destination committed index has missing, extra, or deleted records.")
    }
    const expected = new Map<string, V4IndexFileRecord>()
    for (const record of input.expectedRecords) {
      if (expected.has(record.pathId) || record.deleted || record.dirty) {
        throw new Error("Re-encryption destination expected record manifest is invalid.")
      }
      expected.set(record.pathId, record)
    }
    for (const record of actual) {
      const reference = expected.get(record.pathId)
      if (!reference || !recordsEqual(record, reference)) {
        throw new Error("Re-encryption destination committed encrypted record differs from finalized manifest.")
      }
    }

    const required = new Set<string>([V4_CONFIG_PATH, V4_HEAD_PATH])
    for (const bucket of Object.keys(head.shardHashes)) required.add(v4RemoteShardPath(bucket, config.mode))
    const receiptMap = new Map<string, V4ReencryptionObjectReceipt>()
    for (const receipt of input.expectedReceipts) {
      if (!receipt || typeof receipt.path !== "string" || receiptMap.has(receipt.path)
        || !FULL_SHA.test(receipt.sha)
        || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 1
        || receipt.byteLength > V4_GITHUB_REST_SAFE_WRITER_BYTES) {
        throw new Error("Re-encryption destination object receipt manifest is invalid or duplicated.")
      }
      receiptMap.set(receipt.path, receipt)
    }
    const objectPaths = new Set<string>()
    for (const record of actual) for (const path of pathsOf(record)) objectPaths.add(path)
    if (objectPaths.size !== receiptMap.size || objectPaths.size !== inventory.distinctRemoteObjectCount) {
      throw new Error("Re-encryption destination Git receipts do not cover every committed object.")
    }
    for (const path of objectPaths) {
      const receipt = receiptMap.get(path)
      if (!receipt || entries.get(path) !== receipt.sha) {
        throw new Error("Re-encryption destination committed Git tree object SHA differs from upload receipt.")
      }
      required.add(path)
    }
    if (entries.size !== required.size || [...entries.keys()].some(path => !required.has(path))) {
      throw new Error("Re-encryption destination orphan tree contains missing or unexpected blobs.")
    }

    const codec = new V4StorageCodec({
      mode: "encrypted", pathLayout: "opaque-stable-v1", keyring, signal: input.signal,
    })
    const sink: V4StagedSink = {
      async append(_content: Uint8Array) {},
      async finish() { throw new Error("Destination audit cannot commit a vault staging sink.") },
      async abort() {},
    }
    let count = 0
    let total = BigInt(0)
    const checkedObjects = new Set<string>()
    for (const record of actual) {
      throwIfV4Aborted(input.signal)
      const verified = await codec.readToSink({
        record, sink, signal: input.signal,
        reader: async path => {
          const result = await getPinnedFile(path)
          const receipt = receiptMap.get(path)
          if (!receipt || result.byteLength !== receipt.byteLength) {
            throw new Error("Re-encryption destination encrypted object has wrong uploaded byte length.")
          }
          checkedObjects.add(path)
          return result
        },
      })
      if (verified.plaintextSha256 !== record.plaintextSha256 || verified.size !== record.size) {
        throw new Error("Re-encryption destination plaintext SHA or logical size mismatch.")
      }
      count++
      total += BigInt(verified.size)
    }
    if (count !== inventory.fileCount || total.toString() !== inventory.totalLogicalBytes
      || checkedObjects.size !== receiptMap.size) {
      throw new Error("Re-encryption destination authenticated plaintext inventory totals differ.")
    }
    await checkRef()
    await checkRepo()
    return Object.freeze({
      integrityScope: "exact-orphan-commit-all-live-content",
      destinationCommitSha: input.destinationCommitSha,
      destinationRepoId: plan.destinationRepoId,
      verifiedFileCount: count,
      verifiedRemoteObjectCount: checkedObjects.size,
      totalVerifiedPlaintextBytes: total.toString(),
      backupVerified: false,
      secondDeviceRestored: false,
      permissionToPublish: false,
      cutoverAuthorized: false,
    })
  } finally {
    salt.fill(0)
    if (keyring) {
      for (const part of [keyring.masterKey, keyring.pathKey, keyring.contentKey, keyring.indexKey, keyring.journalKey]) {
        part.fill(0)
      }
    }
  }
}
