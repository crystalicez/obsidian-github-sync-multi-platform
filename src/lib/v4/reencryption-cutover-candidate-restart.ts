import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  inspectV4ReencryptionCutoverCandidatePair,
} from "./reencryption-cutover-candidate-crypto"
import {
  decodeV4ReencryptionCutoverCandidateManifest,
  V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES,
} from "./reencryption-cutover-candidate-manifest"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RISK = "accept-best-effort-power-loss-recovery-risk"
const MAX_CIPHERTEXT = 8 * 1024

export interface V4ReencryptionCutoverCandidateRestartReport {
  readonly integrityScope: "read-only-production-namespace-candidate-restart"
  readonly observation: "authenticated-candidate-uncommitted" | "manual-recovery-required"
  readonly candidateCryptographicallyLinked: boolean
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-production-namespace-candidate-restart" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ReencryptionCutoverCandidateRestartReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  candidateCryptographicallyLinked: false,
})
const LINKED: V4ReencryptionCutoverCandidateRestartReport = Object.freeze({
  ...BASE, observation: "authenticated-candidate-uncommitted",
  candidateCryptographicallyLinked: true,
})

/**
 * D223: one-lease read-only recovery of production-namespace *candidate*
 * bytes, without any historical contract provided by the caller.
 *
 * Independent readbacks + authenticated WAL/Fence/Secrets verify only local
 * cryptographic linkage; actual current Git content and commit/cutover intent
 * must be verified by a FUTURE authoritative protocol. Even LINKED never
 * permits a local mutation, rollback, branch switch or Sync Resume.
 */
