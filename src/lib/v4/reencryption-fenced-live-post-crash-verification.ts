import { toBase64 } from "../bytes"
import {
  inspectV4FencedCrashWindowPairAfterRestart,
  type V4FencedCrashWindowPairInput,
  type V4FencedCrashWindowPairReport,
} from "./reencryption-fenced-crash-window-pair-inspection"
import {
  inspectV4FencedFullRemoteShadowAfterRestart,
  type V4FencedFullRemoteShadowInput,
} from "./reencryption-fenced-full-shadow-verification"

const RISK = "accept-best-effort-power-loss-recovery-risk" as const
const ROLES = ["source", "backup", "destination"] as const

/**
 * D185: an isolated diagnostic, NEVER an authoritative Commit reader.
 * A full current Git proof is required in addition to historical D183
 * provenance and D184 local post-crash evidence. No writes are possible.
 */
export interface V4FencedLivePostCrashInput {
  readonly local: V4FencedCrashWindowPairInput
  readonly remote: V4FencedFullRemoteShadowInput
}

export interface V4FencedLivePostCrashReport {
  readonly integrityScope: "read-only-post-crash-local-pair-and-current-complete-git"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly observation:
    | "source-prepared-and-git-reverified-uncommitted"
    | "crash-window-git-reverified-manual-recovery"
    | "manual-recovery-required"
  readonly reason:
    | "source-and-git-coherent-but-uncommitted"
    | "local-crash-window-still-requires-manual-recovery"
    | "local-or-live-git-proof-uncertain"
  readonly local: V4FencedCrashWindowPairReport | null
  readonly fullDestinationContentReverifiedAfterRestart: boolean
  readonly liveThreeBranchRefsReverifiedAfterRestart: boolean
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-post-crash-local-pair-and-current-complete-git" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const UNCERTAIN: V4FencedLivePostCrashReport = Object.freeze({
  ...BASE,
  observation: "manual-recovery-required",
  reason: "local-or-live-git-proof-uncertain",
  local: null,
  fullDestinationContentReverifiedAfterRestart: false,
  liveThreeBranchRefsReverifiedAfterRestart: false,
})
function report(local: V4FencedCrashWindowPairReport): V4FencedLivePostCrashReport {
  const source = local.observation === "source-prepared-uncommitted"
    && local.artifactWindow === "absent"
  return Object.freeze({
    ...BASE,
    observation: source
      ? "source-prepared-and-git-reverified-uncommitted" as const
      : "crash-window-git-reverified-manual-recovery" as const,
    reason: source
      ? "source-and-git-coherent-but-uncommitted" as const
      : "local-crash-window-still-requires-manual-recovery" as const,
    local,
    fullDestinationContentReverifiedAfterRestart: true,
    liveThreeBranchRefsReverifiedAfterRestart: true,
  })
}

/**
 * Bracket D184's disk/Settings/SecretStorage observation with TWO independent
 * D178 complete Git scans. The outer cooperating lease remains held; all
 * nested invocations borrow the caller's lease and cannot acquire another.
 *
 * A complete and authenticated pair, or a fully destination-looking local
 * state, is still MANUAL ONLY. Physical crash durability and noncooperating
 * Git writers are NOT established by this readback.
 */
