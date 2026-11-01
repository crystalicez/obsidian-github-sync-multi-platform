import { sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { inspectV4ReencryptionPendingCutoverIntentAfterRestart } from "./reencryption-cutover-intent-restart"
import type { V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const MAX_CANDIDATE = 8 * 1024
const RISK = "accept-best-effort-power-loss-recovery-risk"

export interface V4FencedIntentSurfaceRestartInput {
  readonly prepared: V4BestEffortPreparedSelectorStageInput
  /** Must read current persisted Obsidian plugin-data, not in-memory Settings. */
  readonly readPersistedSettings: () => Promise<
    V4BestEffortPreparedSelectorStageInput["restart"]["settings"] | null>
}

export interface V4FencedIntentSurfaceRestartReport {
  readonly integrityScope: "read-only-fenced-pending-intent-cross-surface-restart"
  readonly observation: "source-and-destination-snapshots-match-pending-intent-uncommitted"
    | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-pending-intent-cross-surface-restart" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const SOURCE: V4FencedIntentSurfaceRestartReport = Object.freeze({
  ...BASE, observation: "source-and-destination-snapshots-match-pending-intent-uncommitted",
})
const MANUAL: V4FencedIntentSurfaceRestartReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
})

async function digest(value: string): Promise<string> {
  return sha256Hex(utf8ToBytes(value))
}

/**
 * D228: independently read *persisted* Settings, both real Index roots,
 * prepared evidence and authenticated WAL in the SAME held owner lease as
 * D227's four-file Intent/Receipt/Selector readback. Historical signed local
 * snapshots never establish current Git freshness or a committed transition.
 */
