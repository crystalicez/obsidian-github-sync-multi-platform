import { sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { loadV4LocalIndex } from "./local-index"
import {
  inspectV4FencedPrecommitReadinessAfterRestart,
  type V4FencedPrecommitReadinessInput,
} from "./reencryption-fenced-precommit-readiness"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  inspectV4ReencryptionCommitPairTestVectors,
  type V4ReencryptionCommitPairTestContract,
  type V4ReencryptionCommitPairTestVectors,
} from "./reencryption-commit-pair-test-vectors"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { authenticateV4ReencryptionPreparedSelectorEvidence } from "./reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const TX = /^[0-9a-f]{32}$/u
const RISK = "accept-best-effort-power-loss-recovery-risk"
const PREPARED_MAX = 8 * 1024

export interface V4FencedCommitPairSnapshotInput {
  readonly readiness: V4FencedPrecommitReadinessInput
  /** Externally generated per-attempt 128-bit ID; never inferred from Settings. */
  readonly transactionId: string
}

export interface V4FencedCommitPairSnapshotReport {
  readonly integrityScope: "read-only-fenced-d179-verified-commit-pair-snapshot-contract"
  readonly observation: "snapshot-contract-derived-uncommitted"
    | "snapshot-bound-pair-authenticated-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  /** Never an independently durable or authoritative commit receipt. */
  readonly contract: V4ReencryptionCommitPairTestContract | null
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-fenced-d179-verified-commit-pair-snapshot-contract" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4FencedCommitPairSnapshotReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required", contract: null,
})

async function digest(value: string): Promise<string> {
  return sha256Hex(utf8ToBytes(value))
}

/**
 * Internal D183 gate. Calls D179 at BOTH ends of a full provenance read,
 * under ONE outer held cooperative initiator lease (borrowed, not reacquired).
 * Every digest is computed from locally re-read data, not caller claims.
 *
 * Crucially this is still a read-only snapshot / cryptographic test-vector
 * check, not a persisted or physically crash-durable committing protocol.
 */