export async function inspectV4FencedLivePostCrashAfterRestart(
  input: V4FencedLivePostCrashInput,
): Promise<V4FencedLivePostCrashReport> {
  const local = input?.local
  const remote = input?.remote
  const prepared = local?.prepared
  const restart = prepared?.restart
  const branches = remote?.branches
  const shadow = remote?.shadow
  const contract = local?.contract
  const id = contract?.identity
  if (!restart || !branches || !shadow || !contract || !id || !prepared) return UNCERTAIN

  const holder = prepared.withExclusiveInitiatorLease
  const lease = restart.assertExclusiveInitiatorLease
  const adapter = restart.indexAdapter
  const wal = restart.wal
  const journal = restart.journal
  const getSecret = restart.getSecret
  const key = prepared.journalKey
  const gh = shadow.remote?.github
  const readers = branches.readers
  if (typeof holder !== "function" || typeof lease !== "function"
    || typeof getSecret !== "function"
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || !(key instanceof Uint8Array) || key.byteLength !== 32
    || prepared.withExclusiveInitiatorLease !== branches.withExclusiveInitiatorLease
    || lease !== branches.assertExclusiveInitiatorLease
    || lease !== shadow.assertExclusiveInitiatorLease
    || adapter !== branches.adapter || adapter !== shadow.adapter
    || wal !== branches.wal || journal !== branches.journal
    || restart.acknowledgement !== RISK || branches.acknowledgement !== RISK
    || JSON.stringify(id) !== JSON.stringify(branches.identity)
    || JSON.stringify(id) !== JSON.stringify(prepared.identity)
    || !gh || !Object.is(gh, readers?.destination)
    || !readers || ROLES.some(role => !readers[role])) return UNCERTAIN

  let oldSecret: string | null
  let newSecret: string | null
  try {
    oldSecret = getSecret(id.sourcePassphraseSecretId)
    newSecret = getSecret(id.destinationPassphraseSecretId)
  } catch { return UNCERTAIN }
  if (!oldSecret || !newSecret) return UNCERTAIN

  // Do not stringify the GitHub client itself: a real client may own cyclic
  // state and its function properties never appear in JSON.stringify.
  // Pin the object and all invoked methods separately instead.
  const currentRemote = shadow.remote
  const remoteScope = () => JSON.stringify({
    activeIndexRoot: shadow.activeIndexRoot,
    runId: shadow.runId, expectedDeviceId: shadow.expectedDeviceId,
    remote: {
      plan: currentRemote.plan, sourceConfig: currentRemote.sourceConfig,
      destinationConfig: currentRemote.expectedDestinationConfig,
      receipts: currentRemote.expectedReceipts,
      destinationPassphrase: currentRemote.destinationPassphrase,
      sourceTreeSha: currentRemote.sourceTreeSha,
      destinationCommitSha: currentRemote.destinationCommitSha,
    },
  })

  // Scope is checked at each borrowed callback boundary, before/after remote
  // access, and after the original holder returns. A nested holder may not
  // substitute its own successful result or replace a reader mid-await.
  const initial = {
    input, local, remote, prepared, restart, branches, shadow, contract, id,
    holder, lease, adapter, wal, journal, getSecret, key, gh, readers,
    settings: restart.settings,
    settingsBytes: JSON.stringify(restart.settings),
    sourceSettings: local.sourceSettings,
    sourceSettingsBytes: JSON.stringify(local.sourceSettings),
    contractBytes: JSON.stringify(contract),
    idBytes: JSON.stringify(id),
    preparedIdBytes: JSON.stringify(prepared.identity),
    branchIdBytes: JSON.stringify(branches.identity),
    expected: JSON.stringify(restart.expected),
    initialRestart: JSON.stringify({
      runId: restart.runId, indexRoot: restart.indexRoot,
      sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
      expectedWalGeneration: restart.expectedWalGeneration,
      acknowledgement: restart.acknowledgement,
    }),
    publication: branches.publication,
    publicationBytes: JSON.stringify(branches.publication),
    physicalRepositoryId: branches.physicalRepositoryId,
    currentRemote,
    remoteSignal: currentRemote.signal,
    remoteScope: remoteScope(),
    keyBytes: toBase64(key),
    oldSecret,
    newSecret,
    adapterRead: adapter.read, adapterExists: adapter.exists, adapterStat: adapter.stat,
    journalRead: journal.assertHealthySnapshot,
    walLease: wal.assertExclusiveStageLease, walCheckpoint: wal.assertBestEffortCheckpoint,
  }
  const readMethods = ROLES.map(role => {
    const reader = readers[role]
    return {
      role, reader, branch: reader.branchName,
      repo: reader.getRepositoryIdentity,
      def: reader.getRepositoryDefaultBranch,
      ref: reader.getGitRefOrNull,
      commit: reader.getGitCommit,
    }
  })
  const gitMethods = {
    repo: gh.getRepositoryIdentity, ref: gh.getGitRef,
    commit: gh.getGitCommit, tree: gh.getTreeAt, blob: gh.getBlob,
  }
  const unchanged = () => input.local === local && input.remote === remote
    && local.prepared === prepared && local.contract === contract
    && local.sourceSettings === initial.sourceSettings
    && JSON.stringify(local.sourceSettings) === initial.sourceSettingsBytes
    && prepared.restart === restart
    && prepared.withExclusiveInitiatorLease === holder
    && prepared.journalKey === key && toBase64(key) === initial.keyBytes
    && JSON.stringify(prepared.identity) === initial.preparedIdBytes
    && remote.branches === branches && remote.shadow === shadow
    && branches.identity !== undefined
    && JSON.stringify(branches.identity) === initial.branchIdBytes
    && contract.identity === id && JSON.stringify(id) === initial.idBytes
    && JSON.stringify(contract) === initial.contractBytes
    && restart.settings === initial.settings
    && JSON.stringify(restart.settings) === initial.settingsBytes
    && JSON.stringify(restart.expected) === initial.expected
    && JSON.stringify({
      runId: restart.runId, indexRoot: restart.indexRoot,
      sourceCommitSha: restart.sourceCommitSha, backupRepoId: restart.backupRepoId,
      expectedWalGeneration: restart.expectedWalGeneration,
      acknowledgement: restart.acknowledgement,
    }) === initial.initialRestart
    && restart.indexAdapter === adapter && branches.adapter === adapter
    && shadow.adapter === adapter
    && restart.wal === wal && branches.wal === wal
    && restart.journal === journal && branches.journal === journal
    && restart.getSecret === getSecret
    && restart.assertExclusiveInitiatorLease === lease
    && branches.assertExclusiveInitiatorLease === lease
    && shadow.assertExclusiveInitiatorLease === lease
    && branches.withExclusiveInitiatorLease === holder
    && branches.publication === initial.publication
    && JSON.stringify(branches.publication) === initial.publicationBytes
    && branches.physicalRepositoryId === initial.physicalRepositoryId
    && branches.readers === readers
    && ROLES.every((role, i) => {
      const pinned = readMethods[i]!
      const reader = readers[role]
      return reader === pinned.reader && reader.branchName === pinned.branch
        && reader.getRepositoryIdentity === pinned.repo
        && reader.getRepositoryDefaultBranch === pinned.def
        && reader.getGitRefOrNull === pinned.ref
        && reader.getGitCommit === pinned.commit
    })
    && shadow.remote === initial.currentRemote
    && currentRemote.github === gh && currentRemote.signal === initial.remoteSignal
    && remoteScope() === initial.remoteScope
    && gh.getRepositoryIdentity === gitMethods.repo
    && gh.getGitRef === gitMethods.ref
    && gh.getGitCommit === gitMethods.commit
    && gh.getTreeAt === gitMethods.tree && gh.getBlob === gitMethods.blob
    && adapter.read === initial.adapterRead && adapter.exists === initial.adapterExists
    && adapter.stat === initial.adapterStat
    && journal.assertHealthySnapshot === initial.journalRead
    && wal.assertExclusiveStageLease === initial.walLease
    && wal.assertBestEffortCheckpoint === initial.walCheckpoint
    && getSecret(id.sourcePassphraseSecretId) === initial.oldSecret
    && getSecret(id.destinationPassphraseSecretId) === initial.newSecret

  const assertHeld = async () => {
    if (!unchanged()) throw Error("D185 post-crash local/Git scope drift.")
    await lease()
    await initial.walLease.call(wal)
    if (await initial.walCheckpoint.call(wal) !== "best-effort-readback-only"
      || !unchanged()) throw Error("D185 WAL checkpoint/readback uncertain.")
  }

  let borrowedActive = false
  const borrowed = async <T>(body: () => Promise<T>): Promise<T> => {
    if (borrowedActive) throw Error("D185 borrowed lease nested unexpectedly.")
    borrowedActive = true
    try {
      await assertHeld()
      const result = await body()
      await assertHeld()
      return result
    } finally { borrowedActive = false }
  }
  const localRead = async () => {
    await assertHeld()
    const result = await inspectV4FencedCrashWindowPairAfterRestart({
      ...local, prepared: { ...prepared, withExclusiveInitiatorLease: borrowed },
    })
    if (!unchanged() || result.integrityScope !== "read-only-fenced-post-crash-test-pair-window"
      || result.reason === "fence-wal-lease-or-storage-uncertain"
      || result.artifactWindow === "unverifiable"
      || result.artifactWindow === "unrecognized-layout"
      || (result.artifactWindow === "pair-present"
        && result.pairEvidence !== "cryptographically-linked-uncommitted")
      || result.localCutoverAuthorized !== false || result.resumeSyncAuthorized !== false) {
      throw Error("D185 local post-crash evidence uncertain.")
    }
    return result
  }
  const liveGit = async () => {
    await assertHeld()
    const result = await inspectV4FencedFullRemoteShadowAfterRestart({
      ...remote, branches: { ...branches, withExclusiveInitiatorLease: borrowed },
    })
    if (!unchanged()
      || result.observation !== "complete-destination-matches-shadow-uncommitted"
      || result.completeRemoteContentReverified !== true
      || result.localCutoverAuthorized !== false || result.resumeSyncAuthorized !== false) {
      throw Error("D185 current Git encrypted content and three refs mismatch.")
    }
  }

  let bodyCount = 0
  let bodyResult: V4FencedLivePostCrashReport | null = null
  try {
    const returned = await holder(async () => {
      bodyCount++
      if (bodyCount !== 1) throw Error("D185 Holder called inspection more than once.")
      const first = await localRead()
      await liveGit()
      const second = await localRead()
      if (JSON.stringify(first) !== JSON.stringify(second) || !unchanged()) {
        throw Error("D185 local evidence changed across full Git scan.")
      }
      await liveGit()
      const third = await localRead()
      if (JSON.stringify(first) !== JSON.stringify(third) || !unchanged()) {
        throw Error("D185 local evidence changed after second full Git scan.")
      }
      bodyResult = report(third)
      return bodyResult
    })
    return bodyCount === 1 && returned === bodyResult && unchanged()
      ? returned : UNCERTAIN
  } catch { return UNCERTAIN }
}
