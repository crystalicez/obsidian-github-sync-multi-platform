import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  inspectV4CutoverActivationDecision, sealV4CutoverActivationDecision,
  type V4CutoverActivationDecisionSources,
} from "./reencryption-activation-decision-crypto"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  inspectV4FencedPendingCommitPreflightAfterRestart,
  type V4FencedPendingCommitPreflightInput,
} from "./reencryption-fenced-pending-commit-preflight"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const MAX = 8 * 1024
const RISK = "accept-best-effort-power-loss-recovery-risk"
const active = new WeakMap<object, Set<string>>()

const BASE = Object.freeze({
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  commitDecisionAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})

export interface V4CutoverActivationDecisionStageReport {
  readonly status: "cutover-activation-decision-staged-not-applied"
  readonly decisionPath: string
  readonly evidence: typeof BASE.evidence
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

export interface V4CutoverActivationDecisionRestartReport {
  readonly integrityScope: "read-only-cutover-activation-decision-after-restart"
  readonly observation: "authenticated-decision-activation-pending" | "manual-recovery-required"
  readonly evidence: typeof BASE.evidence
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const RECORDED: V4CutoverActivationDecisionRestartReport = Object.freeze({
  ...BASE, integrityScope: "read-only-cutover-activation-decision-after-restart",
  observation: "authenticated-decision-activation-pending",
})
const MANUAL: V4CutoverActivationDecisionRestartReport = Object.freeze({
  ...BASE, integrityScope: "read-only-cutover-activation-decision-after-restart",
  observation: "manual-recovery-required",
})

function createFencedSession(input: V4FencedPendingCommitPreflightInput) {
  const readiness = input.readiness
  const prepared = readiness?.prepared
  const full = readiness?.full
  const branches = full?.branches
  const backup = input.backup
  const id = branches?.identity
  const restart = prepared?.restart
  const holder = prepared?.withExclusiveInitiatorLease
  const lease = restart?.assertExclusiveInitiatorLease
  const adapter = restart?.indexAdapter
  const wal = restart?.wal
  const journal = restart?.journal
  const key = prepared?.journalKey
  const getSecret = restart?.getSecret
  const reader = input.readPersistedSettings
  const transactionId = input.transactionId
  if (!prepared || !full || !branches || !backup || !id || !restart
    || !(key instanceof Uint8Array) || key.length !== 32
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof getSecret !== "function" || typeof reader !== "function"
    || typeof adapter?.read !== "function" || typeof adapter.exists !== "function"
    || typeof adapter.write !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || restart.acknowledgement !== RISK || branches.acknowledgement !== RISK
    || JSON.stringify(prepared.identity) !== JSON.stringify(id)
    || JSON.stringify(backup.identity) !== JSON.stringify(id)
    || backup.withExclusiveInitiatorLease !== holder
    || branches.withExclusiveInitiatorLease !== holder
    || backup.assertExclusiveInitiatorLease !== lease
    || branches.assertExclusiveInitiatorLease !== lease
    || full.shadow.assertExclusiveInitiatorLease !== lease
    || backup.adapter !== adapter || branches.adapter !== adapter
    || full.shadow.adapter !== adapter
    || backup.wal !== wal || branches.wal !== wal
    || backup.journal !== journal || branches.journal !== journal
  ) throw Error("D230 does not have a consistent preflight and Owner Lease.")
  planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const root = id.indexRoot + "-rekey-cutover-candidate-" + id.runId
  const decisionPath = root + "/activation-decision.json"
  const paths = [root + "/contract.json", root + "/receipt.json",
    root + "/selector.json", root + "/intent.json"] as const

  const shadow = full.shadow
  const remote = shadow.remote
  const oldBackup = backup.backup
  const oldGithub = oldBackup.github
  const newGithub = remote.github
  const oldSignal = oldBackup.signal
  const newSignal = remote.signal
  const branchReaders = branches.readers
  const methods = {
    branchReaders: (["source", "backup", "destination"] as const).map(role => {
      const client = branchReaders[role]
      return { role, client, branch: client.branchName,
        repo: client.getRepositoryIdentity,
        defaultBranch: client.getRepositoryDefaultBranch,
        ref: client.getGitRefOrNull,
        commit: client.getGitCommit }
    }),
    read: adapter.read, write: adapter.write, exists: adapter.exists, stat: adapter.stat,
    walLease: wal.assertExclusiveStageLease,
    checkpoint: wal.assertBestEffortCheckpoint,
    snapshot: journal.assertHealthySnapshot,
    old: {
      repo: backup.backup.github.getRepositoryIdentity,
      ref: backup.backup.github.getGitRef,
      commit: backup.backup.github.getGitCommit,
      tree: backup.backup.github.getTreeAt,
      blob: backup.backup.github.getBlob,
    },
    newer: {
      repo: full.shadow.remote.github.getRepositoryIdentity,
      ref: full.shadow.remote.github.getGitRef,
      commit: full.shadow.remote.github.getGitCommit,
      tree: full.shadow.remote.github.getTreeAt,
      blob: full.shadow.remote.github.getBlob,
    },
  }
  const serialized = {
    id: JSON.stringify(id), key: toBase64(key),
    settings: JSON.stringify(restart.settings),
    expected: JSON.stringify(restart.expected),
    publication: JSON.stringify(branches.publication),
    candidate: JSON.stringify(readiness.candidate),
    oldPlan: JSON.stringify(backup.backup.plan),
    remotePlan: JSON.stringify({
      plan: full.shadow.remote.plan,
      config: full.shadow.remote.expectedDestinationConfig,
      source: full.shadow.remote.sourceConfig,
      receipts: full.shadow.remote.expectedReceipts,
    }),
  }
  const originalSecret = getSecret(id.sourcePassphraseSecretId)
  const newSecret = getSecret(id.destinationPassphraseSecretId)
  if (!originalSecret || !newSecret) throw Error("D230 needs both passphrases.")

  const unchanged = () => input.readiness === readiness && input.backup === backup
    && input.readPersistedSettings === reader
    && readiness.prepared === prepared && readiness.full === full
    && full.branches === branches && full.shadow === shadow
    && shadow.remote === remote && backup.backup === oldBackup
    && oldBackup.github === oldGithub && remote.github === newGithub
    && oldBackup.signal === oldSignal && remote.signal === newSignal
    && branches.identity === id
    && prepared.restart === restart && prepared.journalKey === key
    && input.transactionId === transactionId
    && JSON.stringify(id) === serialized.id && toBase64(key) === serialized.key
    && JSON.stringify(restart.settings) === serialized.settings
    && JSON.stringify(restart.expected) === serialized.expected
    && JSON.stringify(branches.publication) === serialized.publication
    && JSON.stringify(readiness.candidate) === serialized.candidate
    && JSON.stringify(backup.backup.plan) === serialized.oldPlan
    && JSON.stringify({
      plan: full.shadow.remote.plan,
      config: full.shadow.remote.expectedDestinationConfig,
      source: full.shadow.remote.sourceConfig,
      receipts: full.shadow.remote.expectedReceipts,
    }) === serialized.remotePlan
    && JSON.stringify(prepared.identity) === serialized.id
    && JSON.stringify(backup.identity) === serialized.id
    && prepared.withExclusiveInitiatorLease === holder
    && backup.withExclusiveInitiatorLease === holder
    && branches.withExclusiveInitiatorLease === holder
    && backup.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && full.shadow.assertExclusiveInitiatorLease === lease
    && restart.assertExclusiveInitiatorLease === lease
    && restart.indexAdapter === adapter && backup.adapter === adapter
    && branches.adapter === adapter && full.shadow.adapter === adapter
    && restart.wal === wal && backup.wal === wal && branches.wal === wal
    && restart.journal === journal && backup.journal === journal && branches.journal === journal
    && restart.getSecret === getSecret
    && getSecret(id.sourcePassphraseSecretId) === originalSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret
    && backup.backup.passphrase === originalSecret
    && full.shadow.remote.destinationPassphrase === newSecret
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && adapter.read === methods.read && adapter.write === methods.write
    && adapter.exists === methods.exists && adapter.stat === methods.stat
    && wal.assertExclusiveStageLease === methods.walLease
    && wal.assertBestEffortCheckpoint === methods.checkpoint
    && journal.assertHealthySnapshot === methods.snapshot
    && branches.readers === branchReaders
    && methods.branchReaders.every(m => {
      const r = branchReaders[m.role]
      return r === m.client && r.branchName === m.branch
        && r.getRepositoryIdentity === m.repo
        && r.getRepositoryDefaultBranch === m.defaultBranch
        && r.getGitRefOrNull === m.ref && r.getGitCommit === m.commit
    })
    && backup.backup.github.getRepositoryIdentity === methods.old.repo
    && backup.backup.github.getGitRef === methods.old.ref
    && backup.backup.github.getGitCommit === methods.old.commit
    && backup.backup.github.getTreeAt === methods.old.tree
    && backup.backup.github.getBlob === methods.old.blob
    && full.shadow.remote.github.getRepositoryIdentity === methods.newer.repo
    && full.shadow.remote.github.getGitRef === methods.newer.ref
    && full.shadow.remote.github.getGitCommit === methods.newer.commit
    && full.shadow.remote.github.getTreeAt === methods.newer.tree
    && full.shadow.remote.github.getBlob === methods.newer.blob
    && backup.backup.signal?.aborted !== true
    && full.shadow.remote.signal?.aborted !== true

  async function check() {
    if (!unchanged()) throw Error("D230 live scope/Settings/Secrets or readers changed.")
    await lease()
    await methods.walLease.call(wal)
    if (await methods.checkpoint.call(wal) !== "best-effort-readback-only"
      || !matchesV4ReencryptionPreparedWal(
        await methods.snapshot.call(journal, id.walGeneration), id,
      ) || !unchanged()) throw Error("D230 WAL lease or generation lost.")
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D230 physical Sync Fence changed.")
  }
  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D230 cannot reacquire an inner owner lease.")
    borrowedActive = true
    try {
      await check()
      const result = await body()
      await check()
      return result
    } finally { borrowedActive = false }
  }
  const borrowedPreflight: V4FencedPendingCommitPreflightInput = {
    ...input,
    readiness: {
      ...readiness,
      prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
      full: { ...full, branches: { ...branches, withExclusiveInitiatorLease: borrowed } },
    },
    backup: { ...backup, withExclusiveInitiatorLease: borrowed },
  }
  const prove = async () => {
    await check()
    const report = await inspectV4FencedPendingCommitPreflightAfterRestart(borrowedPreflight)
    if (report.observation !== "full-live-commit-preflight-uncommitted"
      || !report.oldBackupContentReverified || !report.newDestinationContentReverified) {
      throw Error("D230 complete fresh Git and persisted local proof failed.")
    }
    await check()
  }
  const readOne = async (path: string) => {
    if (!await methods.exists.call(adapter, path)) throw Error("D230 required artifact missing.")
    const stat = await methods.stat?.call(adapter, path)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0
      || stat.size > MAX)) throw Error("D230 artifact exceeds byte limit.")
    const value = await methods.read.call(adapter, path)
    if (!fitsV4LocalJsonSizeLimit(value, MAX) || !value) {
      throw Error("D230 required artifact malformed or oversized.")
    }
    return value
  }
  async function readSources(): Promise<{
    contract: ReturnType<typeof decodeV4ReencryptionCutoverCandidateManifest>
    sources: V4CutoverActivationDecisionSources
  }> {
    await check()
    const [manifest, receiptCiphertext, selectorCiphertext, intentCiphertext] =
      await Promise.all([readOne(paths[0]), readOne(paths[1]),
        readOne(paths[2]), readOne(paths[3])])
    const contract = decodeV4ReencryptionCutoverCandidateManifest(manifest)
    if (contract.transactionId !== transactionId
      || JSON.stringify(contract.identity) !== serialized.id) {
      throw Error("D230 stored Candidate belongs to another transaction.")
    }
    await check()
    return { contract, sources: { manifest, receiptCiphertext,
      selectorCiphertext, intentCiphertext } }
  }
  const readAuthenticated = async () => {
    const local = await readSources()
    const ciphertext = await readOne(decisionPath)
    if ((await inspectV4CutoverActivationDecision(
      local.contract, key, local.sources, ciphertext,
    )).observation !== "authenticated-decision-activation-pending") {
      throw Error("D230 persisted activation decision failed independent authentication.")
    }
    await check()
    return { ...local, ciphertext }
  }
  return { root, decisionPath, key, holder, check, unchanged, prove,
    readOne, readSources, readAuthenticated, adapter, methods }
}

