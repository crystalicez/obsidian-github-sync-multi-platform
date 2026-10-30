import { toBase64 } from "../bytes"
import { loadV4LocalIndex } from "./local-index"
import { inspectV4ReencryptionCrossSurfaceProof } from "./reencryption-cross-surface-proof"
import {
  assertV4ReencryptionExactSyncFence, inspectV4FencedBestEffortPreparedSelectorAfterRestart,
} from "./reencryption-fenced-prepared-selector"
import {
  inspectV4FencedFullRemoteShadowAfterRestart, type V4FencedFullRemoteShadowInput,
} from "./reencryption-fenced-full-shadow-verification"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import type { V4PreparedOrphanCommit } from "./reencryption-orphan-publication"

export interface V4FencedPrecommitReadinessInput {
  readonly full: V4FencedFullRemoteShadowInput
  readonly prepared: V4BestEffortPreparedSelectorStageInput
  readonly candidate: V4PreparedOrphanCommit
}
export interface V4FencedPrecommitReadinessReport {
  readonly integrityScope: "read-only-fenced-source-wal-intent-secrets-full-git-and-prepared-selector"
  readonly observation: "all-prepared-surfaces-coherent-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly completeDestinationContentReverified: boolean
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "read-only-fenced-source-wal-intent-secrets-full-git-and-prepared-selector" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4FencedPrecommitReadinessReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required", completeDestinationContentReverified: false,
})
const OBSERVED: V4FencedPrecommitReadinessReport = Object.freeze({
  ...BASE, observation: "all-prepared-surfaces-coherent-uncommitted",
  completeDestinationContentReverified: true,
})

/**
 * D179: one cooperative lease and NO writes. D176 authenticates prepared
 * evidence; D178 verifies full Destination content; D138 independently
 * verifies Source, SecretStorage, Intent, WAL manifest and Shadow.
 * Best-effort WAL readback is NOT physical fsync or committed Cutover.
 */
