import {
  inspectV4ColdStartDestination,
  type V4ColdStartDestinationInput,
} from "./reencryption-cold-start-destination"
import {
  inspectV4ColdStartWalSnapshot,
  type V4ColdStartWalSnapshotInput,
} from "./reencryption-cold-start-wal-snapshot"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"

export interface V4ColdStartWalDestinationInput {
  /** Authentication of this saved contract remains the caller's responsibility. */
  readonly contract: V4ReencryptionCutoverSnapshotContract
  /** The exact old-key journal root and key must be established independently. */
  readonly wal: Omit<V4ColdStartWalSnapshotInput, "contract" | "expectedReceipts">
  /** Includes current, separately pinned new-key GitHub and full Shadow inputs. */
  readonly destination: Omit<V4ColdStartDestinationInput, "contract">
  /** Must exclude cooperating writers for the entire WAL/Git readback. */
  readonly withExclusiveRecoveryLease: <T>(body: () => Promise<T>) => Promise<T>
  readonly assertExclusiveRecoveryLease: () => Promise<void>
  /** A filesystem best-effort readback, NOT physical power-loss durability. */
  readonly assertBestEffortWalCheckpoint: () => Promise<"best-effort-readback-only">
}

export interface V4ColdStartWalDestinationReport {
  readonly integrityScope: "read-only-current-wal-receipts-and-complete-destination"
  readonly observation: "authenticated-wal-and-destination-still-fenced" | "manual-recovery-required"
  readonly walReceiptsBoundToDestination: boolean
  readonly completeDestinationContentsReverified: boolean
  readonly completeOldBackupReverified: false
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly powerLossDurabilityProven: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-current-wal-receipts-and-complete-destination" as const,
  completeOldBackupReverified: false as const,
  powerLossDurabilityProven: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  commitDecisionAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})

const MANUAL: V4ColdStartWalDestinationReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  walReceiptsBoundToDestination: false,
  completeDestinationContentsReverified: false,
  verifiedFileCount: 0,
  verifiedPlaintextBytes: "0",
})

/**
 * Combine current encrypted WAL receipts with two full Destination Git/Shadow
 * reads under one caller-supplied lease and a byte-exact local Sync Fence.
 * Never assumes this proves the old Backup, WAL directory location, physical
 * power-loss safety or any authority to switch indexes or resume Sync.
 */
