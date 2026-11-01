import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4LocalIndexAdapter } from "./local-index"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import type { V4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"
import {
  assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal,
  type V4ReencryptionProposedCommitIdentity,
} from "./reencryption-proposed-commit-receipt"
import {
  verifyGitHubFrozenReencryptionBackup,
  type V4GitHubFrozenBackupVerificationInput,
} from "./reencryption-trusted-loader"

export interface V4FencedFrozenBackupContentInput {
  readonly identity: V4ReencryptionProposedCommitIdentity
  readonly backup: V4GitHubFrozenBackupVerificationInput
  readonly adapter: Pick<V4LocalIndexAdapter, "exists" | "read">
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
}

export interface V4FencedFrozenBackupContentReport {
  readonly integrityScope: "read-only-fenced-live-frozen-backup-all-objects"
  readonly observation: "complete-frozen-backup-reverified-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly completeBackupContentReverified: boolean
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-live-frozen-backup-all-objects" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4FencedFrozenBackupContentReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required", completeBackupContentReverified: false,
  verifiedFileCount: 0, verifiedPlaintextBytes: "0",
})

/**
 * Independently decrypt every ciphertext behind the current frozen Backup
 * branch twice, bracketed by an exact Sync Fence and an authenticated WAL
 * readback under one cooperative lease. D94 checks the pinned source commit,
 * physical repository, immutable tree/blob hashes, metadata and plaintext
 * SHA-256. Neither the fence nor WAL readback is a physical durability proof.
 * This returns evidence for later Recovery, never permission to change state.
 */
export async function inspectV4FencedFrozenBackupContentAfterRestart(
  input: V4FencedFrozenBackupContentInput,
): Promise<V4FencedFrozenBackupContentReport> {
  const id = input?.identity
  const backup = input?.backup
  const adapter = input?.adapter
  const wal = input?.wal
  const journal = input?.journal
  const lease = input?.assertExclusiveInitiatorLease
  const holder = input?.withExclusiveInitiatorLease
  const github = backup?.github
  const plan = backup?.plan
  try {
    assertV4ReencryptionProposedCommitIdentity(id)
    if (!backup || !adapter || typeof adapter.read !== "function"
      || typeof adapter.exists !== "function" || !wal || !journal || !github
      || typeof lease !== "function" || typeof holder !== "function"
      || typeof wal.assertExclusiveStageLease !== "function"
      || typeof wal.assertBestEffortCheckpoint !== "function"
      || typeof journal.assertHealthySnapshot !== "function"
      || journal.sourceCommitSha !== id.sourceCommitSha
      || journal.destinationRepoId !== id.destinationRepoId
      || plan?.sourceRepoId !== id.sourceRepoId || plan.backupRepoId !== id.backupRepoId
      || plan.destinationRepoId !== id.destinationRepoId
      || plan.pinnedSourceCommitSha !== id.sourceCommitSha
      || backup.expectedSourceTreeSha !== id.sourceTreeSha
      || typeof backup.passphrase !== "string" || !backup.passphrase) return MANUAL
    const initial = JSON.stringify({ identity: id, plan, tree: backup.expectedSourceTreeSha })
    const passphrase = backup.passphrase
    const signal = backup.signal
    const pinned = {
      repo: github.getRepositoryIdentity, ref: github.getGitRef,
      commit: github.getGitCommit, tree: github.getTreeAt, blob: github.getBlob,
      walLease: wal.assertExclusiveStageLease, checkpoint: wal.assertBestEffortCheckpoint,
      snapshot: journal.assertHealthySnapshot, exists: adapter.exists, read: adapter.read,
      branch: github.branchName,
    }
    const unchanged = () => input.identity === id && input.backup === backup
      && input.adapter === adapter && input.wal === wal && input.journal === journal
      && input.assertExclusiveInitiatorLease === lease
      && input.withExclusiveInitiatorLease === holder
      && backup.github === github && backup.plan === plan && backup.passphrase === passphrase
      && backup.signal === signal
      && JSON.stringify({ identity: id, plan, tree: backup.expectedSourceTreeSha }) === initial
      && github.branchName === pinned.branch
      && github.getRepositoryIdentity === pinned.repo && github.getGitRef === pinned.ref
      && github.getGitCommit === pinned.commit && github.getTreeAt === pinned.tree
      && github.getBlob === pinned.blob
      && wal.assertExclusiveStageLease === pinned.walLease
      && wal.assertBestEffortCheckpoint === pinned.checkpoint
      && journal.assertHealthySnapshot === pinned.snapshot
      && journal.sourceCommitSha === id.sourceCommitSha
      && journal.destinationRepoId === id.destinationRepoId
      && adapter.read === pinned.read && adapter.exists === pinned.exists
    const assertHeld = async () => {
      if (!unchanged()) throw Error("Frozen Backup identity changed.")
      await lease()
      await pinned.walLease.call(wal)
      if (await pinned.checkpoint.call(wal) !== "best-effort-readback-only") {
        throw Error("Frozen Backup WAL best-effort checkpoint unavailable.")
      }
      const snapshot = await pinned.snapshot.call(journal, id.walGeneration)
      if (!matchesV4ReencryptionPreparedWal(snapshot, id) || !unchanged()) {
        throw Error("Frozen Backup WAL no longer authenticates the three-branch source.")
      }
    }
    const fence = () => assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, assertHeld)

    let invoked = false
    const report = await holder(async () => {
      if (invoked) throw Error("Frozen Backup lease callback invoked twice.")
      invoked = true
      await fence()
      const first = await verifyGitHubFrozenReencryptionBackup(backup)
      await fence()
      const second = await verifyGitHubFrozenReencryptionBackup(backup)
      await fence()
      if (!unchanged() || first.backupContentsReadbackVerified !== true
        || second.backupContentsReadbackVerified !== true
        || first.verifiedFileCount !== second.verifiedFileCount
        || first.verifiedRemoteObjectCount !== second.verifiedRemoteObjectCount
        || first.verifiedPlaintextBytes !== second.verifiedPlaintextBytes
        || first.backupRepoId !== second.backupRepoId
        || first.pinnedSourceCommitSha !== second.pinnedSourceCommitSha
        || first.pinnedSourceTreeSha !== second.pinnedSourceTreeSha) {
        throw Error("Frozen Backup content or identity changed across full reads.")
      }
      return Object.freeze({
        ...BASE, observation: "complete-frozen-backup-reverified-uncommitted" as const,
        completeBackupContentReverified: true as const,
        verifiedFileCount: first.verifiedFileCount,
        verifiedPlaintextBytes: first.verifiedPlaintextBytes,
      })
    })
    if (!invoked || !unchanged()
      || report.observation !== "complete-frozen-backup-reverified-uncommitted") return MANUAL
    return report
  } catch {
    return MANUAL
  }
}
