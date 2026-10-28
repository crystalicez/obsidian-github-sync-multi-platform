import { sha256Hex, utf8ToBytes } from "../bytes"
import { fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import {
  inspectV4ReencryptionCutoverEvidence,
  type V4ReencryptionLocalCutoverEvidenceInput,
} from "./reencryption-local-cutover-evidence"
import {
  V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES,
  type V4ReencryptionLocalCutoverIntentRecord,
} from "./reencryption-local-cutover-intent"

const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SHA = /^[0-9a-f]{40}$/u


export interface V4ReencryptionRestartInspectionInput extends V4ReencryptionLocalCutoverEvidenceInput {
  readonly runId: string
}

export interface V4ReencryptionRestartInspection {
  readonly integrityScope: "read-only-local-intent-shadow-and-encrypted-wal"
  readonly observation: "source-with-prepared-intent-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4ReencryptionRestartInspection = Object.freeze({
  integrityScope: "read-only-local-intent-shadow-and-encrypted-wal",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})

const PREPARED: V4ReencryptionRestartInspection = Object.freeze({
  ...MANUAL, observation: "source-with-prepared-intent-uncommitted",
})

function validRoot(root: string): boolean {
  return typeof root === "string" && root.split("/").length >= 2
    && root.split("/").every(segment => /^[A-Za-z0-9_.-]+$/u.test(segment)
      && segment !== "." && segment !== "..")
}

function validate(input: V4ReencryptionRestartInspectionInput): void {
  if (!input || typeof input.runId !== "string" || !RUN.test(input.runId)
    || !validRoot(input.indexRoot)
    || !SHA.test(input.sourceCommitSha)
    || !SHA.test(input.expected?.destinationCommitSha)
    || input.sourceCommitSha === input.expected.destinationCommitSha
    || !Number.isSafeInteger(input.expectedWalGeneration) || input.expectedWalGeneration <= 0
    || typeof input.indexAdapter?.exists !== "function"
    || typeof input.indexAdapter.read !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function") {
    throw new Error("Invalid read-only Re-encryption restart evidence contract.")
  }
}

function matchesIndex(
  index: Awaited<ReturnType<typeof loadV4LocalIndex>>,
  repoId: string, commitSha: string, deviceId: string,
): boolean {
  return index.repoId === repoId && index.remoteCommitSha === commitSha
    && index.deviceId === deviceId && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(record => record.dirty !== true && record.deleted !== true))
}

function unchanged(
  input: V4ReencryptionRestartInspectionInput,
  pinned: Readonly<{
    runId: string
    indexRoot: string
    sourceCommitSha: string
    backupRepoId: string
    expectedWalGeneration: number
    expected: V4ReencryptionRestartInspectionInput["expected"]
    settings: V4ReencryptionRestartInspectionInput["settings"]
    indexAdapter: V4ReencryptionRestartInspectionInput["indexAdapter"]
    journal: V4ReencryptionRestartInspectionInput["journal"]
    walReader: V4ReencryptionRestartInspectionInput["journal"]["assertHealthySnapshot"]
    getSecret: V4ReencryptionRestartInspectionInput["getSecret"]
    lease: V4ReencryptionRestartInspectionInput["assertExclusiveInitiatorLease"]
    durable: V4ReencryptionRestartInspectionInput["assertCrashDurable"]
  }>,
): boolean {
  return input.runId === pinned.runId && input.indexRoot === pinned.indexRoot
    && input.sourceCommitSha === pinned.sourceCommitSha
    && input.backupRepoId === pinned.backupRepoId
    && input.expectedWalGeneration === pinned.expectedWalGeneration
    && input.indexAdapter === pinned.indexAdapter
    && input.journal === pinned.journal
    && input.journal.assertHealthySnapshot === pinned.walReader
    && input.getSecret === pinned.getSecret
    && input.assertExclusiveInitiatorLease === pinned.lease
    && input.assertCrashDurable === pinned.durable
    && pinned.journal.sourceCommitSha === pinned.sourceCommitSha
    && pinned.journal.destinationRepoId === pinned.expected.destinationRepoId
    && Object.entries(pinned.expected).every(([key, value]) =>
      input.expected[key as keyof typeof pinned.expected] === value)
    && Object.entries(pinned.settings).every(([key, value]) =>
      input.settings[key as keyof typeof pinned.settings] === value)
}

async function readIntent(
  adapter: V4ReencryptionRestartInspectionInput["indexAdapter"],
  path: string, expectedSerialized: string,
): Promise<boolean> {
  if (!await adapter.exists(path)) return false
  const stat = await adapter.stat?.(path)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)) return false
  const serialized = await adapter.read(path)
  return fitsV4LocalJsonSizeLimit(serialized, V4_REENCRYPTION_LOCAL_CUTOVER_INTENT_MAX_BYTES)
    && serialized === expectedSerialized
}

/**
 * An unkeyed intent is only a hint. The expected bytes are built from pinned
 * external identities, then bracketed around authenticated WAL observation.
 * No local or remote action can be authorized from this report.
 */