export async function inspectV4ColdStartWalDestination(
  input: V4ColdStartWalDestinationInput,
): Promise<V4ColdStartWalDestinationReport> {
  let originalKey: Uint8Array | undefined
  try {
    const { contract, wal, destination, withExclusiveRecoveryLease: holder,
      assertExclusiveRecoveryLease: lease, assertBestEffortWalCheckpoint: checkpoint } = input
    if (!contract || !wal || !destination
      || typeof holder !== "function" || typeof lease !== "function"
      || typeof checkpoint !== "function"
      || wal.assertLiveOwner !== destination.assertLiveOwner
      || !(wal.originalJournalKey instanceof Uint8Array)
      || wal.originalJournalKey.length !== 32
      || !Array.isArray(destination.remote?.expectedReceipts)) return MANUAL

    assertV4ReencryptionCutoverSnapshotContract(contract)
    const id = contract.identity
    const contractText = JSON.stringify(contract)
    const remoteText = JSON.stringify(destination.remote)
    const receipts = destination.remote.expectedReceipts
    const signal = destination.remote.signal
    const key = wal.originalJournalKey
    originalKey = Uint8Array.from(key)
    const reader = {
      wal: wal.adapter, walRead: wal.adapter.read, walExists: wal.adapter.exists,
      root: wal.root, index: destination.adapter,
      indexRead: destination.adapter.read, indexExists: destination.adapter.exists,
      git: destination.destinationGit,
      gitRef: destination.destinationGit.getGitRef,
      gitBlob: destination.destinationGit.getBlob,
      gitRepo: destination.destinationGit.getRepositoryIdentity,
      gitDefaultBranch: destination.destinationGit.getRepositoryDefaultBranch,
      gitCommit: destination.destinationGit.getGitCommit,
      gitTree: destination.destinationGit.getTreeAt,
      secret: destination.getSecret, owner: destination.assertLiveOwner,
      physical: destination.expectedPhysicalRepositoryId,
    }
    const unchanged = () => input.contract === contract && input.wal === wal
      && input.destination === destination
      && input.withExclusiveRecoveryLease === holder
      && input.assertExclusiveRecoveryLease === lease
      && input.assertBestEffortWalCheckpoint === checkpoint
      && wal.adapter === reader.wal && wal.root === reader.root
      && wal.adapter.read === reader.walRead && wal.adapter.exists === reader.walExists
      && wal.originalJournalKey === key
      && key.every((byte, i) => byte === originalKey![i])
      && wal.assertLiveOwner === reader.owner
      && destination.adapter === reader.index
      && destination.adapter.read === reader.indexRead
      && destination.adapter.exists === reader.indexExists
      && destination.destinationGit === reader.git
      && destination.destinationGit.getGitRef === reader.gitRef
      && destination.destinationGit.getBlob === reader.gitBlob
      && destination.destinationGit.getRepositoryIdentity === reader.gitRepo
      && destination.destinationGit.getRepositoryDefaultBranch === reader.gitDefaultBranch
      && destination.destinationGit.getGitCommit === reader.gitCommit
      && destination.destinationGit.getTreeAt === reader.gitTree
      && destination.getSecret === reader.secret
      && reader.secret(id.destinationPassphraseSecretId) === destination.remote.destinationPassphrase
      && destination.expectedPhysicalRepositoryId === reader.physical
      && destination.assertLiveOwner === reader.owner
      && destination.remote.expectedReceipts === receipts
      && destination.remote.signal === signal
      && JSON.stringify(destination.remote) === remoteText
      && JSON.stringify(contract) === contractText
    const check = () => {
      reader.owner()
      if (!unchanged()) throw Error("D239 cold-start WAL/Destination scope changed.")
    }
    const boundary = async () => {
      check()
      await lease()
      check()
      if (await checkpoint() !== "best-effort-readback-only") {
        throw Error("D239 best-effort WAL checkpoint failed.")
      }
      check()
      await assertV4ReencryptionExactSyncFence(destination.adapter, {
        runId: id.runId, sourceRepoId: id.sourceRepoId,
        destinationRepoId: id.destinationRepoId,
      }, async () => { await lease(); check() })
      check()
    }

    const currentGit = async () => {
      check()
      const github = reader.git
      const [repository, defaultBranch, ref, commit] = await Promise.all([
        reader.gitRepo.call(github), reader.gitDefaultBranch.call(github),
        reader.gitRef.call(github), reader.gitCommit.call(github, id.destinationCommitSha),
      ])
      check()
      const [ownerRepo, branch] = id.destinationRepoId.split("#")
      if (!ownerRepo || !branch || repository.id !== reader.physical
        || repository.fullName.toLowerCase() !== ownerRepo.toLowerCase()
        || defaultBranch === branch || ref.ref !== "refs/heads/" + branch
        || ref.type !== "commit" || ref.sha !== id.destinationCommitSha
        || commit.sha !== id.destinationCommitSha || commit.treeSha !== id.destinationTreeSha
        || !Array.isArray(commit.parentShas) || commit.parentShas.length !== 0) {
        throw Error("D239 remote Destination identity changed outside full-content scan.")
      }
      return JSON.stringify({ physical: repository.id, name: repository.fullName, defaultBranch })
    }

    let invoked = false
    const report = await holder(async () => {
      if (invoked) throw Error("D239 recovery holder entered twice.")
      invoked = true
      const firstGit = await currentGit()
      await boundary()
      const walInput = { ...wal, contract, expectedReceipts: receipts }
      const firstWal = await inspectV4ColdStartWalSnapshot(walInput)
      if (firstWal.observation !== "authenticated-current-wal-still-fenced"
        || !firstWal.walSnapshotAuthenticated) throw Error("D239 WAL receipts not authenticated.")
      await boundary()
      const destinationReport = await inspectV4ColdStartDestination({ ...destination, contract })
      if (destinationReport.observation !== "complete-destination-still-fenced"
        || !destinationReport.completeDestinationContentsReverified) {
        throw Error("D239 complete Destination content changed.")
      }
      await boundary()
      const secondWal = await inspectV4ColdStartWalSnapshot(walInput)
      if (secondWal.observation !== firstWal.observation
        || !secondWal.walSnapshotAuthenticated) {
        throw Error("D239 WAL receipts changed during Git scan.")
      }
      await boundary()
      if (await currentGit() !== firstGit) {
        throw Error("D239 Destination ref or repository changed during combined scan.")
      }
      await boundary()
      return Object.freeze({
        ...BASE, observation: "authenticated-wal-and-destination-still-fenced" as const,
        walReceiptsBoundToDestination: true,
        completeDestinationContentsReverified: true,
        verifiedFileCount: destinationReport.verifiedFileCount,
        verifiedPlaintextBytes: destinationReport.verifiedPlaintextBytes,
      })
    })
    check()
    return invoked && report.observation === "authenticated-wal-and-destination-still-fenced"
      ? report : MANUAL
  } catch {
    return MANUAL
  } finally {
    originalKey?.fill(0)
  }
}