export async function inspectV4FencedPrecommitReadinessAfterRestart(
  input: V4FencedPrecommitReadinessInput,
): Promise<V4FencedPrecommitReadinessReport> {
  const full = input?.full
  const prepared = input?.prepared
  const candidate = input?.candidate
  const branches = full?.branches
  const shadow = full?.shadow
  const restart = prepared?.restart
  const id = branches?.identity
  if (!id || !restart || !shadow?.remote || !candidate || !prepared.identity) return MANUAL
  const { wal, journal, assertExclusiveInitiatorLease: lease,
    withExclusiveInitiatorLease: holder } = branches
  const adapter = restart.indexAdapter
  const getSecret = restart.getSecret
  if (prepared.withExclusiveInitiatorLease !== holder
    || JSON.stringify(prepared.identity) !== JSON.stringify(id)
    || restart.runId !== id.runId || restart.indexRoot !== id.indexRoot
    || restart.sourceCommitSha !== id.sourceCommitSha || restart.backupRepoId !== id.backupRepoId
    || restart.expectedWalGeneration !== id.walGeneration
    || restart.expected.sourceRepoId !== id.sourceRepoId
    || restart.expected.destinationRepoId !== id.destinationRepoId
    || restart.expected.destinationCommitSha !== id.destinationCommitSha
    || restart.expected.deviceId !== id.deviceId
    || restart.expected.sourcePassphraseSecretId !== id.sourcePassphraseSecretId
    || restart.expected.destinationPassphraseSecretId !== id.destinationPassphraseSecretId
    || branches.adapter !== adapter || restart.indexAdapter !== adapter || shadow.adapter !== adapter
    || restart.journal !== journal || restart.wal !== wal
    || restart.assertExclusiveInitiatorLease !== lease
    || shadow.assertExclusiveInitiatorLease !== lease
    || restart.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || branches.acknowledgement !== restart.acknowledgement
    || candidate.pinnedSourceCommitSha !== id.sourceCommitSha
    || candidate.sourceTreeSha !== id.sourceTreeSha
    || candidate.commitSha !== id.destinationCommitSha
    || candidate.treeSha !== id.destinationTreeSha
    || candidate.destinationRepoId !== id.destinationRepoId
    || candidate.deviceId !== id.deviceId
    || candidate.physicalRepositoryId !== branches.physicalRepositoryId
    || typeof getSecret !== "function"
    || !getSecret(id.sourcePassphraseSecretId)
    || !getSecret(id.destinationPassphraseSecretId)
    || getSecret(id.destinationPassphraseSecretId) !== shadow.remote.destinationPassphrase
    || !(prepared.journalKey instanceof Uint8Array) || prepared.journalKey.length !== 32
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof wal?.assertBestEffortCheckpoint !== "function"
    || typeof wal.assertExclusiveStageLease !== "function") return MANUAL

  const key = prepared.journalKey
  const keyProof = toBase64(key)
  const readers = branches.readers
  const pinnedReaders = (["source", "backup", "destination"] as const).map(role => {
    const c = readers[role]
    return { role, c, branch: c.branchName, repo: c.getRepositoryIdentity,
      defaultRef: c.getRepositoryDefaultBranch,
      ref: c.getGitRefOrNull, commit: c.getGitCommit }
  })
  const gh = shadow.remote.github
  const scope = () => JSON.stringify({
    id: branches.identity, preparedId: prepared.identity, candidate,
    settings: restart.settings, expected: restart.expected,
    publication: branches.publication,
    remote: {
      plan: shadow.remote.plan,
      sourceConfig: shadow.remote.sourceConfig,
      destinationConfig: shadow.remote.expectedDestinationConfig,
      receipts: shadow.remote.expectedReceipts,
      sourceTreeSha: shadow.remote.sourceTreeSha,
      destinationCommitSha: shadow.remote.destinationCommitSha,
    },
    passphrase: shadow.remote.destinationPassphrase,
  })
  const originalScope = scope()
  const oldValue = getSecret(id.sourcePassphraseSecretId)
  const newValue = getSecret(id.destinationPassphraseSecretId)
  const methods = {
    read: adapter.read, exists: adapter.exists,
    walLease: wal.assertExclusiveStageLease, checkpoint: wal.assertBestEffortCheckpoint,
    journalRead: journal.assertHealthySnapshot,
    ghRef: gh.getGitRef, ghBlob: gh.getBlob, ghTree: gh.getTreeAt,
    ghCommit: gh.getGitCommit, ghRepo: gh.getRepositoryIdentity,
  }
  const unchanged = () => input.full === full && input.prepared === prepared
    && input.candidate === candidate && full.branches === branches && full.shadow === shadow
    && prepared.restart === restart && prepared.withExclusiveInitiatorLease === holder
    && branches.withExclusiveInitiatorLease === holder
    && branches.assertExclusiveInitiatorLease === lease
    && restart.assertExclusiveInitiatorLease === lease
    && shadow.assertExclusiveInitiatorLease === lease
    && branches.journal === journal && restart.journal === journal
    && branches.wal === wal && restart.wal === wal
    && branches.adapter === adapter && restart.indexAdapter === adapter
    && shadow.adapter === adapter
    && prepared.journalKey === key && toBase64(key) === keyProof
    && restart.getSecret === getSecret
    && getSecret(id.sourcePassphraseSecretId) === oldValue
    && getSecret(id.destinationPassphraseSecretId) === newValue
    && methods.read === adapter.read && methods.exists === adapter.exists
    && methods.walLease === wal.assertExclusiveStageLease
    && methods.checkpoint === wal.assertBestEffortCheckpoint
    && methods.journalRead === journal.assertHealthySnapshot
    && shadow.remote.github === gh && gh.getGitRef === methods.ghRef
    && gh.getBlob === methods.ghBlob && gh.getTreeAt === methods.ghTree
    && gh.getGitCommit === methods.ghCommit && gh.getRepositoryIdentity === methods.ghRepo
    && branches.readers === readers && pinnedReaders.every(r => {
      const c = readers[r.role]
      return c === r.c && c.branchName === r.branch
        && c.getRepositoryIdentity === r.repo
        && c.getRepositoryDefaultBranch === r.defaultRef
        && c.getGitRefOrNull === r.ref && c.getGitCommit === r.commit
    }) && scope() === originalScope

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D179 identity or Source/Secret drift.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only" || !unchanged()) {
      throw Error("D179 WAL checkpoint uncertain.")
    }
  }
  const fence = () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  }, assertHeld)
  let nested = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (nested) throw Error("D179 nested lease request.")
    nested = true
    try {
      await assertHeld()
      const result = await body()
      await assertHeld()
      return result
    } finally { nested = false }
  }
  const snapshot = async () => {
    await assertHeld()
    const source = JSON.stringify(await loadV4LocalIndex(adapter, id.indexRoot))
    const dest = JSON.stringify(await loadV4LocalIndex(
      adapter, id.indexRoot + "-rekey-" + id.runId))
    const walState = JSON.stringify(await methods.journalRead.call(journal, id.walGeneration))
    await assertHeld()
    return JSON.stringify({ source, dest, walState })
  }
  const readPrepared = async () => {
    const report = await inspectV4FencedBestEffortPreparedSelectorAfterRestart({
      ...prepared, withExclusiveInitiatorLease: borrowed,
    })
    if (report.observation !== "authenticated-prepared-selector-uncommitted"
      || report.resumeSyncAuthorized !== false || !unchanged()) {
      throw Error("D179 Source Intent or prepared Selector changed.")
    }
  }

  let invoked = false
  try {
    const result = await holder(async () => {
      if (invoked) throw Error("D179 exclusive lease invoked twice.")
      invoked = true
      await fence()
      const before = await snapshot()
      await readPrepared()
      const git = await inspectV4FencedFullRemoteShadowAfterRestart({
        ...full, branches: { ...branches, withExclusiveInitiatorLease: borrowed },
      })
      if (git.observation !== "complete-destination-matches-shadow-uncommitted"
        || git.completeRemoteContentReverified !== true || !unchanged()) {
        throw Error("D179 complete Git content proof failed.")
      }
      // D138's 'strict' callback is only a read-only best-effort WAL probe.
      // It is never passed to any future commit/cutover writer.
      const cross = await inspectV4ReencryptionCrossSurfaceProof({
        restart: { ...restart, assertCrashDurable: assertHeld },
        shadow: { ...shadow, assertCrashDurable: assertHeld },
        preparedCandidate: candidate, withExclusiveInitiatorLease: borrowed,
      })
      if (cross.observation !== "all-surfaces-coherent-uncommitted"
        || cross.resumeSyncAuthorized !== false || !unchanged()) {
        throw Error("D179 cross-surface Source/Secret/Intent/Manifest mismatch.")
      }
      await readPrepared()
      await fence()
      if (await snapshot() !== before || !unchanged()) {
        throw Error("D179 Index or authenticated WAL changed.")
      }
      await fence()
      return OBSERVED
    })
    return invoked && result === OBSERVED && unchanged() ? OBSERVED : MANUAL
  } catch { return MANUAL }
}
