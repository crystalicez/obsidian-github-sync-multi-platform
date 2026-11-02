import { sha256Hex, utf8ToBytes } from "../bytes"
import type { GitHubClient } from "../github-api"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndexAdapter } from "./local-index"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"
import {
  verifyV4ReencryptionShadowAgainstDestination,
  type V4ReencryptionShadowRemoteBindingInput,
} from "./reencryption-shadow-remote-binding"

type DestinationGit = V4ReencryptionShadowRemoteBindingInput["remote"]["github"]
  & Pick<GitHubClient, "branchName" | "getRepositoryDefaultBranch">

export interface V4ColdStartDestinationInput {
  /** Caller must authenticate this persisted D183 contract independently. */
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly adapter: Pick<V4LocalIndexAdapter, "read" | "exists">
  /** Independent current GitHub client scoped to the exact new-key branch. */
  readonly destinationGit: DestinationGit
  /** Pinned from the independently verified old Backup physical repository. */
  readonly expectedPhysicalRepositoryId: number
  /** Caller must reconstruct source config and object receipts from trusted sources. */
  readonly remote: Omit<V4ReencryptionShadowRemoteBindingInput["remote"], "github">
  readonly getSecret: (id: string) => string | null
  readonly assertLiveOwner: () => void
}

export interface V4ColdStartDestinationReport {
  readonly integrityScope: "read-only-exact-destination-git-and-persisted-shadow"
  readonly observation: "complete-destination-still-fenced" | "manual-recovery-required"
  readonly completeDestinationContentsReverified: boolean
  readonly sourceAndShadowSnapshotMatched: boolean
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly coldStartWalReverified: false
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-exact-destination-git-and-persisted-shadow" as const,
  coldStartWalReverified: false as const,
  commitDecisionAuthorized: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})

const MANUAL: V4ColdStartDestinationReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  completeDestinationContentsReverified: false,
  sourceAndShadowSnapshotMatched: false,
  verifiedFileCount: 0,
  verifiedPlaintextBytes: "0",
})

/**
 * Bracket two full D137 remote-content scans by actual local Source/Shadow
 * cache digests and current GitHub identity. No WAL or Cutover authority
 * follows from an authenticated Destination readback.
 */
