import { toBase64 } from "../bytes"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { inspectV4FencedPendingCutoverSurfacesAfterRestart, type V4FencedIntentSurfaceRestartInput } from "./reencryption-fenced-intent-surface-restart"
import { inspectV4FencedFrozenBackupContentAfterRestart } from "./reencryption-fenced-backup-content"
import { deriveV4FencedCommitPairSnapshotTestContract } from "./reencryption-fenced-commit-pair-snapshot-provenance"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4FencedLiveCandidateStageInput } from "./reencryption-fenced-live-candidate-stage"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"

const TX = /^[0-9a-f]{32}$/u
const RISK = "accept-best-effort-power-loss-recovery-risk"
const MAX_MANIFEST = 8 * 1024

export interface V4FencedPendingCommitPreflightInput
  extends V4FencedLiveCandidateStageInput {
  readonly readPersistedSettings: V4FencedIntentSurfaceRestartInput["readPersistedSettings"]
}

export interface V4FencedPendingCommitPreflightReport {
  readonly integrityScope: "fenced-live-full-git-and-persisted-local-pending-intent"
  readonly observation: "full-live-commit-preflight-uncommitted"
    | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly oldBackupContentReverified: boolean
  readonly newDestinationContentReverified: boolean
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "fenced-live-full-git-and-persisted-local-pending-intent" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  commitDecisionAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const PASS: V4FencedPendingCommitPreflightReport = Object.freeze({
  ...BASE, observation: "full-live-commit-preflight-uncommitted",
  oldBackupContentReverified: true, newDestinationContentReverified: true,
})
const MANUAL: V4FencedPendingCommitPreflightReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  oldBackupContentReverified: false, newDestinationContentReverified: false,
})

/**
 * D229 joins D216 complete frozen old-key Backup, D183 complete new-key
 * Destination and Source evidence, and D228 persisted local Cutover Intent.
 *
 * All reads use one externally held owner lease. A positive observation is
 * an ephemeral *preflight*, not a durable decision or runtime cutover. Never
 * authorize writes, key cleanup or Sync based on this report.
 */
