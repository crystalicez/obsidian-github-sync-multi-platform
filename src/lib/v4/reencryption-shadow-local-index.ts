import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import {
  isV4LocalIndexCacheComplete, loadV4LocalIndex, saveV4LocalIndex,
  type V4LocalIndex, type V4LocalIndexAdapter,
} from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"

const SHA = /^[a-f0-9]{40}$/u
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/u

// Cooperative in-process guard only. A real cross-process lease and a durable
// exclusive directory-claim protocol remain obligations of the storage adapter.
const activeStaging = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4ReencryptionShadowLocalIndexInput {
  readonly adapter: V4LocalIndexAdapter
  /** The existing source cache is never read, written or moved by this API. */
  readonly activeRoot: string
  /** Must be a new unique, run-scoped identity. No reuse after a partial write. */
  readonly runId: string
  /** Already-authenticated destination index from a separate verifier. */
  readonly destinationIndex: V4LocalIndex
  readonly expectedDestinationRepoId: string
  readonly expectedDestinationCommitSha: string
  readonly expectedDeviceId: string
  /** External co-operative write gate; this module cannot attest to OS exclusion. */
  readonly assertInitiatorQuiescent: () => Promise<void>
  /** Must represent a real platform persistence barrier, NOT a resolved mock. */
  readonly assertCrashDurable: () => Promise<void>
}

