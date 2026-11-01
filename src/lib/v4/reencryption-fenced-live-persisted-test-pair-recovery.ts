import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import type { V4FencedFrozenBackupContentInput } from "./reencryption-fenced-backup-content"
import type { V4FencedFullRemoteShadowInput } from "./reencryption-fenced-full-shadow-verification"
import {
  inspectV4FencedLivePostCrashAndBackupAfterRestart,
} from "./reencryption-fenced-live-post-crash-verification"
import {
  inspectV4FencedPersistedTestPairAfterRestart,
} from "./reencryption-fenced-persisted-test-pair-restart"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  decodeV4ReencryptionPersistedTestContract,
  V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES,
} from "./reencryption-persisted-test-contract"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"

const RISK = "accept-best-effort-power-loss-recovery-risk"
const ROLES = ["source", "backup", "destination"] as const

/** D221 internal read-only witness; even complete content proof is NOT a commit. */
export interface V4FencedLivePersistedTestPairAndBackupInput {
  readonly prepared: V4BestEffortPreparedSelectorStageInput
  readonly remote: V4FencedFullRemoteShadowInput
  readonly backup: V4FencedFrozenBackupContentInput
}

export interface V4FencedLivePersistedTestPairAndBackupReport {
  readonly integrityScope: "read-only-restarted-test-pair-current-git-and-frozen-backup"
  readonly observation: "manual-recovery-required"
  readonly reason: "test-pair-and-full-remote-coherent-but-not-a-commit" | "local-or-current-git-proof-uncertain"
  readonly historicalTestPairCryptographicallyLinked: boolean
  readonly fullDestinationContentReverifiedAfterRestart: boolean
  readonly fullBackupContentReverifiedAfterRestart: boolean
  readonly liveThreeBranchRefsReverifiedAfterRestart: boolean
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-restarted-test-pair-current-git-and-frozen-backup" as const,
  observation: "manual-recovery-required" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const UNKNOWN: V4FencedLivePersistedTestPairAndBackupReport = Object.freeze({
  ...BASE, reason: "local-or-current-git-proof-uncertain",
  historicalTestPairCryptographicallyLinked: false,
  fullDestinationContentReverifiedAfterRestart: false,
  fullBackupContentReverifiedAfterRestart: false,
  liveThreeBranchRefsReverifiedAfterRestart: false,
})
const COMPLETE: V4FencedLivePersistedTestPairAndBackupReport = Object.freeze({
  ...BASE, reason: "test-pair-and-full-remote-coherent-but-not-a-commit",
  historicalTestPairCryptographicallyLinked: true,
  fullDestinationContentReverifiedAfterRestart: true,
  fullBackupContentReverifiedAfterRestart: true,
  liveThreeBranchRefsReverifiedAfterRestart: true,
})

/**
 * D221: Unlike historical D220 alone, also authenticate the complete current
 * encrypted Destination AND frozen old-key Backup via D217, using the actual
 * D220 saved contract, NOT a claimed in-memory historical D183 witness.
 *
 * ONE outer initiating-device lease; D220, D184, D185, D178 and D216 borrow
 * it sequentially. Read the canonical contract on both sides of the full
 * remote proof. No file/remote writes, no recovery/commit/Cutover authority:
 * even the COMPLETE result is strictly Manual Recovery. The cooperative
 * lease cannot exclude external OS, Vault or GitHub writers / power loss.
 */
export async function inspectV4FencedLivePersistedTestPairAndBackupAfterRestart(
  input: V4FencedLivePersistedTestPairAndBackupInput,
): Promise<V4FencedLivePersistedTestPairAndBackupReport> {
  const prepared = input?.prepared
  const restart = prepared?.restart
  const remote = input?.remote
  const backup = input?.backup
  const branches = remote?.branches
  const shadow = remote?.shadow
  const id = branches?.identity
  if (!prepared || !restart || !remote || !backup || !branches || !shadow || !id) return UNKNOWN

  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const key = prepared.journalKey
  const getSecret = restart.getSecret
  const lease = restart.assertExclusiveInitiatorLease
  const holder = prepared.withExclusiveInitiatorLease
  const github = shadow.remote?.github
  const oldGithub = backup.backup?.github
  const readers = branches.readers
  if (!adapter || !wal || !journal || !github || !oldGithub || !readers
    || ROLES.some(role => !readers[role])
    || !(key instanceof Uint8Array) || key.byteLength !== 32
    || typeof lease !== "function" || typeof holder !== "function"
    || typeof getSecret !== "function"
    || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || restart.acknowledgement !== RISK || branches.acknowledgement !== RISK
    || prepared.withExclusiveInitiatorLease !== branches.withExclusiveInitiatorLease
    || lease !== branches.assertExclusiveInitiatorLease
    || lease !== shadow.assertExclusiveInitiatorLease
    || adapter !== branches.adapter || adapter !== shadow.adapter
    || wal !== branches.wal || journal !== branches.journal
    || backup.adapter !== adapter || backup.wal !== wal || backup.journal !== journal
    || backup.assertExclusiveInitiatorLease !== lease
    || backup.withExclusiveInitiatorLease !== holder
    || JSON.stringify(id) !== JSON.stringify(prepared.identity)
    || JSON.stringify(id) !== JSON.stringify(backup.identity)
    || journal.sourceCommitSha !== id.sourceCommitSha
    || journal.destinationRepoId !== id.destinationRepoId
    || restart.runId !== id.runId || restart.indexRoot !== id.indexRoot
    || restart.sourceCommitSha !== id.sourceCommitSha
    || restart.expectedWalGeneration !== id.walGeneration
    || restart.backupRepoId !== id.backupRepoId) return UNKNOWN

  let sourceSecret: string | null
  let destinationSecret: string | null
  try {
    sourceSecret = getSecret(id.sourcePassphraseSecretId)
    destinationSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return UNKNOWN }
  if (!sourceSecret || !destinationSecret
    || backup.backup.passphrase !== sourceSecret
    || shadow.remote.destinationPassphrase !== destinationSecret) return UNKNOWN

  const manifestPath = id.indexRoot + "-rekey-proposed-" + id.runId + "/contract.json"
  const pinned = {
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    walRead: journal.assertHealthySnapshot,
    originalIdentity: JSON.stringify(id),
    originalPreparedId: JSON.stringify(prepared.identity),
    originalBackupId: JSON.stringify(backup.identity),
    settings: JSON.stringify(restart.settings),
    expected: JSON.stringify(restart.expected),
    key: toBase64(key),
    publication: JSON.stringify(branches.publication),
    physicalRepo: branches.physicalRepositoryId,
    signal: shadow.remote.signal,
    backupSignal: backup.backup.signal,
    remoteScope: JSON.stringify({
      runId: shadow.runId, root: shadow.activeIndexRoot,
      device: shadow.expectedDeviceId, remote: {
        plan: shadow.remote.plan,
        sourceConfig: shadow.remote.sourceConfig,
        destinationConfig: shadow.remote.expectedDestinationConfig,
        receipts: shadow.remote.expectedReceipts,
        sourceTreeSha: shadow.remote.sourceTreeSha,
        destinationCommitSha: shadow.remote.destinationCommitSha,
      },
      backupPlan: backup.backup.plan,
      backupSourceTreeSha: backup.backup.expectedSourceTreeSha,
    }),
    git: {
      repo: github.getRepositoryIdentity, ref: github.getGitRef,
      commit: github.getGitCommit, tree: github.getTreeAt, blob: github.getBlob,
    },
    oldGit: {
      repo: oldGithub.getRepositoryIdentity, ref: oldGithub.getGitRef,
      commit: oldGithub.getGitCommit, tree: oldGithub.getTreeAt,
      blob: oldGithub.getBlob, branch: oldGithub.branchName,
    },
    readers: ROLES.map(role => {
      const r = readers[role]
      return { role, reader: r, branch: r.branchName,
        repo: r.getRepositoryIdentity, def: r.getRepositoryDefaultBranch,
        ref: r.getGitRefOrNull, commit: r.getGitCommit }
    }),
  }

  const unchanged = () => input.prepared === prepared
    && input.remote === remote && input.backup === backup
    && prepared.restart === restart
    && prepared.withExclusiveInitiatorLease === holder
    && prepared.journalKey === key && toBase64(key) === pinned.key
    && JSON.stringify(prepared.identity) === pinned.originalPreparedId
    && remote.branches === branches && remote.shadow === shadow
    && branches.withExclusiveInitiatorLease === holder
    && branches.identity === id
    && JSON.stringify(id) === pinned.originalIdentity
    && JSON.stringify(backup.identity) === pinned.originalBackupId
    && JSON.stringify(branches.publication) === pinned.publication
    && branches.physicalRepositoryId === pinned.physicalRepo
    && branches.readers === readers
    && pinned.readers.every(m => {
      const r = readers[m.role]
      return r === m.reader && r.branchName === m.branch
        && r.getRepositoryIdentity === m.repo
        && r.getRepositoryDefaultBranch === m.def
        && r.getGitRefOrNull === m.ref && r.getGitCommit === m.commit
    })
    && restart.settings && JSON.stringify(restart.settings) === pinned.settings
    && JSON.stringify(restart.expected) === pinned.expected
    && restart.indexAdapter === adapter
    && branches.adapter === adapter && shadow.adapter === adapter
    && restart.journal === journal && branches.journal === journal
    && restart.wal === wal && branches.wal === wal
    && restart.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && shadow.assertExclusiveInitiatorLease === lease
    && restart.getSecret === getSecret
    && restart.acknowledgement === RISK && branches.acknowledgement === RISK
    && backup.adapter === adapter && backup.wal === wal && backup.journal === journal
    && backup.assertExclusiveInitiatorLease === lease
    && backup.withExclusiveInitiatorLease === holder
    && backup.backup.github === oldGithub
    && backup.backup.passphrase === sourceSecret
    && backup.backup.signal === pinned.backupSignal
    && shadow.remote.github === github
    && shadow.remote.signal === pinned.signal
    && pinned.signal?.aborted !== true && pinned.backupSignal?.aborted !== true
    && JSON.stringify({
      runId: shadow.runId, root: shadow.activeIndexRoot,
      device: shadow.expectedDeviceId, remote: {
        plan: shadow.remote.plan,
        sourceConfig: shadow.remote.sourceConfig,
        destinationConfig: shadow.remote.expectedDestinationConfig,
        receipts: shadow.remote.expectedReceipts,
        sourceTreeSha: shadow.remote.sourceTreeSha,
        destinationCommitSha: shadow.remote.destinationCommitSha,
      },
      backupPlan: backup.backup.plan,
      backupSourceTreeSha: backup.backup.expectedSourceTreeSha,
    }) === pinned.remoteScope
    && github.getRepositoryIdentity === pinned.git.repo
    && github.getGitRef === pinned.git.ref
    && github.getGitCommit === pinned.git.commit
    && github.getTreeAt === pinned.git.tree
    && github.getBlob === pinned.git.blob
    && oldGithub.getRepositoryIdentity === pinned.oldGit.repo
    && oldGithub.getGitRef === pinned.oldGit.ref
    && oldGithub.getGitCommit === pinned.oldGit.commit
    && oldGithub.getTreeAt === pinned.oldGit.tree
    && oldGithub.getBlob === pinned.oldGit.blob
    && oldGithub.branchName === pinned.oldGit.branch
    && adapter.read === pinned.read && adapter.exists === pinned.exists
    && adapter.stat === pinned.stat
    && wal.assertExclusiveStageLease === pinned.walLease
    && wal.assertBestEffortCheckpoint === pinned.checkpoint
    && journal.assertHealthySnapshot === pinned.walRead
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && getSecret(id.sourcePassphraseSecretId) === sourceSecret
    && getSecret(id.destinationPassphraseSecretId) === destinationSecret

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D221 Source/Backup/Destination recovery identity drift.")
    await lease()
    await pinned.walLease.call(wal)
    if (await pinned.checkpoint.call(wal) !== "best-effort-readback-only" || !unchanged()) {
      throw Error("D221 WAL or initiator lease lost.")
    }
    const snapshot = await pinned.walRead.call(journal, id.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(snapshot, id) || !unchanged()) {
      throw Error("D221 WAL no longer binds the pinned frozen Backup/Destination.")
    }
  }
  const fence = () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  }, assertHeld)
  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D221 nested borrowed initiating-device lease.")
    borrowedActive = true
    try {
      await fence()
      const result = await body()
      await fence()
      return result
    } finally { borrowedActive = false }
  }
  const readManifest = async () => {
    await fence()
    if (!await pinned.exists.call(adapter, manifestPath)) {
      throw Error("D221 historical test contract is missing.")
    }
    const stat = await pinned.stat?.call(adapter, manifestPath)
    if (stat && (!Number.isSafeInteger(stat.size)
      || stat.size < 0 || stat.size > V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
      throw Error("D221 historical test contract is oversized.")
    }
    const bytes = await pinned.read.call(adapter, manifestPath)
    if (!fitsV4LocalJsonSizeLimit(bytes, V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
      throw Error("D221 historical test contract is malformed or oversized.")
    }
    const contract = decodeV4ReencryptionPersistedTestContract(bytes)
    if (JSON.stringify(contract.identity) !== pinned.originalIdentity || !unchanged()) {
      throw Error("D221 historical test contract belongs to another migration.")
    }
    await fence()
    return { bytes, contract }
  }

  let invoked = 0
  let completed: V4FencedLivePersistedTestPairAndBackupReport | null = null
  try {
    const returned = await holder(async () => {
      if (++invoked !== 1) throw Error("D221 initiating-device holder invoked repeatedly.")
      const before = await readManifest()
      const localBefore = await inspectV4FencedPersistedTestPairAfterRestart({
        ...prepared, withExclusiveInitiatorLease: borrowed,
      })
      if (localBefore.historicalTestPairCryptographicallyLinked !== true
        || localBefore.observation !== "manual-recovery-required"
        || localBefore.localCutoverAuthorized !== false || !unchanged()) {
        throw Error("D221 saved historical test pair lacks authenticated local evidence.")
      }
      const middle = await readManifest()
      if (before.bytes !== middle.bytes) throw Error("D221 saved contract changed before Git read.")
      const live = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
        local: {
          prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
          contract: before.contract,
          sourceSettings: JSON.parse(pinned.settings) as typeof restart.settings,
        },
        remote: { ...remote, branches: { ...branches, withExclusiveInitiatorLease: borrowed } },
        backup: { ...backup, withExclusiveInitiatorLease: borrowed },
      })
      if (live.observation !== "crash-window-git-reverified-manual-recovery"
        || live.reason !== "local-crash-window-still-requires-manual-recovery"
        || live.local?.artifactWindow !== "pair-present"
        || live.local.pairEvidence !== "cryptographically-linked-uncommitted"
        || live.fullDestinationContentReverifiedAfterRestart !== true
        || live.fullBackupContentReverifiedAfterRestart !== true
        || live.liveThreeBranchRefsReverifiedAfterRestart !== true
        || live.localCutoverAuthorized !== false
        || live.resumeSyncAuthorized !== false || !unchanged()) {
        throw Error("D221 historical pair or full current Git proof uncertain.")
      }
      const after = await readManifest()
      if (before.bytes !== after.bytes) throw Error("D221 saved contract changed across Git read.")
      const localAfter = await inspectV4FencedPersistedTestPairAfterRestart({
        ...prepared, withExclusiveInitiatorLease: borrowed,
      })
      if (localAfter.historicalTestPairCryptographicallyLinked !== true
        || localAfter.localCutoverAuthorized !== false || !unchanged()) {
        throw Error("D221 historic local pair changed after full Git verification.")
      }
      if ((await readManifest()).bytes !== before.bytes || !unchanged()) {
        throw Error("D221 final historical test contract readback changed.")
      }
      completed = COMPLETE
      return completed
    })
    return invoked === 1 && returned === completed && completed === COMPLETE
      && unchanged() ? COMPLETE : UNKNOWN
  } catch { return UNKNOWN }
}