export async function inspectV4ColdStartDestination(
  input: V4ColdStartDestinationInput,
): Promise<V4ColdStartDestinationReport> {
  try {
    const { adapter, contract, destinationGit: git, remote, getSecret, assertLiveOwner,
      expectedPhysicalRepositoryId } = input
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
      || !git || !remote || typeof getSecret !== "function"
      || typeof assertLiveOwner !== "function"
      || typeof git.getRepositoryDefaultBranch !== "function"
      || !Number.isSafeInteger(expectedPhysicalRepositoryId)
      || expectedPhysicalRepositoryId <= 0) return MANUAL
    assertV4ReencryptionCutoverSnapshotContract(contract)
    const id = contract.identity
    const plan = remote.plan
    if (plan.physicalRepositoryId !== expectedPhysicalRepositoryId
      || plan.sourceRepoId !== id.sourceRepoId || plan.destinationRepoId !== id.destinationRepoId
      || plan.pinnedSourceCommitSha !== id.sourceCommitSha
      || remote.sourceTreeSha !== id.sourceTreeSha
      || remote.destinationCommitSha !== id.destinationCommitSha
      || remote.expectedDestinationConfig.repoId !== id.destinationRepoId
      || remote.sourceConfig.repoId !== id.sourceRepoId
      || git.branchName !== id.destinationRepoId.split("#")[1]
      || remote.destinationPassphrase !== getSecret(id.destinationPassphraseSecretId)) return MANUAL

    const methods = {
      read: adapter.read, exists: adapter.exists,
      repository: git.getRepositoryIdentity, defaultBranch: git.getRepositoryDefaultBranch,
      ref: git.getGitRef, commit: git.getGitCommit, tree: git.getTreeAt, blob: git.getBlob,
    }
    const original = JSON.stringify({
      contract, plan: remote.plan, sourceTree: remote.sourceTreeSha,
      destinationCommit: remote.destinationCommitSha, sourceConfig: remote.sourceConfig,
      destinationConfig: remote.expectedDestinationConfig, receipts: remote.expectedReceipts,
      destinationPassphrase: remote.destinationPassphrase,
    })
    const branch = git.branchName
    const signal = remote.signal
    const secret = remote.destinationPassphrase
    const check = () => {
      assertLiveOwner()
      if (input.adapter !== adapter || input.contract !== contract
        || input.destinationGit !== git || input.remote !== remote
        || input.expectedPhysicalRepositoryId !== expectedPhysicalRepositoryId
        || input.getSecret !== getSecret || input.assertLiveOwner !== assertLiveOwner
        || remote.signal !== signal
        || adapter.read !== methods.read || adapter.exists !== methods.exists
        || git.branchName !== branch || git.getRepositoryIdentity !== methods.repository
        || git.getRepositoryDefaultBranch !== methods.defaultBranch
        || git.getGitRef !== methods.ref || git.getGitCommit !== methods.commit
        || git.getTreeAt !== methods.tree || git.getBlob !== methods.blob
        || JSON.stringify({
          contract, plan: remote.plan, sourceTree: remote.sourceTreeSha,
          destinationCommit: remote.destinationCommitSha, sourceConfig: remote.sourceConfig,
          destinationConfig: remote.expectedDestinationConfig, receipts: remote.expectedReceipts,
          destinationPassphrase: remote.destinationPassphrase,
        }) !== original
        || getSecret(id.destinationPassphraseSecretId) !== secret) {
        throw Error("D238 Destination read-only verification scope changed.")
      }
    }

    const readonlyAdapter: V4LocalIndexAdapter = {
      async read(path) {
        check()
        const text = await methods.read.call(adapter, path)
        check()
        return text
      },
      async exists(path) {
        check()
        const exists = await methods.exists.call(adapter, path)
        check()
        return exists
      },
      async write() { throw Error("D238 cannot write the Index.") },
      async mkdir() { throw Error("D238 cannot create directories.") },
    }
    const readCache = async () => {
      check()
      const source = await loadV4LocalIndex(readonlyAdapter, id.indexRoot)
      const shadow = await loadV4LocalIndex(readonlyAdapter, id.indexRoot + "-rekey-" + id.runId)
      check()
      if (!isV4LocalIndexCacheComplete(source) || !isV4LocalIndexCacheComplete(shadow)
        || source.repoId !== id.sourceRepoId || source.remoteCommitSha !== id.sourceCommitSha
        || source.deviceId !== id.deviceId || source.mode !== "encrypted"
        || shadow.repoId !== id.destinationRepoId || shadow.remoteCommitSha !== id.destinationCommitSha
        || shadow.deviceId !== id.deviceId || shadow.mode !== "encrypted"
        || await sha256Hex(utf8ToBytes(JSON.stringify(source))) !== contract.sourceIndexSha256
        || await sha256Hex(utf8ToBytes(JSON.stringify(shadow))) !== contract.destinationShadowSha256) {
        throw Error("D238 persisted Source/Shadow differs from the pinned Cutover contract.")
      }
      check()
    }
    const checkGit = async () => {
      check()
      const repository = await methods.repository.call(git)
      const defaultBranch = await methods.defaultBranch.call(git)
      const ref = await methods.ref.call(git)
      const commit = await methods.commit.call(git, id.destinationCommitSha)
      check()
      if (commit.sha !== id.destinationCommitSha
        || commit.treeSha !== id.destinationTreeSha
        || !Array.isArray(commit.parentShas) || commit.parentShas.length !== 0
        || repository.id !== expectedPhysicalRepositoryId
        || repository.fullName.toLowerCase() !== id.destinationRepoId.split("#")[0]!.toLowerCase()
        || defaultBranch === branch
        || ref.ref !== "refs/heads/" + branch || ref.type !== "commit"
        || ref.sha !== id.destinationCommitSha) {
        throw Error("D238 Destination physical Git identity or ref changed.")
      }
      return { repositoryId: repository.id, fullName: repository.fullName, defaultBranch }
    }
    const firstGit = await checkGit()
    await readCache()
    const boundRemote: V4ReencryptionShadowRemoteBindingInput["remote"] = {
      ...remote, github: git,
    }
    const bound: V4ReencryptionShadowRemoteBindingInput = {
      adapter: readonlyAdapter, activeIndexRoot: id.indexRoot, runId: id.runId,
      expectedDeviceId: id.deviceId, remote: boundRemote,
      assertExclusiveInitiatorLease: async () => { check() },
      assertCrashDurable: async () => { check() },
    }
    const first = await verifyV4ReencryptionShadowAgainstDestination(bound)
    check()
    await readCache()
    const second = await verifyV4ReencryptionShadowAgainstDestination(bound)
    check()
    await readCache()
    const lastGit = await checkGit()
    if (first.observation !== "shadow-matches-verified-destination-uncommitted"
      || second.observation !== first.observation
      || first.destinationCommitSha !== id.destinationCommitSha
      || second.destinationCommitSha !== id.destinationCommitSha
      || first.destinationRepoId !== id.destinationRepoId
      || second.destinationRepoId !== id.destinationRepoId
      || first.verifiedFileCount !== second.verifiedFileCount
      || first.verifiedPlaintextBytes !== second.verifiedPlaintextBytes
      || JSON.stringify(lastGit) !== JSON.stringify(firstGit)) return MANUAL

    return Object.freeze({
      ...BASE, observation: "complete-destination-still-fenced",
      completeDestinationContentsReverified: true,
      sourceAndShadowSnapshotMatched: true,
      verifiedFileCount: second.verifiedFileCount,
      verifiedPlaintextBytes: second.verifiedPlaintextBytes,
    })
  } catch {
    return MANUAL
  }
}