export interface V4ReencryptionShadowLocalIndexResult {
  readonly status: "shadow-index-staged-uncommitted"
  readonly stagingRoot: string
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  /** Stage and readback do not replace an authenticated transaction commit. */
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

function matchesSnapshot(candidate: V4LocalIndex, snapshot: V4LocalIndex, originalDigests: ReadonlyMap<string, string | undefined>): boolean {
  if (candidate.repoId !== snapshot.repoId || candidate.deviceId !== snapshot.deviceId
    || candidate.remoteCommitSha !== snapshot.remoteCommitSha
    || candidate.mode !== snapshot.mode || candidate.pathLayout !== snapshot.pathLayout
    || candidate.formatVersion !== snapshot.formatVersion
    || candidate.epoch !== snapshot.epoch || candidate.generation !== snapshot.generation
    || JSON.stringify(candidate.shardHashes) !== JSON.stringify(snapshot.shardHashes)
    || Object.keys(candidate.shards).length !== Object.keys(snapshot.shards).length) return false
  return Object.entries(snapshot.shards).every(([bucket, shard]) => {
    const live = candidate.shards[bucket]
    return !!live && live.bucket === shard.bucket && live.hash === shard.hash
      && live.contentDigest === originalDigests.get(bucket)
      && JSON.stringify(live.records) === JSON.stringify(shard.records)
  })
}

function matchesStagedReadback(actual: V4LocalIndex, snapshot: V4LocalIndex): boolean {
  if (actual.repoId !== snapshot.repoId || actual.deviceId !== snapshot.deviceId
    || actual.remoteCommitSha !== snapshot.remoteCommitSha
    || actual.mode !== snapshot.mode || actual.pathLayout !== snapshot.pathLayout
    || actual.formatVersion !== snapshot.formatVersion
    || actual.epoch !== snapshot.epoch || actual.generation !== snapshot.generation
    || JSON.stringify(actual.shardHashes) !== JSON.stringify(snapshot.shardHashes)
    || Object.keys(actual.shards).length !== Object.keys(snapshot.shards).length) return false
  return Object.entries(snapshot.shards).every(([bucket, shard]) => {
    const loaded = actual.shards[bucket]
    return !!loaded && loaded.bucket === shard.bucket && loaded.hash === shard.hash
      && loaded.contentDigest === shard.contentDigest
      && JSON.stringify(loaded.records) === JSON.stringify(shard.records)
  })
}

function validate(input: V4ReencryptionShadowLocalIndexInput): string {
  if (!input || typeof input.activeRoot !== "string"
    || !RUN.test(input.runId)
    || !input.activeRoot.split("/").every(part => SAFE_SEGMENT.test(part) && part !== "." && part !== "..")
    || input.activeRoot.split("/").length < 2
    || input.activeRoot.endsWith("/")
    || input.activeRoot.includes("\\")
    || !SHA.test(input.expectedDestinationCommitSha)
    || typeof input.expectedDestinationRepoId !== "string"
    || !/^([^/#]+)\/([^/#]+)#([^#]+)$/u.test(input.expectedDestinationRepoId)
    || typeof input.expectedDeviceId !== "string" || !input.expectedDeviceId
    || typeof input.assertInitiatorQuiescent !== "function"
    || typeof input.assertCrashDurable !== "function"
    || typeof input.adapter?.exists !== "function"
    || typeof input.adapter.read !== "function"
    || typeof input.adapter.write !== "function"
    || typeof input.adapter.mkdir !== "function") {
    throw new Error("Invalid strictly gated Re-encryption shadow-index scope or durability contract.")
  }
  const match = /^([^/#]+)\/([^/#]+)#([^#]+)$/u.exec(input.expectedDestinationRepoId)
  if (!match) throw new Error("Invalid Re-encryption Destination identity.")
  assertSafeGitHubRepositoryCoordinates(match[1]!, match[2]!)
  assertSafeGitHubBranch(match[3]!)
  const idx = input.destinationIndex
  if (!idx || idx.repoId !== input.expectedDestinationRepoId
    || idx.deviceId !== input.expectedDeviceId
    || idx.remoteCommitSha !== input.expectedDestinationCommitSha
    || idx.mode !== "encrypted"
    || idx.pathLayout !== expectedV4PathLayout("encrypted")
    || !isV4LocalIndexCacheComplete(idx)
    || Object.values(idx.shards).some(shard =>
      Object.values(shard.records).some(record => record.dirty === true || record.deleted === true))) {
    throw new Error("Destination local index has not been fully authenticated or is dirty.")
  }
  return input.activeRoot + "-rekey-" + input.runId
}

/**
 * D134: prepare a new *independent* run-scoped index without ever overwriting
 * the source's live cache. The returned record is a readback observation only.
 *
 * A preexisting shadow directory is a failed/ambiguous earlier attempt:
 * NEVER overwrite or delete it on retry. No settings/SecretStorage/Git writes.
 *
 * An adapter's exists/mkdir/write promises do NOT prove physical fsync, inode
 * safety or external-writer exclusion. The real platform implementation must
 * establish those properties independently before relying on a staged index.
 */
export async function stageV4ReencryptionShadowLocalIndex(
  input: V4ReencryptionShadowLocalIndexInput,
): Promise<V4ReencryptionShadowLocalIndexResult> {
  const stageRoot = validate(input)
  const activeRoot = input.activeRoot
  const runId = input.runId
  const sealedCandidate = JSON.stringify(input.destinationIndex)
  const expected = Object.freeze({
    repoId: input.expectedDestinationRepoId,
    commitSha: input.expectedDestinationCommitSha,
    deviceId: input.expectedDeviceId,
  })
  const index = input.destinationIndex
  // Make a defensive view: saveV4LocalIndex() computes shard content digests.
  // Never mutate the caller's preverified candidate in that process.
  const clone: V4LocalIndex = {
    ...index,
    shardHashes: { ...index.shardHashes },
    shards: Object.fromEntries(Object.entries(index.shards).map(([bucket, shard]) => [
      bucket, {
        ...shard,
        records: Object.fromEntries(Object.entries(shard.records).map(([key, record]) => [
          key, { ...record, ...(record.partPaths ? { partPaths: [...record.partPaths] } : {}) },
        ])),
      },
    ])),
  }
  const originalDigests = new Map(Object.entries(index.shards).map(([bucket, shard]) =>
    [bucket, shard.contentDigest] as const))
  const claim = activeStaging.get(input.adapter) ?? new Set<string>()
  if (claim.has(stageRoot)) throw new Error("Concurrent Re-encryption shadow staging requires manual recovery.")
  // Synchronous claim before any await; only protects callers sharing this adapter.
  claim.add(stageRoot)
  activeStaging.set(input.adapter, claim)
  try {
    // Claim a cooperating initiator lease BEFORE examining the proposed path.
    await input.assertInitiatorQuiescent()
    if (input.activeRoot !== activeRoot || input.runId !== runId
      || JSON.stringify(input.destinationIndex) !== sealedCandidate
      || !matchesSnapshot(input.destinationIndex, clone, originalDigests)) {
      throw new Error("Re-encryption shadow index candidate changed before staging.")
    }
    if (await input.adapter.exists(stageRoot)) {
      throw new Error("Existing Re-encryption shadow index needs manual recovery; never overwrite or reuse.")
    }
    // The new directory must not collide with the live cache and is never
    // published as active by this helper, even if the write succeeds.
    await saveV4LocalIndex(input.adapter, stageRoot, clone)
    await input.assertCrashDurable()
    await input.assertInitiatorQuiescent()
    const verified = await loadV4LocalIndex(input.adapter, stageRoot)
    if (verified.repoId !== expected.repoId || verified.deviceId !== expected.deviceId
      || verified.remoteCommitSha !== expected.commitSha
      || verified.mode !== "encrypted" || !isV4LocalIndexCacheComplete(verified)
      || !matchesStagedReadback(verified, clone)) {
      throw new Error("Re-encryption shadow index failed strict readback; manual recovery required.")
    }
    await input.assertCrashDurable()
    await input.assertInitiatorQuiescent()
    if (input.destinationIndex !== index || input.expectedDestinationRepoId !== expected.repoId
      || input.expectedDestinationCommitSha !== expected.commitSha || input.expectedDeviceId !== expected.deviceId
      || input.activeRoot !== activeRoot || input.runId !== runId
      || JSON.stringify(input.destinationIndex) !== sealedCandidate
      || !matchesSnapshot(input.destinationIndex, clone, originalDigests)) {
      throw new Error("Re-encryption shadow staging identity changed during preparation.")
    }
    return Object.freeze({
      status: "shadow-index-staged-uncommitted",
      stagingRoot: stageRoot, destinationRepoId: expected.repoId, destinationCommitSha: expected.commitSha,
      localCutoverAuthorized: false, resumeSyncAuthorized: false, oldPassphraseCleanupAuthorized: false,
    })
  } finally {
    claim.delete(stageRoot)
    if (claim.size === 0) activeStaging.delete(input.adapter)
  }
}
