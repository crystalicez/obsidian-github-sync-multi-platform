import { fromBase64Url } from "../bytes"
import { assertSafeGitHubBranch } from "../github-config"
import type { GitHubClient, GitHubTree } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { readImmutableGitFile } from "./immutable-git-read"
import { verifyV4ReencryptionSourceObjects, type V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"
import { decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, v4RemoteShardPath, type V4RemoteShard } from "./remote-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH } from "./protocol-types"

/**
 * Trusted read-only bridge between the public GitHub Git API and D69's
 * all-live-object verifier. Uses immutable commit/tree/blob lookups ONLY.
 *
 * A passed GitHub client must be scoped to the exact, already-approved repo
 * and branch. This is not a migration/rotation/cutover entrypoint.
 */
export interface V4GitHubReencryptionSourceInput {
  readonly github: Pick<GitHubClient, "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">
  readonly expectedRepoId: string
  readonly expectedBranch: string
  readonly passphrase: string
  readonly signal?: AbortSignal | undefined
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

export async function verifyGitHubReencryptionSource(
  input: V4GitHubReencryptionSourceInput,
): Promise<V4ReencryptionVerifiedSource> {
  throwIfV4Aborted(input.signal)
  assertSafeGitHubBranch(input.expectedBranch)
  if (typeof input.expectedRepoId !== "string" || !input.expectedRepoId.endsWith(`#${input.expectedBranch}`)) {
    throw new Error("Re-encryption expected repository identity and branch do not match.")
  }

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
  // Bounded metadata cache: avoid O(files × Git-path-depth) request growth.
  // Never cache ciphertext blobs or skip verification on a cache hit.
  const TREE_CACHE_MAX_NODES = 8_192
  const TREE_CACHE_MAX_SINGLE_NODES = 2_048
  const treeCache = new Map<string, GitHubTree>()
  let cachedNodeCount = 0
  let commitPromise: ReturnType<typeof input.github.getGitCommit> | undefined
  const readCommit = (sha: string) => {
    if (sha !== pinned) throw new Error("Re-encryption immutable commit changed.")
    commitPromise ??= input.github.getGitCommit(sha)
    return commitPromise
  }
  const readTree = async (sha: string): Promise<GitHubTree> => {
    throwIfV4Aborted(input.signal)
    const cached = treeCache.get(sha)
    if (cached) return cached
    const tree = await input.github.getTreeAt(sha, false)
    throwIfV4Aborted(input.signal)
    // A truncated tree cannot prove path absence and must never be cached.
    if (tree.sha !== sha) throw new Error("Re-encryption immutable Git tree identity mismatch.")
    if (tree.truncated !== false || !Array.isArray(tree.tree)
      || tree.tree.length > TREE_CACHE_MAX_SINGLE_NODES) return tree
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
    return await verifyV4ReencryptionSourceObjects({
      config, head, shards, keyring, pinnedSourceCommitSha: pinned,
      readCurrentSourceHeadSha: observe,
      readPinnedObject: immutableReader,
      signal: input.signal,
    })
  } finally {
    salt.fill(0)
    if (keyring) clearKeyring(keyring)
  }
}