/**
 * D230 stores the first independent encrypted *decision* after current full
 * old Backup/new Destination and D228 persisted local proof. It does not
 * mutate the active runtime, permit Sync or represent an applied Cutover.
 */
export async function stageV4FencedCutoverActivationDecision(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4CutoverActivationDecisionStageReport> {
  const session = createFencedSession(input)
  const { root, decisionPath, adapter, holder, methods } = session
  const claimed = active.get(adapter) ?? new Set<string>()
  if (claimed.has(root)) throw Error("D230 concurrent decision staging requires Manual Recovery.")
  claimed.add(root)
  active.set(adapter, claimed)
  let calls = 0
  let completed: V4CutoverActivationDecisionStageReport | null = null
  try {
    const result = await holder(async () => {
      if (++calls !== 1) throw Error("D230 owner holder executed repeatedly.")
      await session.check()
      if (!await methods.exists.call(adapter, root)
        || await methods.exists.call(adapter, decisionPath)) {
        throw Error("D230 missing Intent or prior decision requires Manual Recovery.")
      }
      await session.prove()
      const before = await session.readSources()
      const sealed = await sealV4CutoverActivationDecision(
        before.contract, session.key, before.sources,
      )
      await session.check()
      if (await methods.exists.call(adapter, decisionPath)
        || JSON.stringify(await session.readSources()) !== JSON.stringify(before)) {
        throw Error("D230 decision preconditions drifted before write.")
      }
      await methods.write.call(adapter, decisionPath, sealed)
      await session.check()
      const persisted = await session.readAuthenticated()
      if (persisted.ciphertext !== sealed
        || JSON.stringify({ contract: persisted.contract, sources: persisted.sources })
          !== JSON.stringify(before)) throw Error("D230 ambiguous decision readback.")
      // A second full Git and local proof catches a remote ref moving during the write.
      await session.prove()
      const final = await session.readAuthenticated()
      if (JSON.stringify(final) !== JSON.stringify(persisted)
        || !session.unchanged()) throw Error("D230 decision changed after final Git proof.")
      await session.check()
      completed = Object.freeze({
        ...BASE, status: "cutover-activation-decision-staged-not-applied",
        decisionPath,
      })
      return completed
    })
    if (calls !== 1 || !completed || result !== completed || !session.unchanged()) {
      throw Error("D230 uncooperative Owner Lease holder cannot certify a decision.")
    }
    return completed
  } finally {
    claimed.delete(root)
    if (claimed.size === 0) active.delete(adapter)
  }
}

/**
 * Independently read the decision after Restart. Still no Sync authorization:
 * a valid record is only a pending activation, not a switched active Index.
 */
export async function inspectV4FencedCutoverActivationDecisionAfterRestart(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4CutoverActivationDecisionRestartReport> {
  let session: ReturnType<typeof createFencedSession>
  try { session = createFencedSession(input) } catch { return MANUAL }
  let calls = 0
  let completed: V4CutoverActivationDecisionRestartReport | null = null
  try {
    const result = await session.holder(async () => {
      if (++calls !== 1) throw Error("D230 restart Owner Lease holder executed repeatedly.")
      await session.check()
      const first = await session.readAuthenticated()
      await session.prove()
      const second = await session.readAuthenticated()
      if (JSON.stringify(second) !== JSON.stringify(first)) {
        throw Error("D230 decision changed across full Git proof after Restart.")
      }
      await session.check()
      if (await session.readOne(session.decisionPath) !== first.ciphertext) {
        throw Error("D230 final decision readback changed after proof.")
      }
      await session.check()
      completed = RECORDED
      return completed
    })
    return calls === 1 && completed === RECORDED && result === RECORDED
      && session.unchanged() ? RECORDED : MANUAL
  } catch { return MANUAL }
}
