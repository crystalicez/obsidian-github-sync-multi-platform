import { sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { fitsV4LocalJsonSizeLimit, type V4LocalIndexAdapter } from "./local-index"
import {
  inspectV4BestEffortReencryptionLocalTransactionAfterCrash,
} from "./reencryption-best-effort-local-restart"
import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import { assertV4ReencryptionExactSyncFence,
  inspectV4FencedBestEffortPreparedSelectorAfterRestart } from "./reencryption-fenced-prepared-selector"
import { V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES } from "./reencryption-local-cutover-intent"
import type { V4BestEffortPreparedSelectorStageInput } from "./reencryption-prepared-selector-stage"
import { assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { authenticateV4ReencryptionPreparedSelectorEvidence } from "./reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

export type V4ReencryptionCrashTriageObservation =
  | "source-prepared-uncommitted"
  | "destination-observed-without-commit-proof"
  | "manual-recovery-required"

export type V4ReencryptionCrashTriageReason =
  | "source-still-selected"
  | "destination-looking-without-authoritative-commit"
  | "unrecognized-selector-or-commit-artifact"
  | "mixed-or-changed-local-state"
  | "missing-or-invalid-prepared-evidence"
  | "fence-wal-or-storage-uncertain"

export interface V4ReencryptionCrashTriageReport {
  readonly integrityScope: "read-only-fenced-local-crash-triage-uncommitted"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly observation: V4ReencryptionCrashTriageObservation
  readonly reason: V4ReencryptionCrashTriageReason
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-local-crash-triage-uncommitted" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const report = (
  observation: V4ReencryptionCrashTriageObservation,
  reason: V4ReencryptionCrashTriageReason,
): V4ReencryptionCrashTriageReport => Object.freeze({ ...BASE, observation, reason })

const UNCERTAIN = report("manual-recovery-required", "fence-wal-or-storage-uncertain")
const UNRECOGNIZED = report("manual-recovery-required", "unrecognized-selector-or-commit-artifact")
const PREPARED_BAD = report("manual-recovery-required", "missing-or-invalid-prepared-evidence")
const MIXED = report("manual-recovery-required", "mixed-or-changed-local-state")
const SOURCE = report("source-prepared-uncommitted", "source-still-selected")
const DEST = report("destination-observed-without-commit-proof",
  "destination-looking-without-authoritative-commit")

/** D180: detect unexpected commit-looking bytes, even if their AES-GCM tag is valid. */
async function unexpectedCommitArtifact(
  adapter: Pick<V4LocalIndexAdapter, "exists">,
  selectorPath: string, proposedRoot: string,
): Promise<boolean> {
  return await adapter.exists(selectorPath) !== false
    || await adapter.exists(proposedRoot) !== false
    || await adapter.exists(proposedRoot + "/marker.json") !== false
}

/**
 * Independently bind D170's non-secret, *unkeyed* intent to an externally
 * pinned identity, even when Settings / active Index are already Destination.
 * This is a corruption detector, NOT authentication or commit permission.
 */
async function expectedIntentBytes(identity: V4BestEffortPreparedSelectorStageInput["identity"]): Promise<string> {
  const payload = {
    schemaVersion: 1 as const, phase: "prepared-uncommitted" as const,
    runId: identity.runId, walGeneration: identity.walGeneration,
    sourceIndexRoot: identity.indexRoot,
    destinationIndexRoot: identity.indexRoot + "-rekey-" + identity.runId,
    sourceRepoId: identity.sourceRepoId,
    backupRepoId: identity.backupRepoId, destinationRepoId: identity.destinationRepoId,
    sourceCommitSha: identity.sourceCommitSha,
    destinationCommitSha: identity.destinationCommitSha,
    sourcePassphraseSecretId: identity.sourcePassphraseSecretId,
    destinationPassphraseSecretId: identity.destinationPassphraseSecretId,
    deviceId: identity.deviceId,
  }
  return JSON.stringify({
    ...payload, recordSha256: await sha256Hex(utf8ToBytes(JSON.stringify(payload))),
  })
}

/**
 * A read-only post-crash diagnostic, NOT an authorization state machine.
 * Source, half-switched, fully Destination-looking, and unexpected receipt
 * residue all keep the D173 Sync Fence and must be reviewed manually.
 */
export async function inspectV4FencedLocalCrashTriageAfterRestart(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4ReencryptionCrashTriageReport> {
  const restart = input?.restart
  const id = input?.identity
  if (!restart || !id) return UNCERTAIN
  try { assertV4ReencryptionProposedCommitIdentity(id) }
  catch { return UNCERTAIN }

  const adapter = restart.indexAdapter
  const holder = input.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  const journal = restart.journal
  const wal = restart.wal
  const getSecret = restart.getSecret
  const key = input.journalKey
  if (restart.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || !adapter || typeof adapter.exists !== "function" || typeof adapter.read !== "function"
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof getSecret !== "function"
    || !(key instanceof Uint8Array) || key.length !== 32
    || restart.runId !== id.runId || restart.indexRoot !== id.indexRoot
    || restart.sourceCommitSha !== id.sourceCommitSha
    || restart.backupRepoId !== id.backupRepoId
    || restart.expectedWalGeneration !== id.walGeneration
    || restart.expected.sourceRepoId !== id.sourceRepoId
    || restart.expected.destinationRepoId !== id.destinationRepoId
    || restart.expected.destinationCommitSha !== id.destinationCommitSha
    || restart.expected.sourcePassphraseSecretId !== id.sourcePassphraseSecretId
    || restart.expected.destinationPassphraseSecretId !== id.destinationPassphraseSecretId
    || restart.expected.deviceId !== id.deviceId
    || journal.sourceCommitSha !== id.sourceCommitSha
    || journal.destinationRepoId !== id.destinationRepoId) return UNCERTAIN

  const identityBytes = JSON.stringify(id)
  const expectedBytes = JSON.stringify(restart.expected)
  const settingsBytes = JSON.stringify(restart.settings)
  const keyBytes = toBase64(key)
  const storageRead = adapter.read
  const storageExists = adapter.exists
  const storageStat = adapter.stat
  const journalRead = journal.assertHealthySnapshot
  const walLease = wal.assertExclusiveStageLease
  const checkpoint = wal.assertBestEffortCheckpoint
  const sourceSecret = getSecret(id.sourcePassphraseSecretId)
  const destinationSecret = getSecret(id.destinationPassphraseSecretId)
  if (!sourceSecret || !destinationSecret) return UNCERTAIN

  const original = { restart, holder, lease, adapter, journal, wal, getSecret, key }
  const unchanged = () => input.restart === original.restart
    && input.withExclusiveInitiatorLease === original.holder
    && input.journalKey === original.key && toBase64(key) === keyBytes
    && JSON.stringify(input.identity) === identityBytes
    && JSON.stringify(restart.expected) === expectedBytes
    && JSON.stringify(restart.settings) === settingsBytes
    && restart.indexAdapter === adapter && restart.journal === journal && restart.wal === wal
    && restart.getSecret === getSecret && restart.assertExclusiveInitiatorLease === lease
    && adapter.read === storageRead && adapter.exists === storageExists
    && adapter.stat === storageStat
    && journal.assertHealthySnapshot === journalRead
    && wal.assertExclusiveStageLease === walLease
    && wal.assertBestEffortCheckpoint === checkpoint
    && getSecret(id.sourcePassphraseSecretId) === sourceSecret
    && getSecret(id.destinationPassphraseSecretId) === destinationSecret
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D180 local recovery identity changed.")
    await lease()
    await walLease.call(wal)
    if (await checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D180 authenticated WAL readback is uncertain.")
  }
  let borrowing = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowing) throw Error("D180 nested cooperative lease is not permitted.")
    borrowing = true
    try {
      await assertHeld()
      const result = await body()
      await assertHeld()
      return result
    } finally { borrowing = false }
  }

  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const preparedPath = roots.selectorPath.replace(/selector\.json$/u, "prepared.json")
  const intentPath = id.indexRoot + "-rekey-intent-" + id.runId + "/intent.json"
  const proposedRoot = id.indexRoot + "-rekey-proposed-" + id.runId
  const fence = async () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  }, assertHeld)
  const readEvidence = async (intentBytes: string) => {
    await assertHeld()
    if (await unexpectedCommitArtifact(adapter, roots.selectorPath, proposedRoot)) return "unexpected" as const
    const [intentExists, preparedExists] = await Promise.all([
      adapter.exists(intentPath), adapter.exists(preparedPath),
    ])
    if (intentExists !== true || preparedExists !== true) return "missing" as const
    const [intentStat, preparedStat] = await Promise.all([
      adapter.stat?.(intentPath), adapter.stat?.(preparedPath),
    ])
    if (intentStat && (!Number.isSafeInteger(intentStat.size)
      || intentStat.size < 0 || intentStat.size > V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)) return "missing" as const
    if (preparedStat && (!Number.isSafeInteger(preparedStat.size)
      || preparedStat.size < 0 || preparedStat.size > 8 * 1024)) return "missing" as const
    const intent = await adapter.read(intentPath)
    const prepared = await adapter.read(preparedPath)
    if (!fitsV4LocalJsonSizeLimit(intent, V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)
      || intent !== intentBytes
      || !fitsV4LocalJsonSizeLimit(prepared, 8 * 1024)
      || !await authenticateV4ReencryptionPreparedSelectorEvidence(prepared, id, key)) {
      return "missing" as const
    }
    await assertHeld()
    return prepared
  }

  let invoked = false
  try {
    return await holder(async () => {
      if (invoked) return UNCERTAIN
      invoked = true
      await fence()
      if (!unchanged()) return UNCERTAIN
      const intentBytes = await expectedIntentBytes(id)
      if (!unchanged()) return UNCERTAIN
      const first = await readEvidence(intentBytes)
      if (first === "unexpected") return UNRECOGNIZED
      if (first === "missing") return PREPARED_BAD

      const walProof = await inspectV4BestEffortWalRecovery({
        storage: wal, journal, expected: {
          sourceCommitSha: id.sourceCommitSha,
          destinationRepoId: id.destinationRepoId,
          generation: id.walGeneration,
        },
      })
      const walSnapshot = await journalRead.call(journal, id.walGeneration)
      if (walProof.observation !== "authenticated-uncommitted"
        || !matchesV4ReencryptionPreparedWal(walSnapshot, id)
        || !unchanged()) return UNCERTAIN
      const pinnedWal = JSON.stringify(walSnapshot)

      const crash = await inspectV4BestEffortReencryptionLocalTransactionAfterCrash({
        ...restart, withExclusiveInitiatorLease: borrowed,
      })
      if (!unchanged()) return UNCERTAIN
      if (crash.observation === "source-prepared-uncommitted") {
        const source = await inspectV4FencedBestEffortPreparedSelectorAfterRestart({
          ...input, withExclusiveInitiatorLease: borrowed,
        })
        if (source.observation !== "authenticated-prepared-selector-uncommitted"
          || !unchanged()) return PREPARED_BAD
      }

      await fence()
      const second = await readEvidence(intentBytes)
      if (second === "unexpected") return UNRECOGNIZED
      if (typeof second !== "string" || second !== first
        || await unexpectedCommitArtifact(adapter, roots.selectorPath, proposedRoot)
        || JSON.stringify(await journalRead.call(journal, id.walGeneration)) !== pinnedWal
        || !unchanged()) return UNCERTAIN
      await fence()
      if (!unchanged()) return UNCERTAIN
      if (crash.observation === "source-prepared-uncommitted") return SOURCE
      if (crash.observation === "destination-observed-without-commit-proof") return DEST
      return MIXED
    })
  } catch {
    return UNCERTAIN
  }
}
