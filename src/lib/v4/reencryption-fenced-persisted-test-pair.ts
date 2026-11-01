import { toBase64 } from "../bytes"
import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  deriveV4FencedCommitPairSnapshotTestContract,
  inspectV4FencedCommitPairSnapshotTestVectors,
  type V4FencedCommitPairSnapshotInput,
} from "./reencryption-fenced-commit-pair-snapshot-provenance"
import {
  inspectV4ReencryptionCommitPairTestVectors,
  sealV4ReencryptionCommitPairTestVectors,
} from "./reencryption-commit-pair-test-vectors"
import { inspectV4FencedCrashWindowPairAfterRestart } from "./reencryption-fenced-crash-window-pair-inspection"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"
import type { V4LocalIndexAdapter } from "./local-index"

const MAX_RECORD_BYTES = 8 * 1024
const RISK = "accept-best-effort-power-loss-recovery-risk"
const active = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4FencedCommitPairTestArtifactStageReport {
  readonly status: "linked-persistent-test-artifacts-uncommitted"
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
 * D219: exercise real, ordered *disk* crash windows for D182's NON-authorizing
 * test pair. Not a production commit transaction. Never selects Destination,
 * changes Settings or keys, clears Sync Fence, or grants any write authority.
 * Partial artifacts are deliberately retained and block retries until Manual
 * Recovery. The trusted caller must own an exclusive cooperating WAL lease.
 */
export async function stageV4FencedCommitPairTestArtifacts(
  input: V4FencedCommitPairSnapshotInput,
): Promise<V4FencedCommitPairTestArtifactStageReport> {
  const readiness = input?.readiness
  const prepared = readiness?.prepared
  const restart = prepared?.restart
  const full = readiness?.full
  const branches = full?.branches
  const id = branches?.identity
  const holder = prepared?.withExclusiveInitiatorLease
  const lease = restart?.assertExclusiveInitiatorLease
  const adapter = restart?.indexAdapter
  const wal = restart?.wal
  const journal = restart?.journal
  const key = prepared?.journalKey
  const getSecret = restart?.getSecret
  if (!readiness || !prepared || !restart || !full || !branches || !id
    || !full.shadow || !full.shadow.remote || !full.shadow.remote.github
    || !adapter || !wal || !journal || !key || !(key instanceof Uint8Array)
    || key.byteLength !== 32 || typeof getSecret !== "function"
    || typeof holder !== "function" || typeof lease !== "function"
    || branches.withExclusiveInitiatorLease !== holder
    || branches.assertExclusiveInitiatorLease !== lease
    || restart.acknowledgement !== RISK || branches.acknowledgement !== RISK
    || restart.wal !== branches.wal || restart.journal !== branches.journal
    || restart.indexAdapter !== branches.adapter || adapter !== full.shadow.adapter
    || typeof wal.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal.assertHealthySnapshot !== "function"
    || typeof adapter.mkdir !== "function" || typeof adapter.write !== "function"
    || typeof adapter.exists !== "function" || typeof adapter.read !== "function") {
    throw Error("D219 requires the exact prepared fenced migration and storage lease.")
  }

  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const selectorRoot = roots.selectorPath.slice(0, -"/selector.json".length)
  const receiptRoot = id.indexRoot + "-rekey-proposed-" + id.runId
  const receiptPath = receiptRoot + "/marker.json"
  const checkpoint = wal.assertBestEffortCheckpoint
  const walLease = wal.assertExclusiveStageLease
  const walRead = journal.assertHealthySnapshot
  const read = adapter.read
  const exists = adapter.exists
  const mkdir = adapter.mkdir
  const write = adapter.write
  const stat = adapter.stat
  const sourceSettings = JSON.stringify(restart.settings)
  const originalId = JSON.stringify(id)
  const originalPrepared = JSON.stringify(prepared.identity)
  const originalShadow = full.shadow
  const originalRemote = originalShadow.remote
  const initialRemoteScope = JSON.stringify({
    remote: {
      plan: originalRemote.plan,
      sourceConfig: originalRemote.sourceConfig,
      destinationConfig: originalRemote.expectedDestinationConfig,
      receipts: originalRemote.expectedReceipts,
      sourceTree: originalRemote.sourceTreeSha,
      destinationCommit: originalRemote.destinationCommitSha,
      destinationPassphrase: originalRemote.destinationPassphrase,
      signal: originalRemote.signal ? "provided" : "absent",
    },
    expected: restart.expected,
    runId: restart.runId,
    indexRoot: restart.indexRoot,
    sourceCommit: restart.sourceCommitSha,
    backupRepoId: restart.backupRepoId,
    walGeneration: restart.expectedWalGeneration,
  })
  const originalReadiness = JSON.stringify({
    publication: branches.publication, candidate: readiness.candidate,
    tx: input.transactionId,
  })
  const originalKey = toBase64(key)
  const oldSecret = getSecret(id.sourcePassphraseSecretId)
  const newSecret = getSecret(id.destinationPassphraseSecretId)
  const readers = branches.readers
  const methods = (["source", "backup", "destination"] as const).map(role => {
    const reader = readers[role]
    return { role, reader, repo: reader.getRepositoryIdentity,
      def: reader.getRepositoryDefaultBranch,
      ref: reader.getGitRefOrNull, commit: reader.getGitCommit,
      branch: reader.branchName }
  })
  const gh = full.shadow.remote.github
  const originalSignal = full.shadow.remote.signal
  const githubMethods = {
    repo: gh.getRepositoryIdentity, ref: gh.getGitRef,
    commit: gh.getGitCommit, tree: gh.getTreeAt, blob: gh.getBlob,
  }
  const unchanged = () => input.readiness === readiness
    && readiness.prepared === prepared && readiness.full === full
    && prepared.restart === restart
    && full.branches === branches && full.shadow === originalShadow
    && originalShadow.remote === originalRemote
    && originalRemote.github === gh
    && originalRemote.signal === originalSignal
    && originalSignal?.aborted !== true
    && JSON.stringify({
      remote: {
        plan: originalRemote.plan,
        sourceConfig: originalRemote.sourceConfig,
        destinationConfig: originalRemote.expectedDestinationConfig,
        receipts: originalRemote.expectedReceipts,
        sourceTree: originalRemote.sourceTreeSha,
        destinationCommit: originalRemote.destinationCommitSha,
        destinationPassphrase: originalRemote.destinationPassphrase,
        signal: originalRemote.signal ? "provided" : "absent",
      },
      expected: restart.expected,
      runId: restart.runId,
      indexRoot: restart.indexRoot,
      sourceCommit: restart.sourceCommitSha,
      backupRepoId: restart.backupRepoId,
      walGeneration: restart.expectedWalGeneration,
    }) === initialRemoteScope
    && branches.withExclusiveInitiatorLease === holder
    && prepared.withExclusiveInitiatorLease === holder
    && restart.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && full.shadow.assertExclusiveInitiatorLease === lease
    && branches.identity === id && JSON.stringify(id) === originalId
    && JSON.stringify(prepared.identity) === originalPrepared
    && JSON.stringify({
      publication: branches.publication, candidate: readiness.candidate,
      tx: input.transactionId,
    }) === originalReadiness
    && prepared.journalKey === key && toBase64(key) === originalKey
    && JSON.stringify(restart.settings) === sourceSettings
    && restart.indexAdapter === adapter && branches.adapter === adapter
    && full.shadow.adapter === adapter
    && restart.wal === wal && branches.wal === wal
    && restart.journal === journal && branches.journal === journal
    && journal.assertHealthySnapshot === walRead
    && journal.sourceCommitSha === id.sourceCommitSha
    && journal.destinationRepoId === id.destinationRepoId
    && restart.acknowledgement === RISK
    && branches.acknowledgement === RISK
    && wal.assertBestEffortCheckpoint === checkpoint
    && wal.assertExclusiveStageLease === walLease
    && adapter.read === read && adapter.exists === exists
    && adapter.mkdir === mkdir && adapter.write === write && adapter.stat === stat
    && restart.getSecret === getSecret
    && getSecret(id.sourcePassphraseSecretId) === oldSecret
    && getSecret(id.destinationPassphraseSecretId) === newSecret
    && methods.every(m => {
      const reader = readers[m.role]
      return reader === m.reader && reader.branchName === m.branch
        && reader.getRepositoryIdentity === m.repo
        && reader.getRepositoryDefaultBranch === m.def
        && reader.getGitRefOrNull === m.ref && reader.getGitCommit === m.commit
    })
    && gh.getRepositoryIdentity === githubMethods.repo
    && gh.getGitRef === githubMethods.ref
    && gh.getGitCommit === githubMethods.commit
    && gh.getTreeAt === githubMethods.tree && gh.getBlob === githubMethods.blob

  const check = async () => {
    if (originalSignal?.aborted) {
      throw Error("D219 migration cancelled; partial artifacts require Manual Recovery.")
    }
    if (!unchanged()) throw Error("D219 identity or observer changed; Manual Recovery required.")
    await lease()
    await walLease.call(wal)
    if (await checkpoint.call(wal) !== "best-effort-readback-only" || !unchanged()) {
      throw Error("D219 WAL or initiator lease unavailable; Manual Recovery required.")
    }
    const walSnapshot = await walRead.call(journal, id.walGeneration)
    if (!matchesV4ReencryptionPreparedWal(walSnapshot, id) || !unchanged()) {
      throw Error("D219 authenticated WAL no longer matches this run.")
    }
    await assertV4ReencryptionExactSyncFence(adapter, {
      runId: id.runId, sourceRepoId: id.sourceRepoId,
      destinationRepoId: id.destinationRepoId,
    }, lease)
    if (!unchanged()) throw Error("D219 migration fence or state changed.")
  }
  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D219 nested lease borrow.")
    borrowedActive = true
    try {
      await check()
      const result = await body()
      await check()
      return result
    } finally { borrowedActive = false }
  }
  const nestedInput: V4FencedCommitPairSnapshotInput = {
    transactionId: input.transactionId,
    readiness: {
      ...readiness,
      prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
      full: { ...full, branches: { ...branches, withExclusiveInitiatorLease: borrowed } },
    },
  }
  const claimed = active.get(adapter) ?? new Set<string>()
  if (claimed.has(receiptRoot)) {
    throw Error("D219 concurrent test artifact stage requires Manual Recovery.")
  }
  claimed.add(receiptRoot)
  active.set(adapter, claimed)

  let called = 0
  let completed: V4FencedCommitPairTestArtifactStageReport | null = null
  try {
    const returned = await holder(async () => {
      if (++called !== 1) throw Error("D219 exclusive holder invoked repeatedly.")
      await check()
      if (await exists.call(adapter, receiptRoot) || await exists.call(adapter, receiptPath)
        || await exists.call(adapter, roots.selectorPath)
        || await exists.call(adapter, selectorRoot) !== true) {
        throw Error("D219 stale/foreign partial Receipt or Selector requires Manual Recovery.")
      }
      const derived = await deriveV4FencedCommitPairSnapshotTestContract(nestedInput)
      if (derived.observation !== "snapshot-contract-derived-uncommitted"
        || !derived.contract || !unchanged()) {
        throw Error("D219 current Source/Shadow/remote provenance not independently verified.")
      }
      const contract = derived.contract
      const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key)
      const proof = await inspectV4FencedCommitPairSnapshotTestVectors(
        nestedInput, contract, pair,
      )
      if (proof.observation !== "snapshot-bound-pair-authenticated-uncommitted"
        || !unchanged() || proof.localCutoverAuthorized !== false
        || !fitsV4LocalJsonSizeLimit(pair.receiptTestVector, MAX_RECORD_BYTES)
        || !fitsV4LocalJsonSizeLimit(pair.selectorTestVector, MAX_RECORD_BYTES)) {
        throw Error("D219 encrypted test pair does not match current D183 proof.")
      }
      await check()
      if (await exists.call(adapter, receiptRoot) || await exists.call(adapter, receiptPath)
        || await exists.call(adapter, roots.selectorPath)) {
        throw Error("D219 test artifacts already exist; never overwrite.")
      }
      // First persistent boundary: create the proposed Receipt directory.
      await mkdir.call(adapter, receiptRoot)
      await check()
      await write.call(adapter, receiptPath, pair.receiptTestVector)
      await check()
      if (await read.call(adapter, receiptPath) !== pair.receiptTestVector) {
        throw Error("D219 persisted Receipt readback mismatch.")
      }
      // Final persistent boundary: a test-vector Selector only, still NOT
      // authoritative and blocked by the unchanged migration Sync Fence.
      await write.call(adapter, roots.selectorPath, pair.selectorTestVector)
      await check()
      const [receipt, selector] = await Promise.all([
        read.call(adapter, receiptPath), read.call(adapter, roots.selectorPath),
      ])
      if (receipt !== pair.receiptTestVector || selector !== pair.selectorTestVector
        || (await inspectV4ReencryptionCommitPairTestVectors(
          contract, key, { receiptTestVector: receipt, selectorTestVector: selector },
        )).observation !== "both-test-vectors-authenticate-uncommitted") {
        throw Error("D219 persisted pair is torn or cryptographically mismatched.")
      }
      const crash = await inspectV4FencedCrashWindowPairAfterRestart({
        prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
        contract, sourceSettings: JSON.parse(sourceSettings) as typeof restart.settings,
      })
      await check()
      if (crash.artifactWindow !== "pair-present"
        || crash.pairEvidence !== "cryptographically-linked-uncommitted"
        || crash.reason !== "linked-test-pair-not-authoritative"
        || crash.localCutoverAuthorized !== false || crash.resumeSyncAuthorized !== false) {
        throw Error("D219 D184 post-restart observer cannot authenticate persisted pair.")
      }
      completed = Object.freeze({
        status: "linked-persistent-test-artifacts-uncommitted",
        receiptPath, selectorPath: roots.selectorPath,
        evidence: "best-effort-wal-readback-not-power-loss-durable",
        localCutoverAuthorized: false, resumeSyncAuthorized: false,
        rollbackAuthorized: false, remoteWritesAuthorized: false,
        oldPassphraseCleanupAuthorized: false,
      })
      return completed
    })
    if (called !== 1 || completed === null || completed !== returned || !unchanged()) {
      throw Error("D219 staging holder did not preserve a trusted result.")
    }
    return completed
  } finally {
    claimed.delete(receiptRoot)
  }
}