export async function inspectV4FencedPendingCommitPreflightAfterRestart(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4FencedPendingCommitPreflightReport> {
  const readiness = input?.readiness
  const backup = input?.backup
  const transactionId = input?.transactionId
  const readSettings = input?.readPersistedSettings
  const prepared = readiness?.prepared
  const branches = readiness?.full?.branches
  const shadow = readiness?.full?.shadow
  const restart = prepared?.restart
  const id = branches?.identity
  const oldGithub = backup?.backup?.github
  const newGithub = shadow?.remote?.github
  const readers = branches?.readers
  if (!id || !restart || !shadow || !prepared || !branches
    || !backup?.backup || !oldGithub || !newGithub || !readers
    || !readiness.candidate || typeof transactionId !== "string"
    || !TX.test(transactionId) || /^0+$/u.test(transactionId)
    || typeof readSettings !== "function"
    || branches.acknowledgement !== RISK || restart.acknowledgement !== RISK
    || !prepared.journalKey || prepared.journalKey.length !== 32
    || !(prepared.journalKey instanceof Uint8Array)
    || !restart.getSecret || typeof restart.getSecret !== "function") return MANUAL

  const holder = prepared.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const key = prepared.journalKey
  const getSecret = restart.getSecret
  if (typeof holder !== "function" || typeof lease !== "function"
    || typeof adapter?.read !== "function" || typeof adapter.exists !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || branches.withExclusiveInitiatorLease !== holder
    || backup.withExclusiveInitiatorLease !== holder
    || branches.assertExclusiveInitiatorLease !== lease
    || backup.assertExclusiveInitiatorLease !== lease
    || shadow.assertExclusiveInitiatorLease !== lease
    || branches.adapter !== adapter || backup.adapter !== adapter
    || shadow.adapter !== adapter || branches.wal !== wal || backup.wal !== wal
    || branches.journal !== journal || backup.journal !== journal
    || JSON.stringify(backup.identity) !== JSON.stringify(id)
    || JSON.stringify(prepared.identity) !== JSON.stringify(id)) return MANUAL

  let oldSecret: string | null
  let newSecret: string | null
  try {
    oldSecret = getSecret(id.sourcePassphraseSecretId)
    newSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return MANUAL }
  if (!oldSecret || !newSecret
    || backup.backup.passphrase !== oldSecret
    || shadow.remote.destinationPassphrase !== newSecret) return MANUAL
  const original = {
    id: JSON.stringify(id), settings: JSON.stringify(restart.settings),
    expected: JSON.stringify(restart.expected), candidate: JSON.stringify(readiness.candidate),
    publication: JSON.stringify(branches.publication),
    backup: JSON.stringify(backup.backup.plan),
    remote: JSON.stringify({
      plan: shadow.remote.plan, source: shadow.remote.sourceConfig,
      destination: shadow.remote.expectedDestinationConfig,
      receipts: shadow.remote.expectedReceipts,
    }),
    key: toBase64(key),
  }
  const methods = {
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    snapshot: journal.assertHealthySnapshot,
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    newClient: {
      repo: newGithub.getRepositoryIdentity, ref: newGithub.getGitRef,
      commit: newGithub.getGitCommit, tree: newGithub.getTreeAt, blob: newGithub.getBlob,
    },
    oldClient: {
      repo: oldGithub.getRepositoryIdentity, ref: oldGithub.getGitRef,
      commit: oldGithub.getGitCommit, tree: oldGithub.getTreeAt, blob: oldGithub.getBlob,
    },
    readers: (["source", "backup", "destination"] as const).map(role => {
      const r = readers[role]
      return {
        role, reader: r, branchName: r.branchName,
        repo: r.getRepositoryIdentity, defaultBranch: r.getRepositoryDefaultBranch,
        ref: r.getGitRefOrNull, commit: r.getGitCommit,
      }
    }),
  }
  const sameClient = (client: Pick<typeof oldGithub, "getRepositoryIdentity" | "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">, saved: typeof methods.oldClient) =>
    client.getRepositoryIdentity === saved.repo
    && client.getGitRef === saved.ref && client.getGitCommit === saved.commit
    && client.getTreeAt === saved.tree && client.getBlob === saved.blob
  const unchanged = () => input.readiness === readiness && input.backup === backup
    && input.transactionId === transactionId && input.readPersistedSettings === readSettings
    && readiness.prepared === prepared && readiness.full.branches === branches
    && readiness.full.shadow === shadow && JSON.stringify(backup.identity) === original.id
    && prepared.identity !== undefined && JSON.stringify(prepared.identity) === original.id
    && branches.identity === id && JSON.stringify(id) === original.id
    && JSON.stringify(restart.settings) === original.settings
    && JSON.stringify(restart.expected) === original.expected
    && JSON.stringify(readiness.candidate) === original.candidate
    && JSON.stringify(branches.publication) === original.publication
    && JSON.stringify(backup.backup.plan) === original.backup
    && JSON.stringify({
      plan: shadow.remote.plan, source: shadow.remote.sourceConfig,
      destination: shadow.remote.expectedDestinationConfig,
      receipts: shadow.remote.expectedReceipts,
    }) === original.remote
    && prepared.journalKey === key && toBase64(key) === original.key
    && prepared.withExclusiveInitiatorLease === holder
    && branches.withExclusiveInitiatorLease === holder && backup.withExclusiveInitiatorLease === holder
    && restart.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && backup.assertExclusiveInitiatorLease === lease
    && shadow.assertExclusiveInitiatorLease === lease
    && restart.indexAdapter === adapter && branches.adapter === adapter
    && backup.adapter === adapter && shadow.adapter === adapter
    && restart.wal === wal && branches.wal === wal && backup.wal === wal
    && restart.journal === journal && branches.journal === journal && backup.journal === journal
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.stat === methods.stat && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && journal.assertHealthySnapshot === methods.snapshot
    && restart.getSecret === getSecret
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && getSecret(id.sourcePassphraseSecretId) === oldSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret
    && backup.backup.passphrase === oldSecret
    && shadow.remote.destinationPassphrase === newSecret
    && backup.backup.github === oldGithub && shadow.remote.github === newGithub
    && backup.backup.signal?.aborted !== true && shadow.remote.signal?.aborted !== true
    && sameClient(oldGithub, methods.oldClient) && sameClient(newGithub, methods.newClient)
    && branches.readers === readers
    && methods.readers.every(m => {
      const r = readers[m.role]
      return r === m.reader && r.branchName === m.branchName
        && r.getRepositoryIdentity === m.repo
        && r.getRepositoryDefaultBranch === m.defaultBranch
        && r.getGitRefOrNull === m.ref && r.getGitCommit === m.commit
    })

  const check = async () => {
    if (!unchanged()) throw Error("D229 Git readers, Settings or passphrases changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()
      || !matchesV4ReencryptionPreparedWal(
        await methods.snapshot.call(journal, id.walGeneration), id,
      )) throw Error("D229 WAL lease or published branch evidence changed.")
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D229 Sync Fence changed.")
  }
  let borrowedActive = false
  const borrowed = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D229 nested owner lease borrowing is invalid.")
    borrowedActive = true
    try {
      await check()
      const result = await fn()
      await check()
      return result
    } finally { borrowedActive = false }
  }

  const sourceInput = {
    transactionId, readiness: {
      ...readiness,
      prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
      full: {
        ...readiness.full,
        branches: { ...branches, withExclusiveInitiatorLease: borrowed },
      },
    },
  }
  const backupInput = { ...backup, withExclusiveInitiatorLease: borrowed }
  const localInput = {
    prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
    readPersistedSettings: readSettings,
  }
  const manifestPath =
    id.indexRoot + "-rekey-cutover-candidate-" + id.runId + "/contract.json"

  const readContract = async (): Promise<string> => {
    await check()
    const stat = await methods.stat?.call(adapter, manifestPath)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > MAX_MANIFEST)) throw Error("D229 oversized stored contract.")
    const contract = decodeV4ReencryptionCutoverCandidateManifest(
      await methods.read.call(adapter, manifestPath),
    )
    if (contract.transactionId !== transactionId
      || JSON.stringify(contract.identity) !== original.id) {
      throw Error("D229 committed preflight has a foreign transaction contract.")
    }
    await check()
    return JSON.stringify(contract)
  }

  let calls = 0
  let completed: V4FencedPendingCommitPreflightReport | null = null
  try {
    const reported = await holder(async () => {
      if (++calls !== 1) throw Error("D229 owner holder invoked more than once.")
      await check()
      const firstLocal = await inspectV4FencedPendingCutoverSurfacesAfterRestart(localInput)
      if (firstLocal.observation !== "source-and-destination-snapshots-match-pending-intent-uncommitted") {
        throw Error("D229 persisted local Source, Shadow or Intent failed cross-surface proof.")
      }
      const savedContract = await readContract()
      const proveGit = async () => {
        const frozen = await inspectV4FencedFrozenBackupContentAfterRestart(backupInput)
        if (frozen.observation !== "complete-frozen-backup-reverified-uncommitted"
          || !frozen.completeBackupContentReverified) {
          throw Error("D229 current old-key frozen Backup verification failed.")
        }
        const destination = await deriveV4FencedCommitPairSnapshotTestContract(sourceInput)
        if (destination.observation !== "snapshot-contract-derived-uncommitted"
          || !destination.contract || JSON.stringify(destination.contract) !== savedContract) {
          throw Error("D229 current Git/Shadow/Settings snapshot no longer matches encrypted Intent.")
        }
        await check()
        if (await readContract() !== savedContract) {
          throw Error("D229 manifest changed during live Git proofs.")
        }
        return { fileCount: frozen.verifiedFileCount, bytes: frozen.verifiedPlaintextBytes }
      }
      const before = await proveGit()
      const after = await proveGit()
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw Error("D229 old-key Backup changed between full Git proof passes.")
      }
      const lastLocal = await inspectV4FencedPendingCutoverSurfacesAfterRestart(localInput)
      if (lastLocal.observation !== firstLocal.observation
        || await readContract() !== savedContract || !unchanged()) {
        throw Error("D229 current persisted surfaces drifted across full Git readback.")
      }
      await check()
      completed = PASS
      return completed
    })
    return calls === 1 && reported === PASS && completed === PASS
      && unchanged() ? PASS : MANUAL
  } catch { return MANUAL }
}
