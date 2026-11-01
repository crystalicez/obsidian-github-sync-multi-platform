import { toBase64 } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"
import {
  inspectV4ReencryptionCutoverCandidatePair,
  sealV4ReencryptionCutoverCandidatePair,
  type V4ReencryptionCutoverCandidateContract,
} from "./reencryption-cutover-candidate-crypto"
import {
  decodeV4ReencryptionCutoverCandidateManifest,
  encodeV4ReencryptionCutoverCandidateManifest,
} from "./reencryption-cutover-candidate-manifest"
import { assertV4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RISK = "accept-best-effort-power-loss-recovery-risk"
const MAX_CIPHERTEXT = 8 * 1024
const active = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4ReencryptionCutoverCandidateStageInput {
  readonly prepared: V4BestEffortPreparedSelectorStageInput
  /**
   * A digest snapshot from independently verified Source, Shadow, WAL and
   * full remote Git reads. THIS WRITER DOES NOT VERIFY REMOTE CONTENT.
   * The future production commit gate must independently redo that proof.
   */
  readonly contract: V4ReencryptionCutoverCandidateContract
}

export interface V4ReencryptionCutoverCandidateStageReport {
  readonly status: "production-namespace-pair-staged-uncommitted"
  readonly manifestPath: string
  readonly receiptPath: string
  readonly selectorPath: string
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

/**
 * D223: adapter-backed CRASH-WINDOW EXERCISE for production-namespace format.
 * Writes to an entirely isolated, never-runtime-selected candidate root.
 *
 * The actual authoritative commit protocol, remote verification, retention
 * policy and live Settings/Index/SecretStorage cutover are NOT implemented.
 * Staged bytes must never be copied to the future active selector path.
 *
 * Stop and retain partial bytes on any failure; never overwrite or retry an
 * existing candidate. A held cooperative initiator lease and a best-effort
 * WAL checkpoint do NOT prove OS power-cut durability or fence other writers.
 */
export async function stageV4ReencryptionCutoverCandidate(
  input: V4ReencryptionCutoverCandidateStageInput,
): Promise<V4ReencryptionCutoverCandidateStageReport> {
  const prepared = input?.prepared
  const restart = prepared?.restart
  const contract = input?.contract
  if (!restart || !contract) throw Error("D223 missing cutover candidate preparation.")
  assertV4ReencryptionCutoverSnapshotContract(contract)

  const id = contract.identity
  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const key = prepared.journalKey
  const lease = restart.assertExclusiveInitiatorLease
  const holder = prepared.withExclusiveInitiatorLease
  const getSecret = restart.getSecret
  if (!adapter || !wal || !journal || !(key instanceof Uint8Array)
    || key.byteLength !== 32 || typeof lease !== "function"
    || typeof holder !== "function" || typeof getSecret !== "function"
    || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof adapter.mkdir !== "function" || typeof adapter.write !== "function"
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || restart.acknowledgement !== RISK
    || JSON.stringify(prepared.identity) !== JSON.stringify(id)
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
    || restart.settings.vault !== id.deviceId) {
    throw Error("D223 rejected foreign cutover candidate, WAL or Source Settings.")
  }
  // Validate run/root syntax before building any storage path.
  planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const root = id.indexRoot + "-rekey-cutover-candidate-" + id.runId
  const manifestPath = root + "/contract.json"
  const receiptPath = root + "/receipt.json"
  const selectorPath = root + "/selector.json"
  const manifest = encodeV4ReencryptionCutoverCandidateManifest(contract)
  const methods = {
    read: adapter.read, exists: adapter.exists, mkdir: adapter.mkdir,
    write: adapter.write, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    journalRead: journal.assertHealthySnapshot,
  }
  const initialContract = JSON.stringify(contract)
  const initialSettings = JSON.stringify(restart.settings)
  const initialExpected = JSON.stringify(restart.expected)
  const initialId = JSON.stringify(prepared.identity)
  const initialKey = toBase64(key)
  const sourceSecret = getSecret(id.sourcePassphraseSecretId)
  const destinationSecret = getSecret(id.destinationPassphraseSecretId)
  if (!sourceSecret || !destinationSecret) {
    throw Error("D223 both original and new passphrases must remain available.")
  }
  const unchanged = () => input.prepared === prepared && input.contract === contract
    && prepared.restart === restart && prepared.journalKey === key
    && prepared.withExclusiveInitiatorLease === holder
    && JSON.stringify(contract) === initialContract
    && JSON.stringify(prepared.identity) === initialId
    && JSON.stringify(restart.settings) === initialSettings
    && JSON.stringify(restart.expected) === initialExpected
    && toBase64(key) === initialKey
    && restart.indexAdapter === adapter && restart.wal === wal && restart.journal === journal
    && restart.assertExclusiveInitiatorLease === lease && restart.getSecret === getSecret
    && restart.acknowledgement === RISK
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && journal.assertHealthySnapshot === methods.journalRead
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.mkdir === methods.mkdir && adapter.write === methods.write
    && adapter.stat === methods.stat
    && getSecret(id.sourcePassphraseSecretId) === sourceSecret
    && getSecret(id.destinationPassphraseSecretId) === destinationSecret

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D223 candidate source/evidence changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only" || !unchanged()) {
      throw Error("D223 candidate lost the exclusive best-effort WAL lease.")
    }
    const snapshot = await methods.journalRead.call(journal, id.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(snapshot, id) || !unchanged()) {
      throw Error("D223 candidate WAL does not match authenticated three-branch publication.")
    }
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D223 candidate lost the fenced identity.")
  }

  const claimed = active.get(adapter) ?? new Set<string>()
  if (claimed.has(root)) throw Error("D223 concurrent candidate staging requires Manual Recovery.")
  claimed.add(root)
  active.set(adapter, claimed)
  let calls = 0
  let completed: V4ReencryptionCutoverCandidateStageReport | null = null
  try {
    const returned = await holder(async () => {
      if (++calls !== 1) throw Error("D223 candidate stage holder called more than once.")
      await assertHeld()
      if (await methods.exists.call(adapter, root)
        || await methods.exists.call(adapter, manifestPath)
        || await methods.exists.call(adapter, receiptPath)
        || await methods.exists.call(adapter, selectorPath)) {
        throw Error("D223 existing candidate or crash residue requires Manual Recovery.")
      }
      const pair = await sealV4ReencryptionCutoverCandidatePair(contract, key)
      if (pair.receiptCiphertext.length > MAX_CIPHERTEXT
        || pair.selectorCiphertext.length > MAX_CIPHERTEXT
        || (await inspectV4ReencryptionCutoverCandidatePair(contract, key, pair))
          .observation !== "cryptographically-linked-candidate-uncommitted") {
        throw Error("D223 candidate crypto preflight failed.")
      }
      await assertHeld()
      if (await methods.exists.call(adapter, root)
        || await methods.exists.call(adapter, manifestPath)
        || await methods.exists.call(adapter, receiptPath)
        || await methods.exists.call(adapter, selectorPath)) {
        throw Error("D223 a competing writer created candidate residue.")
      }
      await methods.mkdir.call(adapter, root)
      await assertHeld()
      await methods.write.call(adapter, manifestPath, manifest)
      await assertHeld()
      const saved = await methods.read.call(adapter, manifestPath)
      if (saved !== manifest
        || JSON.stringify(decodeV4ReencryptionCutoverCandidateManifest(saved))
          !== initialContract) {
        throw Error("D223 saved untrusted manifest did not read back exactly.")
      }
      await methods.write.call(adapter, receiptPath, pair.receiptCiphertext)
      await assertHeld()
      if (await methods.read.call(adapter, receiptPath) !== pair.receiptCiphertext) {
        throw Error("D223 Receipt candidate readback mismatch.")
      }
      // LAST write: a non-authorizing Selector CANDIDATE, never a runtime path.
      await methods.write.call(adapter, selectorPath, pair.selectorCiphertext)
      await assertHeld()
      const [contractAfter, receiptAfter, selectorAfter] = await Promise.all([
        methods.read.call(adapter, manifestPath),
        methods.read.call(adapter, receiptPath),
        methods.read.call(adapter, selectorPath),
      ])
      if (contractAfter !== manifest || receiptAfter !== pair.receiptCiphertext
        || selectorAfter !== pair.selectorCiphertext
        || (await inspectV4ReencryptionCutoverCandidatePair(
          contract, key, { receiptCiphertext: receiptAfter, selectorCiphertext: selectorAfter },
        )).observation !== "cryptographically-linked-candidate-uncommitted") {
        throw Error("D223 candidate pair was torn or cryptographically mismatched.")
      }
      await assertHeld()
      if (await methods.read.call(adapter, manifestPath) !== manifest
        || await methods.read.call(adapter, receiptPath) !== receiptAfter
        || await methods.read.call(adapter, selectorPath) !== selectorAfter) {
        throw Error("D223 candidate changed after final readback.")
      }
      completed = Object.freeze({
        status: "production-namespace-pair-staged-uncommitted",
        manifestPath, receiptPath, selectorPath,
        evidence: "best-effort-wal-readback-not-power-loss-durable",
        localCutoverAuthorized: false, resumeSyncAuthorized: false,
        rollbackAuthorized: false, remoteWritesAuthorized: false,
        oldPassphraseCleanupAuthorized: false,
      })
      return completed
    })
    if (calls !== 1 || completed === null || returned !== completed || !unchanged()) {
      throw Error("D223 candidate holder cannot attest the completed write.")
    }
    return completed
  } finally {
    claimed.delete(root)
    if (claimed.size === 0) active.delete(adapter)
  }
}