async function observe(
  input: V4FencedCommitPairSnapshotInput,
  expected: V4ReencryptionCommitPairTestContract | null,
  pair: V4ReencryptionCommitPairTestVectors | null,
): Promise<V4FencedCommitPairSnapshotReport> {
  const readiness = input?.readiness
  const prepared = readiness?.prepared
  const restart = prepared?.restart
  const branches = readiness?.full?.branches
  const shadow = readiness?.full?.shadow
  const id = branches?.identity
  if (!restart || !branches || !shadow || !id || !prepared || !readiness.candidate
    || typeof input.transactionId !== "string" || !TX.test(input.transactionId)
    || /^0+$/u.test(input.transactionId)
    || (expected === null) !== (pair === null)) return MANUAL

  const holder = branches.withExclusiveInitiatorLease
  const lease = branches.assertExclusiveInitiatorLease
  const adapter = restart.indexAdapter
  const wal = branches.wal
  const journal = branches.journal
  const key = prepared.journalKey
  const getSecret = restart.getSecret
  if (prepared.withExclusiveInitiatorLease !== holder
    || branches.acknowledgement !== RISK || restart.acknowledgement !== RISK
    || branches.adapter !== adapter || shadow.adapter !== adapter
    || restart.journal !== journal || restart.wal !== wal
    || restart.assertExclusiveInitiatorLease !== lease
    || shadow.assertExclusiveInitiatorLease !== lease
    || !key || !(key instanceof Uint8Array) || key.length !== 32
    || !getSecret(id.sourcePassphraseSecretId) || !getSecret(id.destinationPassphraseSecretId)
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof adapter.read !== "function" || typeof adapter.exists !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function") return MANUAL

  const originalTransactionId = input.transactionId
  const originalFull = readiness.full
  const originalShadow = shadow
  const originalReaders = branches.readers
  const originalPublished = branches.publication
  const pinnedReaders = (["source", "backup", "destination"] as const).map(role => {
    const reader = originalReaders[role]
    return {
      role, reader, branch: reader.branchName,
      repo: reader.getRepositoryIdentity,
      defaultBranch: reader.getRepositoryDefaultBranch,
      ref: reader.getGitRefOrNull,
      commit: reader.getGitCommit,
    }
  })
  const github = shadow.remote.github
  const githubMethods = {
    repo: github.getRepositoryIdentity, ref: github.getGitRef,
    commit: github.getGitCommit, tree: github.getTreeAt, blob: github.getBlob,
  }
  const originalRemote = shadow.remote
  const remoteScope = () => JSON.stringify({
    publication: branches.publication, physicalRepositoryId: branches.physicalRepositoryId,
    expected: restart.expected, preparedId: prepared.identity,
    remote: {
      plan: originalRemote.plan, sourceConfig: originalRemote.sourceConfig,
      destinationConfig: originalRemote.expectedDestinationConfig,
      receipts: originalRemote.expectedReceipts,
      sourceTreeSha: originalRemote.sourceTreeSha,
      destinationCommitSha: originalRemote.destinationCommitSha,
      destinationPassphrase: originalRemote.destinationPassphrase,
    },
  })
  const originalRemoteScope = remoteScope()
  const originalIdentity = JSON.stringify(id)
  const originalSettings = JSON.stringify(restart.settings)
  const originalPreparedId = JSON.stringify(prepared.identity)
  const originalCandidate = JSON.stringify(readiness.candidate)
  const originalKey = toBase64(key)
  const sourceSecret = getSecret(id.sourcePassphraseSecretId)
  const destinationSecret = getSecret(id.destinationPassphraseSecretId)
  const originalPair = pair
  const originalExpected = expected
  const initialPair = pair === null ? "" : JSON.stringify(pair)
  const initialExpected = expected === null ? "" : JSON.stringify(expected)
  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const preparedPath = roots.selectorPath.slice(0, -"/selector.json".length) + "/prepared.json"
  const proposedRoot = id.indexRoot + "-rekey-proposed-" + id.runId
  const destinationBranch = id.destinationRepoId.split("#")[1]
  if (!destinationBranch) return MANUAL
  const methods = {
    read: adapter.read, exists: adapter.exists, stat: adapter.stat,
    walRead: journal.assertHealthySnapshot,
    walLease: wal.assertExclusiveStageLease, checkpoint: wal.assertBestEffortCheckpoint,
  }
  const sourceSettings = JSON.parse(originalSettings) as typeof restart.settings
  const destinationSettings = {
    ...sourceSettings,
    githubBranch: destinationBranch,
    encryptionPassphraseSecretId: id.destinationPassphraseSecretId,
  }
  const originalTarget = JSON.stringify(destinationSettings)

  const unchanged = () =>
    input.readiness === readiness && input.transactionId === originalTransactionId
    && readiness.full === originalFull
    && readiness.full.branches === branches && readiness.full.shadow === shadow
    && shadow === originalShadow && shadow.remote === originalRemote
    && branches.readers === originalReaders && branches.publication === originalPublished
    && pinnedReaders.every(r => {
      const current = originalReaders[r.role]
      return current === r.reader && current.branchName === r.branch
        && current.getRepositoryIdentity === r.repo
        && current.getRepositoryDefaultBranch === r.defaultBranch
        && current.getGitRefOrNull === r.ref && current.getGitCommit === r.commit
    })
    && originalRemote.github === github
    && github.getRepositoryIdentity === githubMethods.repo
    && github.getGitRef === githubMethods.ref
    && github.getGitCommit === githubMethods.commit
    && github.getTreeAt === githubMethods.tree && github.getBlob === githubMethods.blob
    && remoteScope() === originalRemoteScope
    && readiness.prepared === prepared && prepared.restart === restart
    && branches.identity === id && JSON.stringify(id) === originalIdentity
    && JSON.stringify(prepared.identity) === originalPreparedId
    && JSON.stringify(readiness.candidate) === originalCandidate
    && JSON.stringify(restart.settings) === originalSettings
    && JSON.stringify(destinationSettings) === originalTarget
    && prepared.journalKey === key && toBase64(key) === originalKey
    && branches.withExclusiveInitiatorLease === holder
    && prepared.withExclusiveInitiatorLease === holder
    && branches.assertExclusiveInitiatorLease === lease
    && shadow.assertExclusiveInitiatorLease === lease
    && restart.assertExclusiveInitiatorLease === lease
    && restart.indexAdapter === adapter && branches.adapter === adapter
    && shadow.adapter === adapter
    && branches.journal === journal && restart.journal === journal
    && branches.wal === wal && restart.wal === wal
    && adapter.read === methods.read && adapter.exists === methods.exists
    && adapter.stat === methods.stat
    && journal.assertHealthySnapshot === methods.walRead
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && restart.getSecret === getSecret
    && getSecret(id.sourcePassphraseSecretId) === sourceSecret
    && getSecret(id.destinationPassphraseSecretId) === destinationSecret
    && pair === originalPair && expected === originalExpected
    && (pair === null || JSON.stringify(pair) === initialPair)
    && (expected === null || JSON.stringify(expected) === initialExpected)

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D183 migration snapshot identity changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D183 encrypted WAL checkpoint uncertain.")
  }
  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D183 nested borrowed lease.")
    borrowedActive = true
    try {
      await assertHeld()
      const result = await body()
      await assertHeld()
      return result
    } finally { borrowedActive = false }
  }
  const fence = () => assertV4ReencryptionExactSyncFence(adapter, {
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
  }, assertHeld)
  const assertNoCommitResidue = async () => {
    await assertHeld()
    if (await adapter.exists(roots.selectorPath) !== false
      || await adapter.exists(proposedRoot) !== false
      || await adapter.exists(proposedRoot + "/marker.json") !== false) {
      throw Error("D183 refuses already written Selector/Commit residue.")
    }
  }
  const snapshot = async () => {
    await assertHeld()
    await fence()
    await assertNoCommitResidue()
    const source = JSON.stringify(await loadV4LocalIndex(adapter, id.indexRoot))
    const destination = JSON.stringify(await loadV4LocalIndex(
      adapter, id.indexRoot + "-rekey-" + id.runId))
    if (await adapter.exists(preparedPath) !== true) {
      throw Error("D183 prepared selector evidence missing.")
    }
    const stat = await methods.stat?.call(adapter, preparedPath)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > PREPARED_MAX)) throw Error("D183 prepared evidence oversized.")
    const evidence = await methods.read.call(adapter, preparedPath)
    if (typeof evidence !== "string" || evidence.length > PREPARED_MAX
      || !await authenticateV4ReencryptionPreparedSelectorEvidence(
        evidence, id, key,
      )) throw Error("D183 prepared evidence not authenticated.")
    const walSnapshot = JSON.stringify(await methods.walRead.call(journal, id.walGeneration))
    if (!matchesV4ReencryptionPreparedWal(
      JSON.parse(walSnapshot) as Awaited<ReturnType<typeof methods.walRead>>, id,
    )) throw Error("D183 authenticated WAL mismatch.")
    await fence()
    await assertNoCommitResidue()
    await assertHeld()
    return { source, destination, evidence, walSnapshot }
  }
  const verifyD179 = async () => {
    await assertHeld()
    const report = await inspectV4FencedPrecommitReadinessAfterRestart({
      ...readiness,
      prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
      full: {
        ...readiness.full,
        branches: { ...branches, withExclusiveInitiatorLease: borrowed },
      },
    })
    if (report.observation !== "all-prepared-surfaces-coherent-uncommitted"
      || !report.completeDestinationContentReverified
      || report.localCutoverAuthorized !== false || report.resumeSyncAuthorized !== false
      || !unchanged()) throw Error("D183 Source, prepared evidence or remote Git proof failed.")
  }

  let invoked = 0
  let callbackReport: V4FencedCommitPairSnapshotReport | null = null
  try {
    const holderReport = await holder(async () => {
      invoked++
      if (invoked !== 1) throw Error("D183 holder executed more than once.")
      await fence()
      const before = await snapshot()
      await verifyD179()
      const middle = await snapshot()
      if (JSON.stringify(before) !== JSON.stringify(middle)) {
        throw Error("D183 Source, Shadow or WAL changed across D179.")
      }
      const contract: V4ReencryptionCommitPairTestContract = Object.freeze({
        transactionId: input.transactionId,
        identity: Object.freeze({ ...id }),
        sourceIndexSha256: await digest(before.source),
        destinationShadowSha256: await digest(before.destination),
        preparedEvidenceSha256: await digest(before.evidence),
        walSnapshotSha256: await digest(before.walSnapshot),
        sourceSettingsSha256: await digest(originalSettings),
        destinationSettingsSha256: await digest(originalTarget),
      })
      if (!unchanged()) throw Error("D183 contract identity changed after hashing.")
      let status: "snapshot-contract-derived-uncommitted"
        | "snapshot-bound-pair-authenticated-uncommitted" = "snapshot-contract-derived-uncommitted"
      if (expected !== null && pair !== null) {
        if (JSON.stringify(contract) !== JSON.stringify(expected)) {
          throw Error("D183 supplied contract differs from independently read snapshots.")
        }
        const proof = await inspectV4ReencryptionCommitPairTestVectors(contract, key, pair)
        if (proof.observation !== "both-test-vectors-authenticate-uncommitted"
          || proof.localCutoverAuthorized !== false || !unchanged()) {
          throw Error("D183 cryptographic pair and derived contract disagree.")
        }
        status = "snapshot-bound-pair-authenticated-uncommitted"
      }
      await verifyD179()
      const after = await snapshot()
      if (JSON.stringify(before) !== JSON.stringify(after)
        || !unchanged()) throw Error("D183 final storage snapshot drift.")
      await fence()
      callbackReport = Object.freeze({ ...BASE, observation: status, contract })
      return callbackReport
    })
    return invoked === 1 && callbackReport === holderReport && unchanged()
      ? holderReport : MANUAL
  } catch { return MANUAL }
}

/**
 * Derive digests ONLY from full D179-verified reads. No fake committed record,
 * no persistence, no decisions about old key retention or automatic repair.
 */
export async function deriveV4FencedCommitPairSnapshotTestContract(
  input: V4FencedCommitPairSnapshotInput,
): Promise<V4FencedCommitPairSnapshotReport> {
  return observe(input, null, null)
}

/**
 * Recompute ALL digests with fresh D179 full Git/Source proof before accepting
 * a D182 in-memory pair. Matching remains explicitly UNCOMMITTED.
 */
export async function inspectV4FencedCommitPairSnapshotTestVectors(
  input: V4FencedCommitPairSnapshotInput,
  contract: V4ReencryptionCommitPairTestContract,
  pair: V4ReencryptionCommitPairTestVectors,
): Promise<V4FencedCommitPairSnapshotReport> {
  return observe(input, contract, pair)
}