export async function inspectV4ReencryptionCutoverCandidateAfterRestart(
  prepared: V4BestEffortPreparedSelectorStageInput,
): Promise<V4ReencryptionCutoverCandidateRestartReport> {
  const restart = prepared?.restart
  const id = prepared?.identity
  if (!restart || !id) return MANUAL
  try { planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId) }
  catch { return MANUAL }

  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const key = prepared.journalKey
  const holder = prepared.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  const getSecret = restart.getSecret
  if (!adapter || !wal || !journal || !(key instanceof Uint8Array)
    || key.byteLength !== 32 || typeof holder !== "function"
    || typeof lease !== "function" || typeof getSecret !== "function"
    || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || restart.acknowledgement !== RISK
    || restart.runId !== id.runId || restart.indexRoot !== id.indexRoot
    || restart.sourceCommitSha !== id.sourceCommitSha
    || restart.backupRepoId !== id.backupRepoId
    || restart.expectedWalGeneration !== id.walGeneration
    || restart.expected.sourceRepoId !== id.sourceRepoId
    || restart.expected.destinationRepoId !== id.destinationRepoId
    || restart.expected.destinationCommitSha !== id.destinationCommitSha
    || restart.expected.deviceId !== id.deviceId
    || restart.expected.sourcePassphraseSecretId !== id.sourcePassphraseSecretId
    || restart.expected.destinationPassphraseSecretId !== id.destinationPassphraseSecretId
    || journal.sourceCommitSha !== id.sourceCommitSha
    || journal.destinationRepoId !== id.destinationRepoId
    || restart.settings.githubOwner + "/" + restart.settings.githubRepo
      + "#" + restart.settings.githubBranch !== id.sourceRepoId
    || restart.settings.encryptionPassphraseSecretId !== id.sourcePassphraseSecretId
    || restart.settings.encryptionMode !== "encrypted"
    || restart.settings.vault !== id.deviceId) return MANUAL
  let sourceSecret: string | null, destinationSecret: string | null
  try {
    sourceSecret = getSecret(id.sourcePassphraseSecretId)
    destinationSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return MANUAL }
  if (!sourceSecret || !destinationSecret) return MANUAL

  const root = id.indexRoot + "-rekey-cutover-candidate-" + id.runId
  const paths = {
    manifest: root + "/contract.json",
    receipt: root + "/receipt.json",
    selector: root + "/selector.json",
  }
  const methods = {
    exists: adapter.exists, read: adapter.read, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    journalRead: journal.assertHealthySnapshot,
  }
  const identity = JSON.stringify(id)
  const settings = JSON.stringify(restart.settings)
  const expected = JSON.stringify(restart.expected)
  const originalKey = toBase64(key)
  const unchanged = () => prepared.restart === restart
    && prepared.identity === id && JSON.stringify(id) === identity
    && prepared.journalKey === key && toBase64(key) === originalKey
    && prepared.withExclusiveInitiatorLease === holder
    && restart.indexAdapter === adapter && restart.wal === wal && restart.journal === journal
    && restart.assertExclusiveInitiatorLease === lease && restart.getSecret === getSecret
    && restart.acknowledgement === RISK
    && JSON.stringify(restart.settings) === settings
    && JSON.stringify(restart.expected) === expected
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.stat === methods.stat
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && journal.assertHealthySnapshot === methods.journalRead
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && getSecret(id.sourcePassphraseSecretId) === sourceSecret
    && getSecret(id.destinationPassphraseSecretId) === destinationSecret

  const check = async () => {
    if (!unchanged()) throw Error("D223 candidate Restart identity changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D223 candidate Restart lost WAL/lease.")
    const snap = await methods.journalRead.call(journal, id.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(snap, id) || !unchanged()) {
      throw Error("D223 candidate Restart authenticated WAL mismatch.")
    }
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D223 candidate Restart Sync Fence changed.")
  }
  const readAll = async () => {
    await check()
    if (!await methods.exists.call(adapter, root)
      || !await methods.exists.call(adapter, paths.manifest)
      || !await methods.exists.call(adapter, paths.receipt)
      || !await methods.exists.call(adapter, paths.selector)) {
      throw Error("D223 candidate has incomplete crash-window artifacts.")
    }
    for (const [path, maximum] of [
      [paths.manifest, V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES],
      [paths.receipt, MAX_CIPHERTEXT],
      [paths.selector, MAX_CIPHERTEXT],
    ] as const) {
      const stat = await methods.stat?.call(adapter, path)
      if (stat && (!Number.isSafeInteger(stat.size)
        || stat.size < 0 || stat.size > maximum)) {
        throw Error("D223 candidate persisted artifact is oversized or damaged.")
      }
    }
    const manifest = await methods.read.call(adapter, paths.manifest)
    if (!fitsV4LocalJsonSizeLimit(
      manifest, V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES,
    )) throw Error("D223 candidate manifest oversized.")
    const contract = decodeV4ReencryptionCutoverCandidateManifest(manifest)
    if (JSON.stringify(contract.identity) !== identity || !unchanged()) {
      throw Error("D223 foreign candidate manifest.")
    }
    const receipt = await methods.read.call(adapter, paths.receipt)
    const selector = await methods.read.call(adapter, paths.selector)
    if (!fitsV4LocalJsonSizeLimit(receipt, MAX_CIPHERTEXT)
      || !fitsV4LocalJsonSizeLimit(selector, MAX_CIPHERTEXT)
      || (await inspectV4ReencryptionCutoverCandidatePair(
        contract, key, { receiptCiphertext: receipt, selectorCiphertext: selector },
      )).observation !== "cryptographically-linked-candidate-uncommitted") {
      throw Error("D223 candidate persisted AES-GCM records do not authenticate.")
    }
    await check()
    return { manifest, receipt, selector }
  }
  let called = 0
  let completed: V4ReencryptionCutoverCandidateRestartReport | null = null
  try {
    const returned = await holder(async () => {
      if (++called !== 1) throw Error("D223 Restart holder invoked repeatedly.")
      const first = await readAll()
      const second = await readAll()
      if (JSON.stringify(first) !== JSON.stringify(second) || !unchanged()) {
        throw Error("D223 candidate changed between full independent scans.")
      }
      await check()
      if (await methods.read.call(adapter, paths.manifest) !== first.manifest
        || await methods.read.call(adapter, paths.receipt) !== first.receipt
        || await methods.read.call(adapter, paths.selector) !== first.selector) {
        throw Error("D223 candidate mutated after readback.")
      }
      completed = LINKED
      return completed
    })
    return called === 1 && returned === completed && completed === LINKED
      && unchanged() ? LINKED : MANUAL
  } catch { return MANUAL }
}
