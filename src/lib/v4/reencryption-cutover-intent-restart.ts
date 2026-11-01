import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { inspectV4ReencryptionPendingCutoverIntent } from "./reencryption-cutover-intent-crypto"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RISK = "accept-best-effort-power-loss-recovery-risk"
const MAX_BYTES = 8 * 1024

export interface V4ReencryptionCutoverIntentRestartReport {
  readonly integrityScope: "read-only-persisted-cutover-intent"
  readonly observation: "authenticated-intent-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "read-only-persisted-cutover-intent" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const LINKED: V4ReencryptionCutoverIntentRestartReport =
  Object.freeze({ ...BASE, observation: "authenticated-intent-uncommitted" })
const MANUAL: V4ReencryptionCutoverIntentRestartReport =
  Object.freeze({ ...BASE, observation: "manual-recovery-required" })

/**
 * Reconstruct the intent from independent adapter reads after Restart.
 * A valid historical intent still does not verify current Git refs or
 * authorize runtime selection. Any missing/torn evidence requires recovery.
 */
export async function inspectV4ReencryptionPendingCutoverIntentAfterRestart(
  prepared: V4BestEffortPreparedSelectorStageInput,
): Promise<V4ReencryptionCutoverIntentRestartReport> {
  const id = prepared?.identity
  const restart = prepared?.restart
  if (!id || !restart) return MANUAL
  try { planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId) }
  catch { return MANUAL }
  const { indexAdapter: adapter, wal, journal, getSecret } = restart
  const key = prepared.journalKey
  const holder = prepared.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  if (!adapter || !wal || !journal || !(key instanceof Uint8Array)
    || key.length !== 32 || typeof holder !== "function"
    || typeof lease !== "function" || typeof getSecret !== "function"
    || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || restart.acknowledgement !== RISK
    || restart.indexRoot !== id.indexRoot || restart.runId !== id.runId
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
  let oldSecret: string | null
  let newSecret: string | null
  try {
    oldSecret = getSecret(id.sourcePassphraseSecretId)
    newSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return MANUAL }
  if (!oldSecret || !newSecret) return MANUAL

  const root = id.indexRoot + "-rekey-cutover-candidate-" + id.runId
  const paths = [root + "/contract.json", root + "/receipt.json",
    root + "/selector.json", root + "/intent.json"] as const
  const methods = {
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    snapshot: journal.assertHealthySnapshot,
  }
  const originalId = JSON.stringify(id)
  const originalSettings = JSON.stringify(restart.settings)
  const originalExpected = JSON.stringify(restart.expected)
  const originalKey = toBase64(key)
  const unchanged = () => prepared.identity === id && prepared.restart === restart
    && prepared.journalKey === key && toBase64(key) === originalKey
    && prepared.withExclusiveInitiatorLease === holder
    && JSON.stringify(id) === originalId
    && JSON.stringify(restart.settings) === originalSettings
    && JSON.stringify(restart.expected) === originalExpected
    && restart.indexAdapter === adapter && restart.wal === wal && restart.journal === journal
    && restart.acknowledgement === RISK
    && restart.assertExclusiveInitiatorLease === lease && restart.getSecret === getSecret
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.stat === methods.stat
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && journal.assertHealthySnapshot === methods.snapshot
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && getSecret(id.sourcePassphraseSecretId) === oldSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret

  const check = async () => {
    if (!unchanged()) throw Error("D227 restarted intent identity changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()
      || !matchesV4ReencryptionPreparedWal(
        await methods.snapshot.call(journal, id.walGeneration), id,
      )) throw Error("D227 restarted intent WAL or lease changed.")
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D227 restarted intent fence changed.")
  }
  const readAll = async (): Promise<readonly [string, string, string, string]> => {
    await check()
    if (!await methods.exists.call(adapter, root)) throw Error("D227 missing intent directory.")
    const strings = await Promise.all(paths.map(async path => {
      if (!await methods.exists.call(adapter, path)) throw Error("D227 missing intent artifact.")
      const stat = await methods.stat?.call(adapter, path)
      if (stat && (!Number.isSafeInteger(stat.size) || stat.size > MAX_BYTES || stat.size < 0)) {
        throw Error("D227 oversized intent artifact.")
      }
      const value = await methods.read.call(adapter, path)
      if (!fitsV4LocalJsonSizeLimit(value, MAX_BYTES)) throw Error("D227 invalid intent size.")
      return value
    }))
    const [manifest, receipt, selector, intent] = strings
    if (!manifest || !receipt || !selector || !intent) throw Error("D227 incomplete artifacts.")
    const contract = decodeV4ReencryptionCutoverCandidateManifest(manifest)
    if (JSON.stringify(contract.identity) !== originalId
      || (await inspectV4ReencryptionPendingCutoverIntent(
        contract, key, { receiptCiphertext: receipt, selectorCiphertext: selector }, intent,
      )).observation !== "authenticated-intent-uncommitted") {
      throw Error("D227 historical intent or candidate failed authenticated read.")
    }
    await check()
    return [manifest, receipt, selector, intent]
  }
  let calls = 0
  let completed: V4ReencryptionCutoverIntentRestartReport | null = null
  try {
    const result = await holder(async () => {
      if (++calls !== 1) throw Error("D227 restarting lease holder called more than once.")
      const first = await readAll()
      const second = await readAll()
      if (JSON.stringify(first) !== JSON.stringify(second) || !unchanged()) {
        throw Error("D227 intent changed across independent restart reads.")
      }
      await check()
      for (let i = 0; i < paths.length; i++) {
        if (await methods.read.call(adapter, paths[i]!) !== first[i]) {
          throw Error("D227 intent changed after final readback.")
        }
      }
      await check()
      completed = LINKED
      return completed
    })
    return calls === 1 && result === completed && completed === LINKED && unchanged()
      ? LINKED : MANUAL
  } catch { return MANUAL }
}
