import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit, type V4LocalIndexAdapter } from "./local-index"
import {
  inspectV4BestEffortReencryptionRestartEvidence,
  type V4BestEffortReencryptionRestartInput,
} from "./reencryption-best-effort-local-restart"
import {
  assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal,
  type V4ReencryptionProposedCommitIdentity,
} from "./reencryption-proposed-commit-receipt"
import {
  authenticateV4ReencryptionPreparedSelectorEvidence,
  sealV4ReencryptionPreparedSelectorEvidence,
} from "./reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const MAX_PREPARED_BYTES = 8 * 1024
const activePrepared = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4BestEffortPreparedSelectorStageInput {
  readonly restart: V4BestEffortReencryptionRestartInput
  readonly identity: V4ReencryptionProposedCommitIdentity
  readonly journalKey: Uint8Array
  /** Must exclude cooperating local cutover writers for the entire staged write. */
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
}

export interface V4BestEffortPreparedSelectorStageReport {
  readonly status: "authenticated-prepared-selector-uncommitted"
  readonly evidencePath: string
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

function exactIdentities(
  restart: V4BestEffortReencryptionRestartInput,
  identity: V4ReencryptionProposedCommitIdentity,
): boolean {
  const expected = restart.expected
  return restart.runId === identity.runId
    && restart.indexRoot === identity.indexRoot
    && restart.sourceCommitSha === identity.sourceCommitSha
    && restart.backupRepoId === identity.backupRepoId
    && restart.expectedWalGeneration === identity.walGeneration
    && expected.sourceRepoId === identity.sourceRepoId
    && expected.destinationRepoId === identity.destinationRepoId
    && expected.destinationCommitSha === identity.destinationCommitSha
    && expected.deviceId === identity.deviceId
    && expected.sourcePassphraseSecretId === identity.sourcePassphraseSecretId
    && expected.destinationPassphraseSecretId === identity.destinationPassphraseSecretId
    && restart.settings.githubOwner + "/" + restart.settings.githubRepo + "#" + restart.settings.githubBranch
      === identity.sourceRepoId
    && restart.settings.encryptionMode === "encrypted"
    && restart.settings.encryptionPassphraseSecretId === identity.sourcePassphraseSecretId
    && restart.settings.vault === identity.deviceId
}

/**
 * Stage only a separate, encrypted PREPARED selector proof. The authoritative
 * selector.json is never touched; the staged marker does not commit a cutover.
 * A partial directory/write is retained for Manual Recovery, never retried.
 */
export async function stageV4BestEffortPreparedSelectorEvidence(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4BestEffortPreparedSelectorStageReport> {
  if (!input || !input.restart || !input.identity) {
    throw new Error("Missing prepared selector identity or restart evidence.")
  }
  assertV4ReencryptionProposedCommitIdentity(input.identity)
  const { restart } = input
  if (!exactIdentities(restart, input.identity)
    || restart.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof restart.wal?.assertExclusiveStageLease !== "function"
    || typeof restart.wal.assertBestEffortCheckpoint !== "function"
    || typeof restart.journal?.assertHealthySnapshot !== "function"
    || typeof input.withExclusiveInitiatorLease !== "function"
    || !(input.journalKey instanceof Uint8Array) || input.journalKey.byteLength !== 32
    || typeof restart.indexAdapter?.mkdir !== "function"
    || typeof restart.indexAdapter.write !== "function"
    || typeof restart.indexAdapter.exists !== "function"
    || typeof restart.indexAdapter.read !== "function") {
    throw new Error("Prepared selector requires exact Source, Destination, risk and storage identity.")
  }
  const adapter = restart.indexAdapter
  const { mkdir, write, exists, read } = adapter
  const walReader = restart.journal.assertHealthySnapshot
  const holder = input.withExclusiveInitiatorLease
  const roots = planV4ReencryptionSeparatedRoots(input.identity.indexRoot, input.identity.runId)
  const root = roots.selectorPath.slice(0, -"/selector.json".length)
  const path = root + "/prepared.json"
  const identity = Object.freeze({ ...input.identity })
  const snapshot = JSON.stringify({
    identity, restart: {
      runId: restart.runId, indexRoot: restart.indexRoot,
      sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
      expectedWalGeneration: restart.expectedWalGeneration,
      expected: restart.expected, settings: restart.settings,
    },
  })
  const keyDigest = toBase64(input.journalKey)
  const pinned = {
    wal: restart.wal,
    journal: restart.journal,
    walReader, getSecret: restart.getSecret,
    lease: restart.assertExclusiveInitiatorLease,
    storage: restart.indexAdapter,
    holder, key: input.journalKey,
    walLease: restart.wal.assertExclusiveStageLease,
    walCheck: restart.wal.assertBestEffortCheckpoint,
  }
  const unchanged = () => input.restart === restart && input.withExclusiveInitiatorLease === holder
    && input.journalKey === pinned.key && toBase64(input.journalKey) === keyDigest
    && input.identity !== undefined && JSON.stringify(input.identity) === JSON.stringify(identity)
    && restart.wal === pinned.wal && restart.journal === pinned.journal
    && restart.journal.assertHealthySnapshot === walReader
    && restart.wal.assertExclusiveStageLease === pinned.walLease
    && restart.wal.assertBestEffortCheckpoint === pinned.walCheck
    && restart.indexAdapter === adapter && adapter.mkdir === mkdir
    && adapter.write === write && adapter.exists === exists && adapter.read === read
    && restart.getSecret === pinned.getSecret
    && restart.assertExclusiveInitiatorLease === pinned.lease
    && JSON.stringify({
      identity, restart: {
        runId: restart.runId, indexRoot: restart.indexRoot,
        sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
        expectedWalGeneration: restart.expectedWalGeneration,
        expected: restart.expected, settings: restart.settings,
      },
    }) === snapshot
  const claim = activePrepared.get(adapter) ?? new Set<string>()
  if (claim.has(root)) throw new Error("Concurrent prepared selector attempt requires Manual Recovery.")
  claim.add(root)
  activePrepared.set(adapter, claim)
  let invoked = false
  try {
    const report = await holder(async () => {
    if (invoked) throw new Error("Prepared selector lease callback invoked repeatedly.")
    invoked = true
    await pinned.lease()
    if (!unchanged()) throw new Error("Prepared selector identity changed; Manual Recovery required.")
    if (await exists.call(adapter, root) || await exists.call(adapter, path)
      || await exists.call(adapter, roots.selectorPath)) {
      throw new Error("Existing selector preparation or active selector requires Manual Recovery.")
    }
    const observed = await inspectV4BestEffortReencryptionRestartEvidence(restart)
    if (!unchanged() || observed.observation !== "source-with-prepared-intent-uncommitted"
      || observed.localCutoverAuthorized !== false) {
      throw new Error("Prepared selector lacks stable Source intent, indices and WAL; Manual Recovery required.")
    }
    const wal = await walReader.call(pinned.journal, identity.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(wal, identity) || !unchanged()) {
      throw new Error("Prepared selector WAL is stale or missing verified remote objects; Manual Recovery required.")
    }
    const sealed = await sealV4ReencryptionPreparedSelectorEvidence(identity, pinned.key)
    if (!fitsV4LocalJsonSizeLimit(sealed, MAX_PREPARED_BYTES)) {
      throw new Error("Prepared selector evidence exceeds 8 KiB.")
    }
    await pinned.lease()
    if (!unchanged() || await exists.call(adapter, root)
      || await exists.call(adapter, path) || await exists.call(adapter, roots.selectorPath)) {
      throw new Error("Prepared selector changed before first write; Manual Recovery required.")
    }
    await mkdir.call(adapter, root)
    await write.call(adapter, path, sealed)
    await pinned.lease()
    if (!unchanged()) throw new Error("Prepared selector changed after write; Manual Recovery required.")
    const value = await read.call(adapter, path)
    if (value !== sealed || !await authenticateV4ReencryptionPreparedSelectorEvidence(value, identity, pinned.key)) {
      throw new Error("Prepared selector encrypted readback mismatch; Manual Recovery required.")
    }
    const repeated = await inspectV4BestEffortReencryptionRestartEvidence(restart)
    if (repeated.observation !== "source-with-prepared-intent-uncommitted"
      || !unchanged() || await exists.call(adapter, roots.selectorPath)
      || await read.call(adapter, path) !== sealed) {
      throw new Error("Prepared selector evidence changed after WAL readback; Manual Recovery required.")
    }
    return Object.freeze({
      status: "authenticated-prepared-selector-uncommitted" as const,
      evidencePath: path,
      evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
      localCutoverAuthorized: false as const,
      resumeSyncAuthorized: false as const,
      rollbackAuthorized: false as const,
      oldPassphraseCleanupAuthorized: false as const,
    })
  })
    if (!invoked || !unchanged()) {
      throw new Error("Prepared selector lease or identity lost; Manual Recovery required.")
    }
    return report
  } finally {
    claim.delete(root)
    if (claim.size === 0) activePrepared.delete(adapter)
  }
}

export interface V4BestEffortPreparedSelectorRestartReport {
  readonly integrityScope: "read-only-prepared-selector-and-authenticated-wal"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly observation: "authenticated-prepared-selector-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const RESTART_BASE = Object.freeze({
  integrityScope: "read-only-prepared-selector-and-authenticated-wal" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const RESTART_MANUAL: V4BestEffortPreparedSelectorRestartReport =
  Object.freeze({ ...RESTART_BASE, observation: "manual-recovery-required" })
const RESTART_OBSERVED: V4BestEffortPreparedSelectorRestartReport =
  Object.freeze({ ...RESTART_BASE, observation: "authenticated-prepared-selector-uncommitted" })

/**
 * Read-only restart diagnostic: an encrypted prepared record is not an
 * authoritative selector or a commit receipt, even when every proof matches.
 */
export async function inspectV4BestEffortPreparedSelectorAfterRestart(
  input: V4BestEffortPreparedSelectorStageInput,
): Promise<V4BestEffortPreparedSelectorRestartReport> {
  if (!input?.restart || !input.identity) throw new Error("Missing prepared selector restart identity.")
  assertV4ReencryptionProposedCommitIdentity(input.identity)
  const { restart } = input
  if (!exactIdentities(restart, input.identity)
    || restart.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof restart.wal?.assertExclusiveStageLease !== "function"
    || typeof restart.wal.assertBestEffortCheckpoint !== "function"
    || typeof restart.journal?.assertHealthySnapshot !== "function"
    || typeof restart.indexAdapter?.read !== "function"
    || typeof restart.indexAdapter.exists !== "function"
    || !(input.journalKey instanceof Uint8Array) || input.journalKey.byteLength !== 32) {
    throw new Error("Prepared selector restart requires exact risk, identity, WAL and storage.")
  }
  const adapter = restart.indexAdapter
  const read = adapter.read
  const exists = adapter.exists
  const holder = input.withExclusiveInitiatorLease
  const journal = restart.journal
  const walRead = journal.assertHealthySnapshot
  const wal = restart.wal
  const walLease = wal.assertExclusiveStageLease
  const walCheck = wal.assertBestEffortCheckpoint
  const lease = restart.assertExclusiveInitiatorLease
  const key = input.journalKey
  const keyBytes = toBase64(key)
  const identity = Object.freeze({ ...input.identity })
  const settings = JSON.stringify(restart.settings)
  const expected = JSON.stringify(restart.expected)
  const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
  const path = roots.selectorPath.replace(/selector\.json$/u, "prepared.json")
  const unchanged = () => input.restart === restart && input.withExclusiveInitiatorLease === holder
    && input.journalKey === key && toBase64(key) === keyBytes
    && JSON.stringify(input.identity) === JSON.stringify(identity)
    && JSON.stringify(restart.settings) === settings
    && JSON.stringify(restart.expected) === expected
    && restart.indexAdapter === adapter && adapter.read === read && adapter.exists === exists
    && restart.journal === journal && journal.assertHealthySnapshot === walRead
    && restart.wal === wal && wal.assertExclusiveStageLease === walLease
    && wal.assertBestEffortCheckpoint === walCheck
    && restart.assertExclusiveInitiatorLease === lease
    && exactIdentities(restart, identity)

  let invoked = false
  const result = await holder(async () => {
    if (invoked) throw new Error("Prepared selector restart body invoked repeatedly.")
    invoked = true
    try {
      await lease()
      if (!unchanged() || await exists.call(adapter, roots.selectorPath)
        || !await exists.call(adapter, path)) return RESTART_MANUAL
      const first = await read.call(adapter, path)
      if (!fitsV4LocalJsonSizeLimit(first, MAX_PREPARED_BYTES)
        || !await authenticateV4ReencryptionPreparedSelectorEvidence(first, identity, key)
        || !unchanged()) return RESTART_MANUAL
      const inspection = await inspectV4BestEffortReencryptionRestartEvidence(restart)
      if (inspection.observation !== "source-with-prepared-intent-uncommitted"
        || !unchanged()) return RESTART_MANUAL
      const firstWal = await walRead.call(journal, identity.walGeneration)
      if (!matchesV4ReencryptionPreparedWal(firstWal, identity) || !unchanged()) return RESTART_MANUAL
      await lease()
      if (!unchanged() || await exists.call(adapter, roots.selectorPath)) return RESTART_MANUAL
      const second = await read.call(adapter, path)
      if (second !== first || !await authenticateV4ReencryptionPreparedSelectorEvidence(second, identity, key)
        || !unchanged()) return RESTART_MANUAL
      const secondInspection = await inspectV4BestEffortReencryptionRestartEvidence(restart)
      const secondWal = await walRead.call(journal, identity.walGeneration)
      if (secondInspection.observation !== "source-with-prepared-intent-uncommitted"
        || JSON.stringify(secondWal) !== JSON.stringify(firstWal)
        || !matchesV4ReencryptionPreparedWal(secondWal, identity)
        || !unchanged()) return RESTART_MANUAL
      return RESTART_OBSERVED
    } catch {
      return RESTART_MANUAL
    }
  })
  return invoked && unchanged() && result === RESTART_OBSERVED ? RESTART_OBSERVED : RESTART_MANUAL
}
