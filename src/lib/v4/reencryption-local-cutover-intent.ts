import { sha256Hex, utf8ToBytes } from "../bytes"
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import {
  fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex,
  type V4LocalIndex, type V4LocalIndexAdapter,
} from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import type { V4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"

const SHA = /^[a-f0-9]{40}$/u
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
import { isSafeV4ReencryptionSourceIndexRoot } from "./reencryption-index-root"
export const V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES = 8 * 1024
const activeIntents = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4ReencryptionLocalCutoverIntentInput {
  readonly adapter: V4LocalIndexAdapter
  readonly activeIndexRoot: string
  readonly runId: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly destinationCommitSha: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
  readonly deviceId: string
  readonly walGeneration: number
  /** Genuine platform lease must exclude other cooperating local cutover writers. */
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  /** Genuine crash-persistence barrier supplied by an independently verified adapter. */
  readonly assertCrashDurable: () => Promise<void>
}

export interface V4ReencryptionLocalCutoverIntentRecord {
  readonly schemaVersion: 1
  readonly phase: "prepared-uncommitted"
  readonly runId: string
  readonly walGeneration: number
  readonly sourceIndexRoot: string
  readonly destinationIndexRoot: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly destinationCommitSha: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
  readonly deviceId: string
  /** An unkeyed corruption checksum, NOT authentication or a commit receipt. */
  readonly recordSha256: string
}

export interface V4ReencryptionLocalCutoverIntentResult {
  readonly status: "local-cutover-intent-prepared-uncommitted"
  readonly intentPath: string
  readonly recordSha256: string
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

type CutoverIntentCoreInput = Omit<V4ReencryptionLocalCutoverIntentInput, "assertCrashDurable">

type PinnedIntent = Omit<CutoverIntentCoreInput,
  "adapter" | "assertExclusiveInitiatorLease">

function validIdentity(repoId: string): { owner: string; repo: string; branch: string } {
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(repoId)
  if (!match) throw new Error("Invalid cutover intent GitHub repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { owner, repo, branch }
}

function validate(input: CutoverIntentCoreInput, checkpoint: () => Promise<void>): PinnedIntent {
  if (!input || typeof input.activeIndexRoot !== "string"
    || !isSafeV4ReencryptionSourceIndexRoot(input.activeIndexRoot)
    || typeof input.runId !== "string" || !RUN.test(input.runId)
    || !SHA.test(input.sourceCommitSha) || !SHA.test(input.destinationCommitSha)
    || input.sourceCommitSha === input.destinationCommitSha
    || !Number.isSafeInteger(input.walGeneration) || input.walGeneration <= 0
    || !input.deviceId || typeof input.deviceId !== "string"
    || typeof input.sourcePassphraseSecretId !== "string"
    || typeof input.destinationPassphraseSecretId !== "string"
    || !input.sourcePassphraseSecretId || !input.destinationPassphraseSecretId
    || input.sourcePassphraseSecretId === input.destinationPassphraseSecretId
    || [input.sourcePassphraseSecretId, input.destinationPassphraseSecretId].some(id =>
      id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id))
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof checkpoint !== "function"
    || typeof input.adapter?.exists !== "function"
    || typeof input.adapter.read !== "function"
    || typeof input.adapter.write !== "function"
    || typeof input.adapter.mkdir !== "function") {
    throw new Error("Invalid strictly gated Re-encryption local cutover intent.")
  }
  const source = validIdentity(input.sourceRepoId)
  const backup = validIdentity(input.backupRepoId)
  const destination = validIdentity(input.destinationRepoId)
  if (source.owner !== backup.owner || source.owner !== destination.owner
    || source.repo !== backup.repo || source.repo !== destination.repo
    || new Set([source.branch, backup.branch, destination.branch]).size !== 3) {
    throw new Error("Cutover intent requires three distinct branches in one repository.")
  }
  return Object.freeze({
    activeIndexRoot: input.activeIndexRoot,
    runId: input.runId,
    sourceRepoId: input.sourceRepoId,
    backupRepoId: input.backupRepoId,
    destinationRepoId: input.destinationRepoId,
    sourceCommitSha: input.sourceCommitSha,
    destinationCommitSha: input.destinationCommitSha,
    sourcePassphraseSecretId: input.sourcePassphraseSecretId,
    destinationPassphraseSecretId: input.destinationPassphraseSecretId,
    deviceId: input.deviceId,
    walGeneration: input.walGeneration,
  })
}

function checkIndex(index: V4LocalIndex, pinned: PinnedIntent, role: "source" | "destination"): void {
  const repoId = role === "source" ? pinned.sourceRepoId : pinned.destinationRepoId
  const sha = role === "source" ? pinned.sourceCommitSha : pinned.destinationCommitSha
  if (index.repoId !== repoId || index.remoteCommitSha !== sha
    || index.deviceId !== pinned.deviceId || index.mode !== "encrypted"
    || index.pathLayout !== expectedV4PathLayout("encrypted")
    || !isV4LocalIndexCacheComplete(index)
    || Object.values(index.shards).some(shard =>
      Object.values(shard.records).some(record => record.dirty === true || record.deleted === true))) {
    throw new Error("Re-encryption " + role + " index is incomplete, dirty or mismatched.")
  }
}

function sameInput(
  input: CutoverIntentCoreInput,
  pinned: PinnedIntent,
  adapter: V4LocalIndexAdapter,
  lease: () => Promise<void>,
  checkpointUnchanged: () => boolean,
): boolean {
  return input.adapter === adapter
    && input.assertExclusiveInitiatorLease === lease
    && checkpointUnchanged()
    && (Object.keys(pinned) as Array<keyof PinnedIntent>)
      .every(key => input[key] === pinned[key])
}

/**
 * Prepare ONLY the independent, nonsecret intent for a future restart-safe
 * transaction. Never write either index root, Settings or SecretStorage.
 *
 * A partial or completed intent directory is never reused automatically.
 * The caller must separately authenticate the remote fork and WAL and supply
 * platform-backed exclusive writer and crash-durability assertions.
 * This checksum cannot authenticate a malicious or forged local record.
 */
export async function prepareV4ReencryptionLocalCutoverIntent(
  input: V4ReencryptionLocalCutoverIntentInput,
): Promise<V4ReencryptionLocalCutoverIntentResult> {
  const durable = input.assertCrashDurable
  if (typeof durable !== "function") {
    throw new Error("Strict local cutover intent requires a crash-durable checkpoint.")
  }
  return prepareCutoverIntent(input, durable, () => input.assertCrashDurable === durable)
}

export interface V4BestEffortReencryptionLocalCutoverIntentInput extends CutoverIntentCoreInput {
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
}

/**
 * Only creates the uncommitted, nonsecret local recovery Intent.
 * It never selects Destination, changes Settings/SecretStorage, or grants Sync.
 */
export async function prepareV4BestEffortReencryptionLocalCutoverIntent(
  input: V4BestEffortReencryptionLocalCutoverIntentInput,
): Promise<V4ReencryptionLocalCutoverIntentResult> {
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.wal?.assertExclusiveStageLease !== "function"
    || typeof input.wal.assertBestEffortCheckpoint !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || input.journal.sourceCommitSha !== input.sourceCommitSha
    || input.journal.destinationRepoId !== input.destinationRepoId) {
    throw new Error("Best-effort local intent requires risk acknowledgement and matching authenticated WAL.")
  }
  const wal = input.wal
  const journal = input.journal
  const read = journal.assertHealthySnapshot
  const check = wal.assertBestEffortCheckpoint
  const lock = wal.assertExclusiveStageLease
  const unchanged = () => input.wal === wal && input.journal === journal
    && wal.assertBestEffortCheckpoint === check
    && wal.assertExclusiveStageLease === lock
    && journal.assertHealthySnapshot === read
    && journal.sourceCommitSha === input.sourceCommitSha
    && journal.destinationRepoId === input.destinationRepoId
  const checkpoint = async () => {
    if (!unchanged()) throw new Error("Best-effort local intent WAL binding changed; Manual Recovery required.")
    await lock.call(wal)
    const proof = await inspectV4BestEffortWalRecovery({
      storage: wal, journal,
      expected: {
        sourceCommitSha: input.sourceCommitSha,
        destinationRepoId: input.destinationRepoId,
        generation: input.walGeneration,
      },
    })
    if (!unchanged() || proof.observation !== "authenticated-uncommitted"
      || proof.generation !== input.walGeneration || proof.localCutoverAuthorized !== false) {
      throw new Error("Best-effort local intent WAL is uncertain; Manual Recovery required.")
    }
    const saved = await read.call(journal, input.walGeneration)
    const backup = saved.verifiedRefObservations.find(ref => ref.role === "backup")
    const destination = saved.verifiedRefObservations.find(ref => ref.role === "destination")
    const candidate = saved.preparedCandidateReceipt
    if (saved.generation !== input.walGeneration
      || saved.pendingIntents.length || saved.pendingRefIntents.length
      || saved.verifiedRefObservations.length !== 2
      || saved.stageHandoffStarted !== true
      || saved.cutoverAuthorized !== false || saved.permissionToPublish !== false
      || !saved.candidatePreparationSha256 || !candidate
      || !backup || backup.repoId !== input.backupRepoId
      || backup.commitSha !== input.sourceCommitSha
      || !destination || destination.repoId !== input.destinationRepoId
      || destination.commitSha !== input.destinationCommitSha
      || destination.treeSha !== candidate.treeSha
      || destination.manifestSha256 !== candidate.manifestSha256
      || candidate.commitSha !== input.destinationCommitSha) {
      throw new Error("Best-effort local intent lacks complete authenticated three-branch WAL evidence; Manual Recovery required.")
    }
    await lock.call(wal)
    if (!unchanged()) throw new Error("Best-effort local intent WAL binding changed; Manual Recovery required.")
  }
  return prepareCutoverIntent(input, checkpoint, unchanged)
}

async function prepareCutoverIntent(
  input: CutoverIntentCoreInput,
  checkpoint: () => Promise<void>,
  checkpointUnchanged: () => boolean,
): Promise<V4ReencryptionLocalCutoverIntentResult> {
  const pinned = validate(input, checkpoint)
  const adapter = input.adapter
  const lease = input.assertExclusiveInitiatorLease
  const intentRoot = pinned.activeIndexRoot + "-rekey-intent-" + pinned.runId
  const shadowRoot = pinned.activeIndexRoot + "-rekey-" + pinned.runId
  const intentPath = intentRoot + "/intent.json"
  const claim = activeIntents.get(adapter) ?? new Set<string>()
  if (claim.has(intentRoot)) throw new Error("Concurrent local cutover intent preparation requires manual recovery.")
  claim.add(intentRoot)
  activeIntents.set(adapter, claim)
  try {
    await lease()
    if (!sameInput(input, pinned, adapter, lease, checkpointUnchanged)) {
      throw new Error("Local cutover intent storage contract changed before staging.")
    }
    await checkpoint()
    const sourceIndex = await loadV4LocalIndex(adapter, pinned.activeIndexRoot)
    const destinationIndex = await loadV4LocalIndex(adapter, shadowRoot)
    checkIndex(sourceIndex, pinned, "source")
    checkIndex(destinationIndex, pinned, "destination")
    if (!sameInput(input, pinned, adapter, lease, checkpointUnchanged)) {
      throw new Error("Local cutover intent input changed before staging.")
    }
    await lease()
    if (await adapter.exists(intentRoot)) {
      throw new Error("Existing local cutover intent requires manual recovery; never overwrite or reuse.")
    }
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      phase: "prepared-uncommitted" as const,
      runId: pinned.runId,
      walGeneration: pinned.walGeneration,
      sourceIndexRoot: pinned.activeIndexRoot,
      destinationIndexRoot: shadowRoot,
      sourceRepoId: pinned.sourceRepoId,
      backupRepoId: pinned.backupRepoId,
      destinationRepoId: pinned.destinationRepoId,
      sourceCommitSha: pinned.sourceCommitSha,
      destinationCommitSha: pinned.destinationCommitSha,
      sourcePassphraseSecretId: pinned.sourcePassphraseSecretId,
      destinationPassphraseSecretId: pinned.destinationPassphraseSecretId,
      deviceId: pinned.deviceId,
    })
    const recordSha256 = await sha256Hex(utf8ToBytes(JSON.stringify(payload)))
    const record: V4ReencryptionLocalCutoverIntentRecord = { ...payload, recordSha256 }
    const serialized = JSON.stringify(record)
    if (!fitsV4LocalJsonSizeLimit(serialized, V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)) {
      throw new Error("Local cutover intent exceeds the bounded restart-reader size limit.")
    }
    if (!sameInput(input, pinned, adapter, lease, checkpointUnchanged)) {
      throw new Error("Local cutover intent storage contract changed before write.")
    }
    await adapter.mkdir(intentRoot)
    await adapter.write(intentPath, serialized)
    await checkpoint()
    await lease()
    const actual = await adapter.read(intentPath)
    if (actual !== serialized) throw new Error("Local cutover intent readback mismatch; manual recovery required.")
    await checkpoint()
    await lease()
    if (!sameInput(input, pinned, adapter, lease, checkpointUnchanged)) {
      throw new Error("Local cutover intent identity changed during preparation.")
    }
    checkIndex(await loadV4LocalIndex(adapter, pinned.activeIndexRoot), pinned, "source")
    checkIndex(await loadV4LocalIndex(adapter, shadowRoot), pinned, "destination")
    if (!sameInput(input, pinned, adapter, lease, checkpointUnchanged)) {
      throw new Error("Local cutover intent storage contract changed after readback.")
    }
    return Object.freeze({
      status: "local-cutover-intent-prepared-uncommitted",
      intentPath, recordSha256,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
    })
  } finally {
    claim.delete(intentRoot)
    if (claim.size === 0) activeIntents.delete(adapter)
  }
}
