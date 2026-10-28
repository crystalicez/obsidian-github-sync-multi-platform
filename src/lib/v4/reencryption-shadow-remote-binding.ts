import {
  isV4LocalIndexCacheComplete, loadV4LocalIndex,
  type V4IndexFileRecord, type V4LocalIndex, type V4LocalIndexAdapter,
} from "./local-index"
import {
  verifyV4ReencryptionDestinationExactCommit,
  type V4ReencryptionDestinationExactCommitInput,
} from "./reencryption-destination-exact-commit"
import { expectedV4PathLayout } from "./protocol-types"

const SHA = /^[0-9a-f]{40}$/u
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SEGMENT = /^[A-Za-z0-9_.-]+$/u

export interface V4ReencryptionShadowRemoteBindingInput {
  readonly adapter: V4LocalIndexAdapter
  readonly activeIndexRoot: string
  readonly runId: string
  readonly expectedDeviceId: string
  readonly remote: Omit<V4ReencryptionDestinationExactCommitInput, "expectedRecords">
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly assertCrashDurable: () => Promise<void>
}

export interface V4ReencryptionShadowRemoteBindingReport {
  readonly integrityScope: "read-only-verified-git-content-to-local-shadow"
  readonly observation: "shadow-matches-verified-destination-uncommitted"
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  readonly verifiedFileCount: number
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

function validRoot(value: string): boolean {
  return typeof value === "string" && value.split("/").length >= 2
    && value.split("/").every(segment => SEGMENT.test(segment)
      && segment !== "." && segment !== "..")
}

function validIndex(index: V4LocalIndex, repoId: string, sha: string, deviceId: string): boolean {
  return index.repoId === repoId && index.remoteCommitSha === sha
    && index.deviceId === deviceId && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(record => record.dirty !== true && record.deleted !== true))
}

function clonedRecords(index: V4LocalIndex): V4IndexFileRecord[] {
  const records = Object.values(index.shards).flatMap(shard => Object.values(shard.records))
  const ids = new Set<string>()
  for (const record of records) {
    if (!record || typeof record.pathId !== "string" || ids.has(record.pathId)) {
      throw new Error("Destination Shadow contains invalid or duplicate record identity.")
    }
    ids.add(record.pathId)
  }
  return records.map(record => ({
    ...record, ...(record.partPaths ? { partPaths: [...record.partPaths] } : {}),
  }))
}

/**
 * Bind a complete local Shadow snapshot to independent D83 immutable Git
 * verification of encrypted metadata and every plaintext content SHA.
 * No Settings, SecretStorage, local index, or remote mutations occur.
 */