export async function inspectV4FencedPendingCutoverSurfacesAfterRestart(
  input: V4FencedIntentSurfaceRestartInput,
): Promise<V4FencedIntentSurfaceRestartReport> {
  const prepared = input?.prepared
  const id = prepared?.identity
  const restart = prepared?.restart
  const readSettings = input?.readPersistedSettings
  if (!id || !restart || typeof readSettings !== "function") return MANUAL
  let roots: ReturnType<typeof planV4ReencryptionSeparatedRoots>
  try { roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId) }
  catch { return MANUAL }
  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const lease = restart.assertExclusiveInitiatorLease
  const holder = prepared.withExclusiveInitiatorLease
  const getSecret = restart.getSecret
  const key = prepared.journalKey
  if (!adapter || !wal || !journal || !(key instanceof Uint8Array) || key.length !== 32
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof adapter.exists !== "function" || typeof adapter.read !== "function"
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || typeof getSecret !== "function" || restart.acknowledgement !== RISK) return MANUAL

  const methods = {
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease, checkpoint: wal.assertBestEffortCheckpoint,
    journalRead: journal.assertHealthySnapshot,
  }
  const idBefore = JSON.stringify(id)
  const settingsBefore = JSON.stringify(restart.settings)
  const expectedBefore = JSON.stringify(restart.expected)
  const keyBefore = toBase64(key)
  let oldSecret: string | null, newSecret: string | null
  try {
    oldSecret = getSecret(id.sourcePassphraseSecretId)
    newSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return MANUAL }
  if (!oldSecret || !newSecret) return MANUAL
  const unchanged = () => input.prepared === prepared && input.readPersistedSettings === readSettings
    && prepared.identity === id && prepared.restart === restart && prepared.journalKey === key
    && prepared.withExclusiveInitiatorLease === holder
    && restart.indexAdapter === adapter && restart.wal === wal && restart.journal === journal
    && restart.assertExclusiveInitiatorLease === lease && restart.getSecret === getSecret
    && restart.acknowledgement === RISK
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.stat === methods.stat && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && journal.assertHealthySnapshot === methods.journalRead
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && JSON.stringify(id) === idBefore && JSON.stringify(restart.settings) === settingsBefore
    && JSON.stringify(restart.expected) === expectedBefore && toBase64(key) === keyBefore
    && getSecret(id.sourcePassphraseSecretId) === oldSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret

  const assertHeld = async (): Promise<void> => {
    if (!unchanged()) throw Error("D228 pending Intent input changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D228 WAL lease or Settings reader changed.")
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D228 Sync Fence changed.")
  }
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    await assertHeld()
    const value = await body()
    await assertHeld()
    return value
  }

  const manifestPath = id.indexRoot + "-rekey-cutover-candidate-" + id.runId + "/contract.json"
  const preparedPath = roots.selectorPath.slice(0, -"/selector.json".length) + "/prepared.json"
  const proposedRoot = id.indexRoot + "-rekey-proposed-" + id.runId
  const snapshot = async () => {
    await assertHeld()
    if (await methods.exists.call(adapter, roots.selectorPath)
      || await methods.exists.call(adapter, proposedRoot)) {
      throw Error("D228 live Selector or proposed Commit residue requires Manual Recovery.")
    }
    const stat = await methods.stat?.call(adapter, manifestPath)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > MAX_CANDIDATE)) throw Error("D228 oversized manifest.")
    const contract: V4ReencryptionCutoverSnapshotContract =
      decodeV4ReencryptionCutoverCandidateManifest(
        await methods.read.call(adapter, manifestPath),
      )
    if (JSON.stringify(contract.identity) !== idBefore) {
      throw Error("D228 Cutover contract disagrees with trusted migration identity.")
    }
    const persisted = await readSettings()
    if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)
      || JSON.stringify(persisted) !== settingsBefore) {
      throw Error("D228 persisted Settings differ from the pinned original Source.")
    }
    const checkedIndexDigest = async (
      root: string, repoId: string, commitSha: string,
    ): Promise<string> => {
      const index = await loadV4LocalIndex(adapter, root)
      if (index.repoId !== repoId || index.remoteCommitSha !== commitSha
        || index.deviceId !== id.deviceId || index.mode !== "encrypted"
        || index.pathLayout !== expectedV4PathLayout("encrypted")
        || !isV4LocalIndexCacheComplete(index)
        || Object.values(index.shards).some(shard =>
          Object.values(shard.records).some(record => record.dirty === true || record.deleted === true))) {
        throw Error("D228 active or Shadow Index is incomplete, dirty or switched.")
      }
      return digest(JSON.stringify(index))
    }
    const sourceDigest = await checkedIndexDigest(
      id.indexRoot, id.sourceRepoId, id.sourceCommitSha,
    )
    const shadowDigest = await checkedIndexDigest(
      roots.shadowIndexRoot, id.destinationRepoId, id.destinationCommitSha,
    )
    const evidenceStat = await methods.stat?.call(adapter, preparedPath)
    if (evidenceStat && (!Number.isSafeInteger(evidenceStat.size)
      || evidenceStat.size < 0 || evidenceStat.size > MAX_CANDIDATE)) {
      throw Error("D228 prepared Selector evidence exceeds the byte limit.")
    }
    const evidence = await methods.read.call(adapter, preparedPath)
    const walSnapshot = await methods.journalRead.call(journal, id.walGeneration)
    const destinationBranch = id.destinationRepoId.split("#")[1]
    if (!destinationBranch || !evidence
      || !fitsV4LocalJsonSizeLimit(evidence, MAX_CANDIDATE)
      || !matchesV4ReencryptionPreparedWal(walSnapshot, id)) {
      throw Error("D228 prepared evidence or WAL does not match the pinned migration.")
    }
    const target = { ...persisted, githubBranch: destinationBranch,
      encryptionPassphraseSecretId: id.destinationPassphraseSecretId }
    const digests = [
      sourceDigest, shadowDigest, await digest(evidence),
      await digest(JSON.stringify(walSnapshot)),
      await digest(JSON.stringify(persisted)), await digest(JSON.stringify(target)),
    ]
    if (digests.some((value, i) => value !== [
      contract.sourceIndexSha256, contract.destinationShadowSha256,
      contract.preparedEvidenceSha256, contract.walSnapshotSha256,
      contract.sourceSettingsSha256, contract.destinationSettingsSha256,
    ][i])) {
      throw Error("D228 authenticated Intent does not match current local surfaces.")
    }
    await assertHeld()
    return JSON.stringify({ contract, digests })
  }

  let calls = 0
  let completed: V4FencedIntentSurfaceRestartReport | null = null
  try {
    const returned = await holder(async () => {
      if (++calls !== 1) throw Error("D228 exclusive owner lease invoked more than once.")
      const first = await snapshot()
      const linked = await inspectV4ReencryptionPendingCutoverIntentAfterRestart({
        ...prepared, withExclusiveInitiatorLease: borrowed,
      })
      if (linked.observation !== "authenticated-intent-uncommitted"
        || linked.localCutoverAuthorized !== false || linked.resumeSyncAuthorized !== false) {
        throw Error("D228 historical candidate/Intent failed independently authenticated Restart.")
      }
      const second = await snapshot()
      if (second !== first) throw Error("D228 Settings or Index changed across Intent authentication.")
      await assertHeld()
      completed = SOURCE
      return completed
    })
    return calls === 1 && returned === completed && completed === SOURCE
      && unchanged() ? SOURCE : MANUAL
  } catch { return MANUAL }
}
