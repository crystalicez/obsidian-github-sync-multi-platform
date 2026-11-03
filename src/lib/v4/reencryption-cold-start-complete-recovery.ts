import {
  inspectV4ReencryptionColdStartJournalKey,
  type V4ReencryptionColdStartJournalInput,
} from "./reencryption-cold-start-journal-key"
import {
  inspectV4ColdStartWalDestination,
  type V4ColdStartWalDestinationInput,
} from "./reencryption-cold-start-wal-destination"
import { assertV4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"

/**
 * One exclusively held, read-only recovery scope. The old-key source/Backup
 * and new-key WAL/Destination inputs must be pinned to the SAME live owner,
 * local Index and SecretStorage. An OS or initiating-device lease is a
 * caller-provided capability, not something this pure coordinator can infer.
 */
export interface V4ColdStartCompleteRecoveryInput {
  readonly backup: Omit<V4ReencryptionColdStartJournalInput, "expectedRecoveryBinding">
  readonly current: Omit<V4ColdStartWalDestinationInput,
    "withExclusiveRecoveryLease" | "assertExclusiveRecoveryLease" | "assertBestEffortWalCheckpoint">
  readonly withExclusiveRecoveryLease: <T>(body: () => Promise<T>) => Promise<T>
  readonly assertExclusiveRecoveryLease: () => Promise<void>
  readonly assertBestEffortWalCheckpoint: () => Promise<"best-effort-readback-only">
}

export interface V4ColdStartCompleteRecoveryReport {
  readonly integrityScope: "read-only-original-backup-encrypted-wal-complete-destination"
  readonly observation: "authenticated-complete-recovery-evidence-still-fenced" | "manual-recovery-required"
  readonly originalKeyAuthenticated: boolean
  readonly completeOldBackupReverified: boolean
  readonly walReceiptsBoundToDestination: boolean
  readonly completeDestinationContentsReverified: boolean
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly powerLossDurabilityProven: false
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-original-backup-encrypted-wal-complete-destination" as const,
  powerLossDurabilityProven: false as const,
  commitDecisionAuthorized: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ColdStartCompleteRecoveryReport = Object.freeze({
  ...BASE,
  observation: "manual-recovery-required",
  originalKeyAuthenticated: false,
  completeOldBackupReverified: false,
  walReceiptsBoundToDestination: false,
  completeDestinationContentsReverified: false,
  verifiedFileCount: 0,
  verifiedPlaintextBytes: "0",
})

/**
 * D247 joins the D236 frozen old-key Backup proof and D239 encrypted WAL/new
 * Destination proof *inside one* caller-held recovery lease. The old Backup
 * is authenticated before and AFTER the full Destination scan, never inferred
 * from it. Any mismatch or drift preserves every byte and requires Manual
 * Recovery. The result can NEVER authorize a write, Cutover or Sync resume.
 */
export async function inspectV4ColdStartCompleteRecovery(
  input: V4ColdStartCompleteRecoveryInput,
): Promise<V4ColdStartCompleteRecoveryReport> {
  let keyCopy: Uint8Array | undefined
  try {
    const { backup, current, withExclusiveRecoveryLease: holder,
      assertExclusiveRecoveryLease: lease, assertBestEffortWalCheckpoint: checkpoint } = input
    if (!backup || !current || typeof holder !== "function"
      || typeof lease !== "function" || typeof checkpoint !== "function"
      || !current.wal || !current.destination || !current.contract
      || !(current.wal.originalJournalKey instanceof Uint8Array)
      || current.wal.originalJournalKey.length !== 32
      || backup.assertLiveOwner !== current.wal.assertLiveOwner
      || backup.assertLiveOwner !== current.destination.assertLiveOwner
      || backup.adapter !== current.destination.adapter
      || backup.getSecret !== current.destination.getSecret
      || Object.hasOwn(backup, "expectedRecoveryBinding")) return MANUAL
    assertV4ReencryptionCutoverSnapshotContract(current.contract)
    const { contract, wal, destination } = current
    const contractText = JSON.stringify(contract)
    const oldKey = wal.originalJournalKey
    keyCopy = Uint8Array.from(oldKey)
    const immutable = {
      contract, wal, destination,
      physicalRepositoryId: destination.expectedPhysicalRepositoryId,
      walRoot: wal.root, walRead: wal.adapter.read, walExists: wal.adapter.exists,
      indexRead: backup.adapter.read, indexExists: backup.adapter.exists,
      backupBranch: backup.backupGit.branchName,
      backupRepo: backup.backupGit.getRepositoryIdentity,
      backupDefault: backup.backupGit.getRepositoryDefaultBranch,
      backupRef: backup.backupGit.getGitRef,
      backupCommit: backup.backupGit.getGitCommit,
      backupTree: backup.backupGit.getTreeAt,
      backupBlob: backup.backupGit.getBlob,
      destinationBranch: destination.destinationGit.branchName,
      destinationRepo: destination.destinationGit.getRepositoryIdentity,
      destinationDefault: destination.destinationGit.getRepositoryDefaultBranch,
      destinationRef: destination.destinationGit.getGitRef,
      destinationCommit: destination.destinationGit.getGitCommit,
      destinationTree: destination.destinationGit.getTreeAt,
      destinationBlob: destination.destinationGit.getBlob,
      originalJournalKey: oldKey,
      backupGit: backup.backupGit,
      backupAdapter: backup.adapter,
      backupSecret: backup.getSecret,
      backupOwner: backup.assertLiveOwner,
      backupPersisted: backup.readPersistedPluginData,
      walAdapter: wal.adapter,
      destinationGit: destination.destinationGit,
      destinationRemote: destination.remote,
    }
    const unchanged = () => input.backup === backup && input.current === current
      && input.withExclusiveRecoveryLease === holder
      && input.assertExclusiveRecoveryLease === lease
      && input.assertBestEffortWalCheckpoint === checkpoint
      && current.contract === immutable.contract
      && JSON.stringify(current.contract) === contractText
      && current.wal === immutable.wal && current.destination === immutable.destination
      && wal.originalJournalKey === immutable.originalJournalKey
      && keyCopy !== undefined && oldKey.every((v, i) => v === keyCopy![i])
      && backup.backupGit === immutable.backupGit
      && backup.backupGit.branchName === immutable.backupBranch
      && backup.backupGit.getRepositoryIdentity === immutable.backupRepo
      && backup.backupGit.getRepositoryDefaultBranch === immutable.backupDefault
      && backup.backupGit.getGitRef === immutable.backupRef
      && backup.backupGit.getGitCommit === immutable.backupCommit
      && backup.backupGit.getTreeAt === immutable.backupTree
      && backup.backupGit.getBlob === immutable.backupBlob
      && backup.adapter === immutable.backupAdapter
      && backup.adapter.read === immutable.indexRead
      && backup.adapter.exists === immutable.indexExists
      && backup.getSecret === immutable.backupSecret
      && backup.assertLiveOwner === immutable.backupOwner
      && backup.readPersistedPluginData === immutable.backupPersisted
      && !Object.hasOwn(backup, "expectedRecoveryBinding")
      && wal.adapter === immutable.walAdapter
      && wal.root === immutable.walRoot
      && wal.adapter.read === immutable.walRead
      && wal.adapter.exists === immutable.walExists
      && destination.expectedPhysicalRepositoryId === immutable.physicalRepositoryId
      && destination.destinationGit === immutable.destinationGit
      && destination.destinationGit.branchName === immutable.destinationBranch
      && destination.destinationGit.getRepositoryIdentity === immutable.destinationRepo
      && destination.destinationGit.getRepositoryDefaultBranch === immutable.destinationDefault
      && destination.destinationGit.getGitRef === immutable.destinationRef
      && destination.destinationGit.getGitCommit === immutable.destinationCommit
      && destination.destinationGit.getTreeAt === immutable.destinationTree
      && destination.destinationGit.getBlob === immutable.destinationBlob
      && destination.remote === immutable.destinationRemote
      && wal.assertLiveOwner === immutable.backupOwner
      && destination.assertLiveOwner === immutable.backupOwner
      && destination.adapter === immutable.backupAdapter
      && destination.getSecret === immutable.backupSecret
    const check = () => {
      immutable.backupOwner()
      if (!unchanged()) throw Error("D247 one-owner recovery inputs changed.")
    }
    const boundary = async () => {
      check()
      await lease()
      check()
      if (await checkpoint() !== "best-effort-readback-only") {
        throw Error("D247 existing WAL checkpoint not verified.")
      }
      check()
    }
    let entered = false
    let reentryAttempted = false
    let verifiedReport: V4ColdStartCompleteRecoveryReport | undefined
    const report = await holder(async () => {
      if (entered) {
        reentryAttempted = true
        throw Error("D247 recovery lease was reentered.")
      }
      entered = true
      await boundary()
      const physical = await immutable.backupGit.getRepositoryIdentity()
      await boundary()
      if (!physical || physical.id !== destination.expectedPhysicalRepositoryId) {
        throw Error("D247 frozen Backup and Destination physical repositories differ.")
      }
      const initialDestinationDefault = await immutable.destinationDefault.call(
        immutable.destinationGit,
      )
      await boundary()
      // Never copy the key back into a caller-visible report. D236 independently
      // authenticates it against the old frozen encrypted HEAD and full tree.
      const expectedRecoveryBinding = {
        contract, originalJournalKey: oldKey,
      }
      const first = await inspectV4ReencryptionColdStartJournalKey({
        ...backup, expectedRecoveryBinding,
      })
      if (first.observation !== "authenticated-local-route-still-fenced"
        || !first.originalKeyAuthenticated || !first.completeBackupContentsReverified
        || !first.recoveredKeyAndContractBoundToCaller) {
        throw Error("D247 original key/Backup not authenticated.")
      }
      await boundary()
      const currentReport = await inspectV4ColdStartWalDestination({
        ...current,
        withExclusiveRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
          // Outer holder already owns the one recovery lease. Do not reacquire
          // a non-reentrant OS lock for the inner D239 verifier.
          await boundary()
          return body()
        },
        assertExclusiveRecoveryLease: lease,
        assertBestEffortWalCheckpoint: checkpoint,
      })
      if (currentReport.observation !== "authenticated-wal-and-destination-still-fenced"
        || !currentReport.walReceiptsBoundToDestination
        || !currentReport.completeDestinationContentsReverified) {
        throw Error("D247 WAL/Destination not authenticated.")
      }
      await boundary()
      const second = await inspectV4ReencryptionColdStartJournalKey({
        ...backup, expectedRecoveryBinding,
      })
      if (second.observation !== first.observation
        || !second.originalKeyAuthenticated || !second.completeBackupContentsReverified
        || !second.recoveredKeyAndContractBoundToCaller
        || second.diagnosticIndexRoot !== first.diagnosticIndexRoot) {
        throw Error("D247 frozen old Backup changed during Destination readback.")
      }
      await boundary()
      const lastPhysical = await immutable.backupGit.getRepositoryIdentity()
      await boundary()
      if (lastPhysical.id !== physical.id || lastPhysical.fullName !== physical.fullName) {
        throw Error("D247 physical Backup repository changed during readback.")
      }
      // The Destination may be moved *after* D239 finishes while the second
      // complete old-key Backup scan is still reading Git. Never return a
      // joined success based on the stale D239 ref observation.
      const [lastDestinationRepo, lastDestinationDefault, lastDestinationRef, lastDestinationCommit] =
        await Promise.all([
          immutable.destinationRepo.call(immutable.destinationGit),
          immutable.destinationDefault.call(immutable.destinationGit),
          immutable.destinationRef.call(immutable.destinationGit),
          immutable.destinationCommit.call(immutable.destinationGit, contract.identity.destinationCommitSha),
        ])
      await boundary()
      const [expectedRepo, expectedBranch] = contract.identity.destinationRepoId.split("#")
      if (!expectedRepo || !expectedBranch
        || lastDestinationRepo.id !== destination.expectedPhysicalRepositoryId
        || lastDestinationRepo.fullName.toLowerCase() !== expectedRepo.toLowerCase()
        || lastDestinationDefault !== initialDestinationDefault
        || lastDestinationDefault === expectedBranch
        || lastDestinationRef.ref !== "refs/heads/" + expectedBranch
        || lastDestinationRef.type !== "commit"
        || lastDestinationRef.sha !== contract.identity.destinationCommitSha
        || lastDestinationCommit.sha !== contract.identity.destinationCommitSha
        || lastDestinationCommit.treeSha !== contract.identity.destinationTreeSha
        || !Array.isArray(lastDestinationCommit.parentShas)
        || lastDestinationCommit.parentShas.length !== 0) {
        throw Error("D247 Destination ref or orphan commit changed after old Backup scan.")
      }
      verifiedReport = Object.freeze({
        ...BASE,
        observation: "authenticated-complete-recovery-evidence-still-fenced" as const,
        originalKeyAuthenticated: true,
        completeOldBackupReverified: true,
        walReceiptsBoundToDestination: true,
        completeDestinationContentsReverified: true,
        verifiedFileCount: currentReport.verifiedFileCount,
        verifiedPlaintextBytes: currentReport.verifiedPlaintextBytes,
      })
      return verifiedReport
    })
    check()
    return entered && !reentryAttempted && verifiedReport === report
      && report.observation === "authenticated-complete-recovery-evidence-still-fenced"
      ? report : MANUAL
  } catch {
    return MANUAL
  } finally {
    keyCopy?.fill(0)
  }
}
