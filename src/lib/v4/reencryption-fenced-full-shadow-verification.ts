import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  inspectV4FencedThreeBranchPublicationAfterRestart,
  type V4FencedThreeBranchRevalidationInput,
} from "./reencryption-fenced-three-branch-revalidation"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import {
  verifyV4ReencryptionShadowAgainstDestination,
  type V4ReencryptionShadowRemoteBindingInput,
} from "./reencryption-shadow-remote-binding"

const RISK = "accept-best-effort-power-loss-recovery-risk"

export interface V4FencedFullRemoteShadowInput {
  readonly branches: V4FencedThreeBranchRevalidationInput
  /** D137 rechecks every committed Git blob under the NEW passphrase. */
  readonly shadow: Omit<V4ReencryptionShadowRemoteBindingInput, "assertCrashDurable">
}

export interface V4FencedFullRemoteShadowReport {
  readonly integrityScope: "read-only-fenced-full-destination-content-and-shadow"
  readonly observation: "complete-destination-matches-shadow-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly completeRemoteContentReverified: boolean
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-full-destination-content-and-shadow" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4FencedFullRemoteShadowReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required", completeRemoteContentReverified: false,
})
const OBSERVED: V4FencedFullRemoteShadowReport = Object.freeze({
  ...BASE, observation: "complete-destination-matches-shadow-uncommitted",
  completeRemoteContentReverified: true,
})

/**
 * D178 non-mutating composition:
 *   D177 pinned three branches + Fence + WAL
 *   D137 full encrypted Git tree / every ciphertext blob / decrypted SHA
 *        bound to the immutable local destination Shadow
 *   D177 second full three-branch observation + WAL and Fence
 *
 * The one outer cooperative lease must exclude local migration writers.
 * D137's existing strict entrypoint calls a checkpoint at every boundary;
 * this adapter provides authenticated best-effort WAL *readback*, NOT fsync.
 * It never confers durability or any commit/cutover/sync permission.
 */
