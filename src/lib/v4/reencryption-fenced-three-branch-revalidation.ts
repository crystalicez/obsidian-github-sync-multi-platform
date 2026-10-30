import type { GitHubClient } from "../github-api"
import type { V4LocalIndexAdapter } from "./local-index"
import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import { assertV4ReencryptionExactSyncFence } from "./reencryption-fenced-prepared-selector"
import {
  assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal,
  type V4ReencryptionProposedCommitIdentity,
} from "./reencryption-proposed-commit-receipt"
import type { V4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"
import type { V4ThreeBranchPublicationReport } from "./reencryption-three-branch-publish"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"

type BranchReader = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch"
  | "getGitRefOrNull" | "getGitCommit">

export interface V4FencedThreeBranchRevalidationInput {
  readonly identity: V4ReencryptionProposedCommitIdentity
  /** Prior D100 publication report is an input hint, never current proof. */
  readonly publication: V4ThreeBranchPublicationReport
  readonly physicalRepositoryId: number
  readonly adapter: Pick<V4LocalIndexAdapter, "read" | "exists">
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  readonly wal: Pick<V4DesktopRekeyWalStorage,
    "assertExclusiveStageLease" | "assertBestEffortCheckpoint">
  readonly readers: {
    readonly source: BranchReader
    readonly backup: BranchReader
    readonly destination: BranchReader
  }
  readonly acknowledgement: "accept-best-effort-power-loss-recovery-risk"
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
}

export interface V4FencedThreeBranchRevalidationReport {
  readonly integrityScope: "read-only-current-git-refs-and-authenticated-uncommitted-wal"
  readonly observation: "three-refs-match-pinned-wal-uncommitted" | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly completeRemoteContentReverified: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-current-git-refs-and-authenticated-uncommitted-wal" as const,
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  completeRemoteContentReverified: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4FencedThreeBranchRevalidationReport =
  Object.freeze({ ...BASE, observation: "manual-recovery-required" })
const OBSERVED: V4FencedThreeBranchRevalidationReport =
  Object.freeze({ ...BASE, observation: "three-refs-match-pinned-wal-uncommitted" })

const ROLES = ["source", "backup", "destination"] as const

/**
 * D177 read-only gate between historical D100 remote publication and the
 * D176 prepared Selector. Checks the actual Git refs twice under the caller's
 * cooperative lease, with authenticated best-effort WAL and the D173 fence.
 *
 * This is NOT a replacement for full Git ciphertext / plaintext parity:
 * matching branch refs and commit trees do not authenticate remote content.
 * It never publishes, switches settings, creates receipts or resumes Sync.
 */
export async function inspectV4FencedThreeBranchPublicationAfterRestart(
  input: V4FencedThreeBranchRevalidationInput,
): Promise<V4FencedThreeBranchRevalidationReport> {
  if (!input?.identity) return MANUAL
  try { assertV4ReencryptionProposedCommitIdentity(input.identity) }
  catch { return MANUAL }

  const identity = Object.freeze({ ...input.identity })
  const publication = input.publication
  const readers = input.readers
  const journal = input.journal
  const wal = input.wal
  const adapter = input.adapter
  const holder = input.withExclusiveInitiatorLease
  const lease = input.assertExclusiveInitiatorLease
  const repositoryId = input.physicalRepositoryId
  if (input.acknowledgement !== "accept-best-effort-power-loss-recovery-risk"
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || typeof holder !== "function" || typeof lease !== "function"
    || typeof adapter?.exists !== "function" || typeof adapter.read !== "function"
    || typeof journal?.assertHealthySnapshot !== "function"
    || journal.sourceCommitSha !== identity.sourceCommitSha
    || journal.destinationRepoId !== identity.destinationRepoId
    || typeof wal?.assertExclusiveStageLease !== "function"
    || typeof wal.assertBestEffortCheckpoint !== "function"
    || publication?.integrityScope !== "three-branch-verified-backup-and-destination-remote-only"
    || publication.sourceRepoId !== identity.sourceRepoId
    || publication.backupRepoId !== identity.backupRepoId
    || publication.destinationRepoId !== identity.destinationRepoId
    || publication.originalSourceCommitSha !== identity.sourceCommitSha
    || publication.destinationCommitSha !== identity.destinationCommitSha
    || publication.backupContentsReadbackVerified !== true
    || publication.backupScratchRoundTripVerified !== true
    || publication.destinationContentsReadbackVerified !== true
    || publication.oldBranchSyncRemainsIndependent !== true
    || publication.powerLossDurabilityIndependentlyAudited !== false
    || publication.initiatingDeviceCutoverAuthorized !== false
    || !readers || ROLES.some(role => {
      const client = readers[role]
      const branch = identity[role === "source" ? "sourceRepoId"
        : role === "backup" ? "backupRepoId" : "destinationRepoId"].split("#")[1]
      return !client || client.branchName !== branch
        || typeof client.getRepositoryIdentity !== "function"
        || typeof client.getRepositoryDefaultBranch !== "function"
        || typeof client.getGitRefOrNull !== "function"
        || typeof client.getGitCommit !== "function"
    })) return MANUAL

  const savedIdentity = JSON.stringify(identity)
  const savedPublication = JSON.stringify(publication)
  const pinnedMethods = ROLES.map(role => {
    const c = readers[role]
    return {
      role, client: c, branch: c.branchName,
      repo: c.getRepositoryIdentity, def: c.getRepositoryDefaultBranch,
      ref: c.getGitRefOrNull, commit: c.getGitCommit,
    }
  })
  const journalRead = journal.assertHealthySnapshot
  const walLease = wal.assertExclusiveStageLease
  const walCheckpoint = wal.assertBestEffortCheckpoint
  const fenceRead = adapter.read
  const fenceExists = adapter.exists
  const expectedRepo = identity.sourceRepoId.split("#")[0]!
  const expected = {
    sourceCommitSha: identity.sourceCommitSha,
    destinationRepoId: identity.destinationRepoId,
    generation: identity.walGeneration,
  }
  const pinnedFence = Object.freeze({
    runId: identity.runId, sourceRepoId: identity.sourceRepoId,
    destinationRepoId: identity.destinationRepoId,
  })
  const unchanged = () => input.identity !== undefined
    && JSON.stringify(input.identity) === savedIdentity
    && input.publication === publication
    && JSON.stringify(publication) === savedPublication
    && input.physicalRepositoryId === repositoryId
    && input.adapter === adapter && adapter.read === fenceRead
    && adapter.exists === fenceExists
    && input.journal === journal && journal.assertHealthySnapshot === journalRead
    && journal.sourceCommitSha === expected.sourceCommitSha
    && journal.destinationRepoId === expected.destinationRepoId
    && input.wal === wal && wal.assertExclusiveStageLease === walLease
    && wal.assertBestEffortCheckpoint === walCheckpoint
    && input.readers === readers && ROLES.every((role, i) => {
      const m = pinnedMethods[i]!
      const c = readers[role]
      return c === m.client && c.branchName === m.branch
        && c.getRepositoryIdentity === m.repo
        && c.getRepositoryDefaultBranch === m.def
        && c.getGitRefOrNull === m.ref && c.getGitCommit === m.commit
    })
    && input.withExclusiveInitiatorLease === holder
    && input.assertExclusiveInitiatorLease === lease
    && input.acknowledgement === "accept-best-effort-power-loss-recovery-risk"

  const assertHeld = async () => {
    if (!unchanged()) throw Error("Re-encryption read-only branch bindings changed.")
    await lease()
    await walLease.call(wal)
    if (!unchanged()) throw Error("Re-encryption lease or scope changed.")
  }
  const checkFence = async () => {
    await assertV4ReencryptionExactSyncFence(adapter, pinnedFence, assertHeld)
    if (!unchanged()) throw Error("Re-encryption fence scope changed.")
  }
  const checkWal = async () => {
    await assertHeld()
    const report = await inspectV4BestEffortWalRecovery({
      storage: wal, journal, expected,
    })
    if (!unchanged() || report.observation !== "authenticated-uncommitted"
      || report.generation !== identity.walGeneration
      || report.resumeSyncAuthorized !== false) {
      throw Error("Re-encryption WAL authentication failed.")
    }
    const snapshot = await journalRead.call(journal, identity.walGeneration)
    if (!unchanged() || !matchesV4ReencryptionPreparedWal(snapshot, identity)) {
      throw Error("Re-encryption WAL three-branch refs are incomplete or stale.")
    }
    return JSON.stringify(snapshot)
  }
  const checkRemote = async () => {
    const branchNames = new Set<string>()
    for (const m of pinnedMethods) {
      await assertHeld()
      const repo = await m.repo.call(m.client)
      if (!unchanged() || repo?.id !== repositoryId
        || repo.fullName.toLowerCase() !== expectedRepo.toLowerCase()) {
        throw Error("Re-encryption GitHub physical repository identity changed.")
      }
      const defaultBranch = await m.def.call(m.client)
      if (!unchanged() || defaultBranch === identity.backupRepoId.split("#")[1]
        || defaultBranch === identity.destinationRepoId.split("#")[1]) {
        throw Error("Re-encryption Backup or Destination cannot be the default branch.")
      }
      branchNames.add(defaultBranch)
      const ref = await m.ref.call(m.client)
      const sha = m.role === "destination" ? identity.destinationCommitSha : identity.sourceCommitSha
      if (!unchanged() || ref?.ref !== `refs/heads/${m.branch}`
        || ref.type !== "commit" || ref.sha !== sha) {
        throw Error("Re-encryption GitHub branch missing or moved.")
      }
      const commit = await m.commit.call(m.client, sha)
      const tree = m.role === "destination" ? identity.destinationTreeSha : identity.sourceTreeSha
      if (!unchanged() || commit?.sha !== sha || commit.treeSha !== tree
        || !Array.isArray(commit.parentShas)
        || (m.role === "destination" && commit.parentShas.length !== 0)) {
        throw Error("Re-encryption remote commit/tree/orphan proof changed.")
      }
    }
    if (branchNames.size !== 1) throw Error("Re-encryption repository defaults changed during verification.")
    return [...branchNames][0]!
  }

  let invoked = false
  try {
    const report = await holder(async () => {
      if (invoked) throw Error("Re-encryption read-only lease body invoked twice.")
      invoked = true
      await checkFence()
      const first = await checkWal()
      const firstDefault = await checkRemote()
      await checkFence()
      const secondDefault = await checkRemote()
      const second = await checkWal()
      await checkFence()
      if (!unchanged() || first !== second || firstDefault !== secondDefault) {
        throw Error("Re-encryption remote and WAL observations changed.")
      }
      return OBSERVED
    })
    return invoked && unchanged() && report === OBSERVED ? OBSERVED : MANUAL
  } catch {
    return MANUAL
  }
}