export async function inspectV4ReencryptionRestartEvidence(
  input: V4ReencryptionRestartInspectionInput,
): Promise<V4ReencryptionRestartInspection> {
  validate(input)
  const pinned = Object.freeze({
    runId: input.runId,
    indexRoot: input.indexRoot,
    sourceCommitSha: input.sourceCommitSha,
    backupRepoId: input.backupRepoId,
    expectedWalGeneration: input.expectedWalGeneration,
    expected: Object.freeze({ ...input.expected }),
    settings: Object.freeze({ ...input.settings }),
    indexAdapter: input.indexAdapter,
    journal: input.journal,
    walReader: input.journal.assertHealthySnapshot,
    getSecret: input.getSecret,
    lease: input.assertExclusiveInitiatorLease,
    durable: input.assertCrashDurable,
  })
  const shadowRoot = pinned.indexRoot + "-rekey-" + pinned.runId
  const intentPath = pinned.indexRoot + "-rekey-intent-" + pinned.runId + "/intent.json"
  const payload = {
    schemaVersion: 1 as const,
    phase: "prepared-uncommitted" as const,
    runId: pinned.runId,
    walGeneration: pinned.expectedWalGeneration,
    sourceIndexRoot: pinned.indexRoot,
    destinationIndexRoot: shadowRoot,
    sourceRepoId: pinned.expected.sourceRepoId,
    backupRepoId: pinned.backupRepoId,
    destinationRepoId: pinned.expected.destinationRepoId,
    sourceCommitSha: pinned.sourceCommitSha,
    destinationCommitSha: pinned.expected.destinationCommitSha,
    sourcePassphraseSecretId: pinned.expected.sourcePassphraseSecretId,
    destinationPassphraseSecretId: pinned.expected.destinationPassphraseSecretId,
    deviceId: pinned.expected.deviceId,
  }
  const digest = await sha256Hex(utf8ToBytes(JSON.stringify(payload)))
  const record: V4ReencryptionLocalCutoverIntentRecord = { ...payload, recordSha256: digest }
  const expectedSerialized = JSON.stringify(record)
  const adapter = pinned.indexAdapter
  await pinned.lease()
  await pinned.durable()
  if (!unchanged(input, pinned)) return MANUAL
  if (!await readIntent(adapter, intentPath, expectedSerialized)) return MANUAL
  const firstSource = await loadV4LocalIndex(adapter, pinned.indexRoot)
  const firstShadow = await loadV4LocalIndex(adapter, shadowRoot)
  if (!matchesIndex(firstSource, pinned.expected.sourceRepoId, pinned.sourceCommitSha, pinned.expected.deviceId)
    || !matchesIndex(firstShadow, pinned.expected.destinationRepoId, pinned.expected.destinationCommitSha, pinned.expected.deviceId)
    || !unchanged(input, pinned)) return MANUAL
  if (!pinned.getSecret(pinned.expected.sourcePassphraseSecretId)
    || !pinned.getSecret(pinned.expected.destinationPassphraseSecretId)
    || !unchanged(input, pinned)) return MANUAL
  const firstIndices = JSON.stringify([firstSource, firstShadow])
  const journal = {
    sourceCommitSha: pinned.sourceCommitSha,
    destinationRepoId: pinned.expected.destinationRepoId,
    assertHealthySnapshot: (generation: number) => pinned.walReader.call(pinned.journal, generation),
  }
  const wal = await inspectV4ReencryptionCutoverEvidence({
    ...input,
    expected: pinned.expected, journal, indexAdapter: adapter,
    getSecret: pinned.getSecret, assertExclusiveInitiatorLease: pinned.lease,
    assertCrashDurable: pinned.durable,
    indexRoot: pinned.indexRoot, sourceCommitSha: pinned.sourceCommitSha,
    backupRepoId: pinned.backupRepoId, expectedWalGeneration: pinned.expectedWalGeneration,
  })
  await pinned.lease()
  await pinned.durable()
  if (!unchanged(input, pinned)) return MANUAL
  if (!await readIntent(adapter, intentPath, expectedSerialized)) return MANUAL
  const secondSource = await loadV4LocalIndex(adapter, pinned.indexRoot)
  const secondShadow = await loadV4LocalIndex(adapter, shadowRoot)
  if (!matchesIndex(secondSource, pinned.expected.sourceRepoId, pinned.sourceCommitSha, pinned.expected.deviceId)
    || !matchesIndex(secondShadow, pinned.expected.destinationRepoId, pinned.expected.destinationCommitSha, pinned.expected.deviceId)
    || JSON.stringify([secondSource, secondShadow]) !== firstIndices
    || !unchanged(input, pinned)) return MANUAL
  if (!pinned.getSecret(pinned.expected.sourcePassphraseSecretId)
    || !pinned.getSecret(pinned.expected.destinationPassphraseSecretId)
    || !unchanged(input, pinned)) return MANUAL
  return wal.observation === "source-with-verified-remote-fork-uncommitted" ? PREPARED : MANUAL
}