export async function inspectV4FencedFullRemoteShadowAfterRestart(
  input: V4FencedFullRemoteShadowInput,
): Promise<V4FencedFullRemoteShadowReport> {
  const branches = input?.branches
  const shadow = input?.shadow
  if (!branches?.identity || !shadow?.remote) return MANUAL
  const id = { ...branches.identity }
  const remote = shadow.remote
  const plan = remote.plan
  const github = remote.github
  const adapter = branches.adapter
  const wal = branches.wal
  const journal = branches.journal
  const lease = branches.assertExclusiveInitiatorLease
  const holder = branches.withExclusiveInitiatorLease
  if (branches.acknowledgement !== RISK || !branches.publication
    || shadow.adapter !== adapter
    || shadow.assertExclusiveInitiatorLease !== lease
    || shadow.activeIndexRoot !== id.indexRoot || shadow.runId !== id.runId
    || shadow.expectedDeviceId !== id.deviceId
    || remote.destinationCommitSha !== id.destinationCommitSha
    || remote.sourceTreeSha !== id.sourceTreeSha
    || remote.expectedDestinationConfig?.repoId !== id.destinationRepoId
    || plan?.sourceRepoId !== id.sourceRepoId
    || plan.destinationRepoId !== id.destinationRepoId
    || plan.pinnedSourceCommitSha !== id.sourceCommitSha
    || plan.physicalRepositoryId !== branches.physicalRepositoryId
    || github !== (branches.readers?.destination as unknown)
    || typeof github?.getGitRef !== "function"
    || typeof github.getTreeAt !== "function"
    || typeof github.getBlob !== "function"
    || typeof adapter?.read !== "function" || typeof adapter.exists !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof lease !== "function" || typeof holder !== "function") return MANUAL

  const originalIdentity = JSON.stringify(id)
  const expectedRemote = JSON.stringify({
    plan: remote.plan, sourceConfig: remote.sourceConfig,
    destinationConfig: remote.expectedDestinationConfig,
    receipts: remote.expectedReceipts,
    passphrase: remote.destinationPassphrase,
    tree: remote.sourceTreeSha, commit: remote.destinationCommitSha,
  })
  const published = branches.publication
  const publicationBytes = JSON.stringify(published)
  const repoId = branches.physicalRepositoryId
  const readers = branches.readers
  const pinnedReaders = (["source", "backup", "destination"] as const).map(role => {
    const client = readers[role]
    return {
      role, client, branch: client.branchName,
      repository: client.getRepositoryIdentity,
      defaultBranch: client.getRepositoryDefaultBranch,
      ref: client.getGitRefOrNull,
      commit: client.getGitCommit,
    }
  })
  const adapterRead = adapter.read
  const adapterExists = adapter.exists
  const checkpoint = wal.assertBestEffortCheckpoint
  const walLease = wal.assertExclusiveStageLease
  const walRead = journal.assertHealthySnapshot
  const ghMethods = {
    repo: github.getRepositoryIdentity,
    ref: github.getGitRef,
    commit: github.getGitCommit,
    tree: github.getTreeAt,
    blob: github.getBlob,
  }
  const originalShadow = shadow
  const originalBranches = branches
  const sourceFence = Object.freeze({
    runId: id.runId,
    sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  })
  const unchanged = () => input.branches === originalBranches && input.shadow === originalShadow
    && JSON.stringify(branches.identity) === originalIdentity
    && branches.publication === published
    && JSON.stringify(branches.publication) === publicationBytes
    && branches.physicalRepositoryId === repoId
    && branches.readers === readers
    && pinnedReaders.every(p => {
      const current = readers[p.role]
      return current === p.client && current.branchName === p.branch
        && current.getRepositoryIdentity === p.repository
        && current.getRepositoryDefaultBranch === p.defaultBranch
        && current.getGitRefOrNull === p.ref
        && current.getGitCommit === p.commit
    })
    && adapter.read === adapterRead && adapter.exists === adapterExists
    && shadow.remote === remote && remote.github === github
    && shadow.adapter === adapter && branches.adapter === adapter
    && shadow.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && branches.withExclusiveInitiatorLease === holder
    && branches.wal === wal && branches.journal === journal
    && wal.assertExclusiveStageLease === walLease
    && wal.assertBestEffortCheckpoint === checkpoint
    && journal.assertHealthySnapshot === walRead
    && github.getRepositoryIdentity === ghMethods.repo
    && github.getGitRef === ghMethods.ref
    && github.getGitCommit === ghMethods.commit
    && github.getTreeAt === ghMethods.tree && github.getBlob === ghMethods.blob
    && JSON.stringify({
      plan: remote.plan, sourceConfig: remote.sourceConfig,
      destinationConfig: remote.expectedDestinationConfig,
      receipts: remote.expectedReceipts,
      passphrase: remote.destinationPassphrase,
      tree: remote.sourceTreeSha, commit: remote.destinationCommitSha,
    }) === expectedRemote
    && shadow.activeIndexRoot === id.indexRoot && shadow.runId === id.runId
    && shadow.expectedDeviceId === id.deviceId
    && branches.acknowledgement === RISK

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D178 migration run or remote inputs changed.")
    await lease()
    await walLease.call(wal)
    if (await checkpoint.call(wal) !== "best-effort-readback-only" || !unchanged()) {
      throw Error("D178 best-effort authenticated WAL readback failed.")
    }
  }
  const checkWalReceipts = async () => {
    await assertHeld()
    const snapshot = await walRead.call(journal, id.walGeneration)
    if (!unchanged() || !matchesV4ReencryptionPreparedWal(snapshot, id)
      || !Array.isArray(remote.expectedReceipts)
      || snapshot.receipts.length !== remote.expectedReceipts.length) {
      throw Error("D178 ciphertext receipts do not match authenticated WAL.")
    }
    const receipts = new Map(snapshot.receipts.map(r => [r.path, r] as const))
    const expected = new Set<string>()
    if (receipts.size !== snapshot.receipts.length || remote.expectedReceipts.some(r => {
      if (!r || expected.has(r.path)) return true
      expected.add(r.path)
      const item = receipts.get(r.path)
      return !item || item.sha !== r.sha || item.byteLength !== r.byteLength
    })) throw Error("D178 ciphertext receipts do not match authenticated WAL.")
    return JSON.stringify(snapshot)
  }
  const inspectBranches = async () => {
    if (!unchanged()) throw Error("D178 three-branch evidence changed.")
    // The outer holder is already acquired. D177's inner callback MUST run
    // only inside it, rather than recursively acquiring a non-reentrant lease.
    const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
      await assertHeld()
      const result = await body()
      await assertHeld()
      return result
    }
    const report = await inspectV4FencedThreeBranchPublicationAfterRestart({
      ...branches, withExclusiveInitiatorLease: borrowed,
    })
    if (report.observation !== "three-refs-match-pinned-wal-uncommitted"
      || report.completeRemoteContentReverified !== false
      || !unchanged()) throw Error("D178 three branches no longer match pinned WAL.")
  }

  let invoked = false
  try {
    const result = await holder(async () => {
      if (invoked) throw Error("D178 holder re-entered.")
      invoked = true
      await assertV4ReencryptionExactSyncFence(adapter, sourceFence, assertHeld)
      await inspectBranches()
      const walBefore = await checkWalReceipts()

      const complete = await verifyV4ReencryptionShadowAgainstDestination({
        ...shadow,
        // D137 only *reads* here. This is explicitly a best-effort readback
        // adapter; it is NOT a physical crash-durability assertion.
        assertCrashDurable: assertHeld,
      })
      if (!unchanged()
        || complete.integrityScope !== "read-only-verified-git-content-to-local-shadow"
        || complete.observation !== "shadow-matches-verified-destination-uncommitted"
        || complete.destinationRepoId !== id.destinationRepoId
        || complete.destinationCommitSha !== id.destinationCommitSha
        || complete.verifiedFileCount !== published.verifiedFileCount
        || complete.verifiedPlaintextBytes !== published.verifiedPlaintextBytes
        || complete.localCutoverAuthorized !== false || complete.resumeSyncAuthorized !== false) {
        throw Error("D178 complete remote ciphertext/plaintext proof differs from pinned publication.")
      }

      await assertV4ReencryptionExactSyncFence(adapter, sourceFence, assertHeld)
      await inspectBranches()
      const walAfter = await checkWalReceipts()
      if (walBefore !== walAfter || !unchanged()) {
        throw Error("D178 WAL or Fence changed during full-content verification.")
      }
      return OBSERVED
    })
    return invoked && unchanged() && result === OBSERVED ? OBSERVED : MANUAL
  } catch {
    return MANUAL
  }
}