export async function verifyV4ReencryptionShadowAgainstDestination(
  input: V4ReencryptionShadowRemoteBindingInput,
): Promise<V4ReencryptionShadowRemoteBindingReport> {
  if (!input || !validRoot(input.activeIndexRoot)
    || typeof input.runId !== "string" || !RUN.test(input.runId)
    || typeof input.expectedDeviceId !== "string" || !input.expectedDeviceId
    || typeof input.adapter?.read !== "function" || typeof input.adapter.exists !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || !input.remote || !SHA.test(input.remote.destinationCommitSha)
    || input.remote.destinationCommitSha === input.remote.plan?.pinnedSourceCommitSha
    || input.remote.plan?.destinationRepoId !== input.remote.expectedDestinationConfig?.repoId
    || typeof input.remote.destinationPassphrase !== "string"
    || !Array.isArray(input.remote.expectedReceipts)
    || typeof input.remote.github?.getGitRef !== "function"
    || typeof input.remote.github.getGitCommit !== "function"
    || typeof input.remote.github.getTreeAt !== "function"
    || typeof input.remote.github.getBlob !== "function"
    || typeof input.remote.github.getRepositoryIdentity !== "function") {
    throw new Error("Invalid independent Shadow-to-remote verification scope.")
  }
  const adapter = input.adapter
  const lease = input.assertExclusiveInitiatorLease
  const durable = input.assertCrashDurable
  const remote = input.remote
  const github = remote.github
  const githubMethods = {
    getRepositoryIdentity: github.getRepositoryIdentity,
    getGitRef: github.getGitRef,
    getGitCommit: github.getGitCommit,
    getTreeAt: github.getTreeAt,
    getBlob: github.getBlob,
  }
  const verifiedGithub = {
    getRepositoryIdentity: githubMethods.getRepositoryIdentity.bind(github),
    getGitRef: githubMethods.getGitRef.bind(github),
    getGitCommit: githubMethods.getGitCommit.bind(github),
    getTreeAt: githubMethods.getTreeAt.bind(github),
    getBlob: githubMethods.getBlob.bind(github),
  }
  const signal = remote.signal
  const passphrase = remote.destinationPassphrase
  const plan = { ...remote.plan }
  const sourceTreeSha = remote.sourceTreeSha
  const sourceConfig = structuredClone(remote.sourceConfig)
  const destinationConfig = structuredClone(remote.expectedDestinationConfig)
  const receipts = remote.expectedReceipts.map(receipt => ({ ...receipt }))
  const originalRemote = JSON.stringify({
    plan: remote.plan, sourceConfig: remote.sourceConfig,
    destinationConfig: remote.expectedDestinationConfig, receipts: remote.expectedReceipts,
  })
  const scope = {
    activeIndexRoot: input.activeIndexRoot, runId: input.runId,
    expectedDeviceId: input.expectedDeviceId, destinationCommitSha: remote.destinationCommitSha,
  }
  const shadowRoot = scope.activeIndexRoot + "-rekey-" + scope.runId
  const unchanged = (): boolean =>
    input.adapter === adapter && input.assertExclusiveInitiatorLease === lease
    && input.assertCrashDurable === durable && input.remote === remote
    && input.activeIndexRoot === scope.activeIndexRoot && input.runId === scope.runId
    && input.expectedDeviceId === scope.expectedDeviceId
    && remote.github === github && remote.signal === signal
    && github.getRepositoryIdentity === githubMethods.getRepositoryIdentity
    && github.getGitRef === githubMethods.getGitRef
    && github.getGitCommit === githubMethods.getGitCommit
    && github.getTreeAt === githubMethods.getTreeAt
    && github.getBlob === githubMethods.getBlob
    && remote.destinationPassphrase === passphrase && remote.sourceTreeSha === sourceTreeSha
    && remote.destinationCommitSha === scope.destinationCommitSha
    && JSON.stringify({
      plan: remote.plan, sourceConfig: remote.sourceConfig,
      destinationConfig: remote.expectedDestinationConfig, receipts: remote.expectedReceipts,
    }) === originalRemote

  await lease()
  await durable()
  if (!unchanged()) throw new Error("Destination verifier inputs changed before Shadow inspection.")
  const first = await loadV4LocalIndex(adapter, shadowRoot)
  if (!validIndex(first, plan.destinationRepoId, scope.destinationCommitSha, scope.expectedDeviceId)) {
    throw new Error("Destination Shadow is incomplete or has an incorrect Git commit identity.")
  }
  const sealed = JSON.stringify(first)
  const expectedRecords = clonedRecords(first)
  if (!unchanged()) throw new Error("Destination verifier inputs changed during Shadow read.")
  const verified = await verifyV4ReencryptionDestinationExactCommit({
    github: verifiedGithub, plan, destinationCommitSha: scope.destinationCommitSha,
    sourceTreeSha, sourceConfig, expectedDestinationConfig: destinationConfig,
    expectedRecords,
    expectedLocalIndexHead: {
      deviceId: first.deviceId, epoch: first.epoch, generation: first.generation,
      shardHashes: { ...first.shardHashes },
    },
    expectedReceipts: receipts, destinationPassphrase: passphrase, signal,
  })
  if (!unchanged()
    || verified.integrityScope !== "exact-orphan-commit-all-live-content"
    || verified.destinationCommitSha !== scope.destinationCommitSha
    || verified.destinationRepoId !== plan.destinationRepoId
    || verified.verifiedFileCount !== expectedRecords.length
    || verified.permissionToPublish !== false || verified.cutoverAuthorized !== false) {
    throw new Error("Remote verification report does not bind the immutable Destination Shadow.")
  }
  await lease()
  await durable()
  if (!unchanged()) throw new Error("Destination verifier inputs changed after remote verification.")
  const second = await loadV4LocalIndex(adapter, shadowRoot)
  if (!validIndex(second, plan.destinationRepoId, scope.destinationCommitSha, scope.expectedDeviceId)
    || JSON.stringify(second) !== sealed || !unchanged()) {
    throw new Error("Destination Shadow changed during full remote content verification.")
  }
  return Object.freeze({
    integrityScope: "read-only-verified-git-content-to-local-shadow",
    observation: "shadow-matches-verified-destination-uncommitted",
    destinationRepoId: plan.destinationRepoId,
    destinationCommitSha: scope.destinationCommitSha,
    verifiedFileCount: expectedRecords.length,
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
}
