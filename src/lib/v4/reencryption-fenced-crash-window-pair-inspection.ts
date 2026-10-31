import { sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndex } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import { inspectV4ReencryptionCommitPairTestVectors, type V4ReencryptionCommitPairTestContract } from "./reencryption-commit-pair-test-vectors"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import { V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES } from "./reencryption-local-cutover-intent"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { assertV4ReencryptionProposedCommitIdentity, matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { authenticateV4ReencryptionPreparedSelectorEvidence } from "./reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const MAX_CIPHERTEXT_BYTES = 8 * 1024
const RISK = "accept-best-effort-power-loss-recovery-risk"
const TEST_CONTRACT_KEYS = Object.freeze([
  "transactionId", "identity", "sourceIndexSha256", "destinationShadowSha256",
  "preparedEvidenceSha256", "walSnapshotSha256", "sourceSettingsSha256",
  "destinationSettingsSha256",
].sort().join("|"))
const DIGEST = /^[0-9a-f]{64}$/u
const TRANSACTION = /^[0-9a-f]{32}$/u

function validHistoricalContract(value: V4ReencryptionCommitPairTestContract): boolean {
  return Object.keys(value).sort().join("|") === TEST_CONTRACT_KEYS
    && TRANSACTION.test(value.transactionId)
    && !/^0+$/u.test(value.transactionId)
    && [
      value.sourceIndexSha256, value.destinationShadowSha256,
      value.preparedEvidenceSha256, value.walSnapshotSha256,
      value.sourceSettingsSha256, value.destinationSettingsSha256,
    ].every(digest => typeof digest === "string" && DIGEST.test(digest))
}

/**
 * D184 is a post-crash *diagnostic*, not a Commit reader. The historical D183
 * contract cannot be independently re-proven against Git after arbitrary
 * partial local cutover: the active Selector/receipt intentionally causes D183
 * to fail closed. Never use this input to authorize a state transition.
 */
export interface V4FencedCrashWindowPairInput {
  readonly prepared: V4BestEffortPreparedSelectorStageInput
  /** Historical D183 witness, not an authoritative or durable receipt. */
  readonly contract: V4ReencryptionCommitPairTestContract
  /** Exact historical Source Settings, not an inferred current setting. */
  readonly sourceSettings: V4LocalCutoverSettings
}

export type V4CrashArtifactWindow =
  | "absent" | "receipt-directory-only" | "receipt-only"
  | "selector-only" | "pair-present" | "unrecognized-layout"
  | "unverifiable"

export type V4CrashLocalSelection =
  | "source" | "destination" | "mixed" | "unverifiable"

export interface V4FencedCrashWindowPairReport {
  readonly integrityScope: "read-only-fenced-post-crash-test-pair-window"
  readonly evidence: "historical-d183-witness-and-best-effort-wal-readback-not-durable"
  readonly observation: "source-prepared-uncommitted" | "manual-recovery-required"
  readonly reason: "source-still-selected-no-pair" | "linked-test-pair-not-authoritative"
    | "partial-or-foreign-commit-artifacts" | "settings-or-index-partially-switched"
    | "historical-evidence-missing-or-changed" | "fence-wal-lease-or-storage-uncertain"
  readonly artifactWindow: V4CrashArtifactWindow
  readonly settingsSelection: V4CrashLocalSelection
  readonly activeIndexSelection: V4CrashLocalSelection
  readonly pairEvidence: "absent" | "cryptographically-linked-uncommitted" | "unverifiable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-post-crash-test-pair-window" as const,
  evidence: "historical-d183-witness-and-best-effort-wal-readback-not-durable" as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
function result(
  reason: V4FencedCrashWindowPairReport["reason"],
  artifactWindow: V4CrashArtifactWindow = "unverifiable",
  settingsSelection: V4CrashLocalSelection = "unverifiable",
  activeIndexSelection: V4CrashLocalSelection = "unverifiable",
  pairEvidence: V4FencedCrashWindowPairReport["pairEvidence"] = "unverifiable",
): V4FencedCrashWindowPairReport {
  return Object.freeze({
    ...BASE,
    observation: reason === "source-still-selected-no-pair"
      ? "source-prepared-uncommitted" as const
      : "manual-recovery-required" as const,
    reason, artifactWindow, settingsSelection, activeIndexSelection, pairEvidence,
  })
}
const UNCERTAIN = result("fence-wal-lease-or-storage-uncertain")
const digest = (value: string) => sha256Hex(utf8ToBytes(value))

function matchIndex(
  index: V4LocalIndex, repoId: string, commit: string, deviceId: string,
): boolean {
  return index.repoId === repoId && index.remoteCommitSha === commit
    && index.deviceId === deviceId && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(record => !record.dirty && !record.deleted))
}
async function intentSerialized(id: V4ReencryptionCommitPairTestContract["identity"]): Promise<string> {
  const body = {
    schemaVersion: 1 as const, phase: "prepared-uncommitted" as const,
    runId: id.runId, walGeneration: id.walGeneration,
    sourceIndexRoot: id.indexRoot,
    destinationIndexRoot: id.indexRoot + "-rekey-" + id.runId,
    sourceRepoId: id.sourceRepoId, backupRepoId: id.backupRepoId,
    destinationRepoId: id.destinationRepoId,
    sourceCommitSha: id.sourceCommitSha, destinationCommitSha: id.destinationCommitSha,
    sourcePassphraseSecretId: id.sourcePassphraseSecretId,
    destinationPassphraseSecretId: id.destinationPassphraseSecretId,
    deviceId: id.deviceId,
  }
  return JSON.stringify({
    ...body, recordSha256: await digest(JSON.stringify(body)),
  })
}
interface ArtifactSnapshot {
  readonly window: V4CrashArtifactWindow
  readonly selector: string | null
  readonly receipt: string | null
}
async function artifacts(
  adapter: V4BestEffortPreparedSelectorStageInput["restart"]["indexAdapter"],
  selectorPath: string, proposedRoot: string,
): Promise<ArtifactSnapshot> {
  const receiptPath = proposedRoot + "/marker.json"
  const [directory, marker, selector] = await Promise.all([
    adapter.exists(proposedRoot), adapter.exists(receiptPath), adapter.exists(selectorPath),
  ])
  if (selector && marker && directory) {
    const [sStat, rStat] = await Promise.all([
      adapter.stat?.(selectorPath), adapter.stat?.(receiptPath),
    ])
    for (const size of [sStat?.size, rStat?.size]) {
      if (size !== undefined && (!Number.isSafeInteger(size)
        || size < 0 || size > MAX_CIPHERTEXT_BYTES)) {
        return { window: "unrecognized-layout", selector: null, receipt: null }
      }
    }
    // Read the two linked records in a fixed order: a mutated Receipt after
    // reading the Selector must be observed, not hidden by parallel GETs.
    const s = await adapter.read(selectorPath)
    const r = await adapter.read(receiptPath)
    if (!fitsV4LocalJsonSizeLimit(s, MAX_CIPHERTEXT_BYTES)
      || !fitsV4LocalJsonSizeLimit(r, MAX_CIPHERTEXT_BYTES)) {
      return { window: "unrecognized-layout", selector: null, receipt: null }
    }
    return { window: "pair-present", selector: s, receipt: r }
  }
  if (marker && !directory) return { window: "unrecognized-layout", selector: null, receipt: null }
  if (marker) return { window: "receipt-only", selector: null, receipt: null }
  if (selector) return { window: "selector-only", selector: null, receipt: null }
  if (directory) return { window: "receipt-directory-only", selector: null, receipt: null }
  return { window: "absent", selector: null, receipt: null }
}

/**
 * No disk writes. One caller-held cooperative lease and two *independent*
 * local observations bracket AES-GCM authentication of a historical D182 pair.
 * Even an authentic pair from a D183-proven source is strictly UNCOMMITTED.
 */
export async function inspectV4FencedCrashWindowPairAfterRestart(
  input: V4FencedCrashWindowPairInput,
): Promise<V4FencedCrashWindowPairReport> {
  const prepared = input?.prepared
  const restart = prepared?.restart
  const contract = input?.contract
  const id = contract?.identity
  if (!restart || !id || !input.sourceSettings) return UNCERTAIN
  try {
    assertV4ReencryptionProposedCommitIdentity(id)
    if (!validHistoricalContract(contract)) return UNCERTAIN
  } catch { return UNCERTAIN }

  const adapter = restart.indexAdapter
  const journal = restart.journal
  const wal = restart.wal
  const key = prepared.journalKey
  const holder = prepared.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  const getSecret = restart.getSecret
  if (restart.acknowledgement !== RISK
    || !adapter || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || !(key instanceof Uint8Array) || key.length !== 32
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof getSecret !== "function"
    || restart.runId !== id.runId || restart.indexRoot !== id.indexRoot
    || restart.sourceCommitSha !== id.sourceCommitSha || restart.backupRepoId !== id.backupRepoId
    || restart.expectedWalGeneration !== id.walGeneration
    || JSON.stringify(prepared.identity) !== JSON.stringify(id)
    || restart.expected.sourceRepoId !== id.sourceRepoId
    || restart.expected.destinationRepoId !== id.destinationRepoId
    || restart.expected.destinationCommitSha !== id.destinationCommitSha
    || restart.expected.deviceId !== id.deviceId
    || restart.expected.sourcePassphraseSecretId !== id.sourcePassphraseSecretId
    || restart.expected.destinationPassphraseSecretId !== id.destinationPassphraseSecretId
    || journal.sourceCommitSha !== id.sourceCommitSha
    || journal.destinationRepoId !== id.destinationRepoId) return UNCERTAIN

  const sourceSettings = JSON.stringify(input.sourceSettings)
  const source = input.sourceSettings
  if (source.githubOwner + "/" + source.githubRepo + "#" + source.githubBranch !== id.sourceRepoId
    || source.encryptionMode !== "encrypted"
    || source.encryptionPassphraseSecretId !== id.sourcePassphraseSecretId
    || source.vault !== id.deviceId) return UNCERTAIN
  const targetSettings = JSON.stringify({
    ...source, githubBranch: id.destinationRepoId.split("#")[1],
    encryptionPassphraseSecretId: id.destinationPassphraseSecretId,
  })
  const oldSecret = getSecret(id.sourcePassphraseSecretId)
  const newSecret = getSecret(id.destinationPassphraseSecretId)
  if (!oldSecret || !newSecret) return UNCERTAIN
  const keySnapshot = toBase64(key)
  const liveSettings = restart.settings
  const liveSettingsBytes = JSON.stringify(liveSettings)
  const expectedRestart = JSON.stringify(restart.expected)
  const originalRestartFields = JSON.stringify({
    runId: restart.runId, indexRoot: restart.indexRoot,
    sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
    expectedWalGeneration: restart.expectedWalGeneration,
    acknowledgement: restart.acknowledgement,
  })
  const expectedContract = JSON.stringify(contract)
  const originals = {
    input, prepared, restart, contract, id, adapter, journal, wal,
    key, holder, lease, getSecret, sourceSettings, oldSecret, newSecret,
    contractBytes: expectedContract,
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    journalRead: journal.assertHealthySnapshot, walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
  }
  const unchanged = () =>
    input.prepared === prepared && input.contract === contract
    && input.sourceSettings === source && JSON.stringify(source) === sourceSettings
    && prepared.restart === restart && prepared.journalKey === key
    && prepared.withExclusiveInitiatorLease === holder
    && JSON.stringify(prepared.identity) === JSON.stringify(id)
    && contract.identity === id && JSON.stringify(contract) === originals.contractBytes
    && restart.settings === liveSettings
    && JSON.stringify(restart.settings) === liveSettingsBytes
    && JSON.stringify(restart.expected) === expectedRestart
    && JSON.stringify({
      runId: restart.runId, indexRoot: restart.indexRoot,
      sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
      expectedWalGeneration: restart.expectedWalGeneration,
      acknowledgement: restart.acknowledgement,
    }) === originalRestartFields
    && restart.indexAdapter === adapter && restart.journal === journal && restart.wal === wal
    && restart.getSecret === getSecret && restart.assertExclusiveInitiatorLease === lease
    && adapter.read === originals.read && adapter.exists === originals.exists
    && adapter.stat === originals.stat && journal.assertHealthySnapshot === originals.journalRead
    && wal.assertExclusiveStageLease === originals.walLease
    && wal.assertBestEffortCheckpoint === originals.checkpoint
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && toBase64(key) === keySnapshot
    && getSecret(id.sourcePassphraseSecretId) === oldSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D184 local recovery identity or SecretStorage drift.")
    await lease()
    await originals.walLease.call(wal)
    if (await originals.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D184 WAL readback uncertain.")
  }
  const fence = async () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  }, assertHeld)

  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const preparedPath = roots.selectorPath.slice(0, -"/selector.json".length) + "/prepared.json"
  const intentPath = id.indexRoot + "-rekey-intent-" + id.runId + "/intent.json"
  const proposedRoot = id.indexRoot + "-rekey-proposed-" + id.runId
  const capture = async () => {
    await assertHeld()
    await fence()
    const [activeIndex, shadowIndex, evidenceExists, intentExists] = await Promise.all([
      loadV4LocalIndex(adapter, id.indexRoot),
      loadV4LocalIndex(adapter, id.indexRoot + "-rekey-" + id.runId),
      adapter.exists(preparedPath), adapter.exists(intentPath),
    ])
    if (!evidenceExists || !intentExists) throw Error("D184 missing prepared/intent evidence.")
    const [preparedStat, intentStat] = await Promise.all([
      originals.stat?.call(adapter, preparedPath), originals.stat?.call(adapter, intentPath),
    ])
    if ([preparedStat?.size].some(size =>
      size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_CIPHERTEXT_BYTES))
      || [intentStat?.size].some(size => size !== undefined
        && (!Number.isSafeInteger(size) || size < 0
          || size > V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES))) {
      throw Error("D184 oversized prepared or Intent evidence.")
    }
    const [evidence, intent, walSnapshot, artifact] = await Promise.all([
      originals.read.call(adapter, preparedPath),
      originals.read.call(adapter, intentPath),
      originals.journalRead.call(journal, id.walGeneration),
      artifacts(adapter, roots.selectorPath, proposedRoot),
    ])
    if (!fitsV4LocalJsonSizeLimit(evidence, MAX_CIPHERTEXT_BYTES)
      || !fitsV4LocalJsonSizeLimit(intent, V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)
      || !matchesV4ReencryptionPreparedWal(walSnapshot, id)
      || intent !== await intentSerialized(id)
      || !await authenticateV4ReencryptionPreparedSelectorEvidence(evidence, id, key)) {
      throw Error("D184 prepared/WAL/Intent no longer match original Run.")
    }
    await assertHeld()
    await fence()
    return {
      activeIndex, shadowIndex, evidence, intent,
      walBytes: JSON.stringify(walSnapshot),
      artifacts: artifact,
      settings: JSON.stringify(restart.settings),
    }
  }

  let bodyCount = 0
  let bodyResult: V4FencedCrashWindowPairReport | null = null
  try {
    const returned = await holder(async () => {
      bodyCount++
      if (bodyCount !== 1) throw Error("D184 holder called inspection twice.")
      const first = await capture()
      const settingsSelection: V4CrashLocalSelection =
        first.settings === sourceSettings ? "source"
          : first.settings === targetSettings ? "destination" : "mixed"
      const activeIndexSelection: V4CrashLocalSelection = matchIndex(
        first.activeIndex, id.sourceRepoId, id.sourceCommitSha, id.deviceId,
      ) ? "source" : matchIndex(first.activeIndex,
        id.destinationRepoId, id.destinationCommitSha, id.deviceId) ? "destination" : "mixed"
      let pairEvidence: V4FencedCrashWindowPairReport["pairEvidence"] = "unverifiable"
      const artifactWindow = first.artifacts.window
      if (artifactWindow === "absent") pairEvidence = "absent"
      else if (artifactWindow === "pair-present") {
        const proof = await inspectV4ReencryptionCommitPairTestVectors(contract, key, {
          receiptTestVector: first.artifacts.receipt,
          selectorTestVector: first.artifacts.selector,
        })
        if (proof.observation === "both-test-vectors-authenticate-uncommitted"
          && proof.localCutoverAuthorized === false && unchanged()) {
          pairEvidence = "cryptographically-linked-uncommitted"
        }
      }
      const historicalMatches = await digest(sourceSettings) === contract.sourceSettingsSha256
        && await digest(targetSettings) === contract.destinationSettingsSha256
        && await digest(JSON.stringify(first.activeIndex)) === contract.sourceIndexSha256
        && await digest(JSON.stringify(first.shadowIndex)) === contract.destinationShadowSha256
        && await digest(first.evidence) === contract.preparedEvidenceSha256
        && await digest(first.walBytes) === contract.walSnapshotSha256
        && matchIndex(first.shadowIndex,
          id.destinationRepoId, id.destinationCommitSha, id.deviceId)
      await assertHeld()
      const second = await capture()
      if (JSON.stringify(first) !== JSON.stringify(second) || !unchanged()) {
        throw Error("D184 persisted evidence changed during crash-window inspection.")
      }
      const reason: V4FencedCrashWindowPairReport["reason"] = !historicalMatches
        ? "historical-evidence-missing-or-changed"
        : artifactWindow !== "absent" && pairEvidence !== "cryptographically-linked-uncommitted"
          ? "partial-or-foreign-commit-artifacts"
          : settingsSelection !== "source" || activeIndexSelection !== "source"
            ? "settings-or-index-partially-switched"
            : artifactWindow === "pair-present"
              ? "linked-test-pair-not-authoritative"
              : "source-still-selected-no-pair"
      bodyResult = result(reason, artifactWindow, settingsSelection,
        activeIndexSelection, pairEvidence)
      return bodyResult
    })
    return bodyCount === 1 && returned === bodyResult && unchanged() ? returned : UNCERTAIN
  } catch {
    return UNCERTAIN
  }
}
