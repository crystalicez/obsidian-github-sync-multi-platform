import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  inspectV4FencedCrashWindowPairAfterRestart,
} from "./reencryption-fenced-crash-window-pair-inspection"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  decodeV4ReencryptionPersistedTestContract,
  V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES,
} from "./reencryption-persisted-test-contract"
import {
  assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal,
} from "./reencryption-proposed-commit-receipt"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RISK = "accept-best-effort-power-loss-recovery-risk"

export interface V4FencedPersistedTestPairRestartReport {
  readonly integrityScope: "read-only-restarted-untrusted-contract-and-linked-test-pair"
  readonly observation: "manual-recovery-required"
  readonly historicalTestPairCryptographicallyLinked: boolean
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "read-only-restarted-untrusted-contract-and-linked-test-pair" as const,
  observation: "manual-recovery-required" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const UNKNOWN: V4FencedPersistedTestPairRestartReport =
  Object.freeze({ ...BASE, historicalTestPairCryptographicallyLinked: false })
const LINKED: V4FencedPersistedTestPairRestartReport =
  Object.freeze({ ...BASE, historicalTestPairCryptographicallyLinked: true })

/**
 * D220: bootstrap D184's previously caller-supplied *historical* test
 * contract from the persisted, UNTRUSTED nonsecret D219 contract.json.
 * Authenticate that hint only by D184's actual D182 encrypted Receipt and
 * Selector plus full local prepared/WAL/Source/Shadow/Settings readback.
 *
 * ONE caller-held cooperative initiating-device lease encloses manifest
 * before/after D184; D184 borrows without recursively reacquiring. This is
 * NOT a current remote Git content proof or an authoritative commit receipt.
 * It ALWAYS returns Manual Recovery, even when the sealed pair is linked.
 */
export async function inspectV4FencedPersistedTestPairAfterRestart(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4FencedPersistedTestPairRestartReport> {
  const prepared = input
  const restart = input?.restart
  const identity = input?.identity
  const key = input?.journalKey
  const holder = input?.withExclusiveInitiatorLease
  const adapter = restart?.indexAdapter
  const wal = restart?.wal
  const journal = restart?.journal
  const lease = restart?.assertExclusiveInitiatorLease
  const getSecret = restart?.getSecret
  if (!restart || !identity || !(key instanceof Uint8Array) || key.byteLength !== 32
    || !adapter || typeof adapter.exists !== "function" || typeof adapter.read !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof lease !== "function" || typeof holder !== "function"
    || typeof getSecret !== "function"
    || restart.acknowledgement !== RISK) return UNKNOWN

  try { assertV4ReencryptionProposedCommitIdentity(identity) }
  catch { return UNKNOWN }

  if (journal.sourceCommitSha !== identity.sourceCommitSha
    || journal.destinationRepoId !== identity.destinationRepoId
    || restart.runId !== identity.runId
    || restart.indexRoot !== identity.indexRoot
    || restart.sourceCommitSha !== identity.sourceCommitSha
    || restart.backupRepoId !== identity.backupRepoId
    || restart.expectedWalGeneration !== identity.walGeneration
    || restart.expected.sourceRepoId !== identity.sourceRepoId
    || restart.expected.destinationRepoId !== identity.destinationRepoId
    || restart.expected.destinationCommitSha !== identity.destinationCommitSha
    || restart.expected.deviceId !== identity.deviceId
    || restart.expected.sourcePassphraseSecretId !== identity.sourcePassphraseSecretId
    || restart.expected.destinationPassphraseSecretId !== identity.destinationPassphraseSecretId) return UNKNOWN

  const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
  const manifestPath = identity.indexRoot + "-rekey-proposed-" + identity.runId + "/contract.json"
  const methods = {
    exists: adapter.exists, read: adapter.read, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease, walCheck: wal.assertBestEffortCheckpoint,
    journalRead: journal.assertHealthySnapshot,
  }
  const savedIdentity = JSON.stringify(identity)
  const savedSettings = JSON.stringify(restart.settings)
  const savedExpected = JSON.stringify(restart.expected)
  const savedKey = toBase64(key)
  let sourcePassphrase: string | null
  let destinationPassphrase: string | null
  try {
    sourcePassphrase = getSecret(identity.sourcePassphraseSecretId)
    destinationPassphrase = getSecret(identity.destinationPassphraseSecretId)
  } catch { return UNKNOWN }
  if (!sourcePassphrase || !destinationPassphrase) return UNKNOWN
  const unchanged = () => input.restart === restart && input.identity === identity
    && input.journalKey === key && input.withExclusiveInitiatorLease === holder
    && JSON.stringify(identity) === savedIdentity
    && JSON.stringify(restart.settings) === savedSettings
    && JSON.stringify(restart.expected) === savedExpected
    && toBase64(key) === savedKey
    && restart.indexAdapter === adapter && restart.wal === wal && restart.journal === journal
    && restart.assertExclusiveInitiatorLease === lease
    && restart.getSecret === getSecret && restart.acknowledgement === RISK
    && restart.runId === identity.runId && restart.indexRoot === identity.indexRoot
    && restart.sourceCommitSha === identity.sourceCommitSha
    && restart.backupRepoId === identity.backupRepoId
    && restart.expectedWalGeneration === identity.walGeneration
    && journal.sourceCommitSha === identity.sourceCommitSha
    && journal.destinationRepoId === identity.destinationRepoId
    && adapter.exists === methods.exists && adapter.read === methods.read
    && adapter.stat === methods.stat
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.walCheck
    && journal.assertHealthySnapshot === methods.journalRead
    && getSecret(identity.sourcePassphraseSecretId) === sourcePassphrase
    && getSecret(identity.destinationPassphraseSecretId) === destinationPassphrase

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D220 restarted test pair identity drift.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.walCheck.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D220 unverified best-effort WAL.")
    const snap = await methods.journalRead.call(journal, identity.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(snap, identity) || !unchanged()) {
      throw Error("D220 historical migration WAL mismatch.")
    }
  }
  const checkFence = () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: identity.runId, sourceRepoId: identity.sourceRepoId,
    destinationRepoId: identity.destinationRepoId,
  }, assertHeld)
  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D220 nested borrowed holder.")
    borrowedActive = true
    try {
      await assertHeld()
      await checkFence()
      const value = await body()
      await checkFence()
      await assertHeld()
      return value
    } finally { borrowedActive = false }
  }
  const readManifest = async () => {
    await assertHeld()
    await checkFence()
    if (!await methods.exists.call(adapter, manifestPath)
      || !await methods.exists.call(adapter, roots.selectorPath)) {
      throw Error("D220 uncommitted test pair manifest or Selector missing.")
    }
    const stat = await methods.stat?.call(adapter, manifestPath)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
      throw Error("D220 oversized contract manifest.")
    }
    const bytes = await methods.read.call(adapter, manifestPath)
    if (!fitsV4LocalJsonSizeLimit(bytes, V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
      throw Error("D220 noncanonical or oversized contract manifest.")
    }
    const contract = decodeV4ReencryptionPersistedTestContract(bytes)
    if (JSON.stringify(contract.identity) !== savedIdentity || !unchanged()) {
      throw Error("D220 foreign saved test contract.")
    }
    await assertHeld()
    return { bytes, contract }
  }

  let calls = 0
  let completed: V4FencedPersistedTestPairRestartReport | null = null
  try {
    const returned = await holder(async () => {
      if (++calls !== 1) throw Error("D220 holder invoked more than once.")
      const before = await readManifest()
      const inspected = await inspectV4FencedCrashWindowPairAfterRestart({
        prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
        contract: before.contract,
        sourceSettings: JSON.parse(savedSettings) as typeof restart.settings,
      })
      if (inspected.artifactWindow !== "pair-present"
        || inspected.pairEvidence !== "cryptographically-linked-uncommitted"
        || inspected.reason !== "linked-test-pair-not-authoritative"
        || inspected.localCutoverAuthorized !== false || inspected.resumeSyncAuthorized !== false) {
        throw Error("D220 stored pair failed D184 local restart verification.")
      }
      const after = await readManifest()
      if (after.bytes !== before.bytes || !unchanged()) {
        throw Error("D220 restarted contract manifest changed across full readback.")
      }
      // A non-cooperating writer may replace the file immediately *after*
      // fulfilling the second read. One last independent readback detects
      // that late mutation at the observation boundary; it is not a global
      // filesystem write fence or an atomic snapshot.
      await assertHeld()
      if (await methods.read.call(adapter, manifestPath) !== before.bytes
        || !unchanged()) {
        throw Error("D220 restarted contract manifest drifted after confirmation.")
      }
      await checkFence()
      completed = LINKED
      return completed
    })
    return calls === 1 && completed === returned && unchanged() ? LINKED : UNKNOWN
  } catch { return UNKNOWN }
}
