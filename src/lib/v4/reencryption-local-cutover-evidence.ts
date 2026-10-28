import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import {
  inspectV4ReencryptionLocalCutoverAfterRestart,
  type V4LocalCutoverInspectInput,
} from "./reencryption-local-cutover-inspection"
import type {
  V4ReencryptionJournalSnapshot, V4ReencryptionRecoveryJournal,
} from "./reencryption-recovery-journal"

const SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u

export type V4ReencryptionLocalCutoverEvidenceObservation =
  | "source-with-verified-remote-fork-uncommitted"
  | "destination-observed-without-local-commit"
  | "manual-recovery-required"

export interface V4ReencryptionLocalCutoverEvidenceReport {
  readonly integrityScope: "read-only-cross-surface-local-and-encrypted-wal-evidence"
  readonly observation: V4ReencryptionLocalCutoverEvidenceObservation
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly credentialCleanupAuthorized: false
}

export interface V4ReencryptionLocalCutoverEvidenceInput extends V4LocalCutoverInspectInput {
  readonly sourceCommitSha: string
  readonly backupRepoId: string
  readonly expectedWalGeneration: number
  /** The caller must supply a real, authenticated and durable WAL reader. */
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  /** A live lease and a genuine platform durability assertion are required. */
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly assertCrashDurable: () => Promise<void>
}

const BASE = Object.freeze({
  integrityScope: "read-only-cross-surface-local-and-encrypted-wal-evidence" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  credentialCleanupAuthorized: false as const,
})

function parseIdentity(repoId: string): { owner: string; repo: string; branch: string } {
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(repoId)
  if (!match) throw new Error("Invalid re-encryption evidence GitHub identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { owner, repo, branch }
}

function validate(input: V4ReencryptionLocalCutoverEvidenceInput): void {
  if (!input || !SHA.test(input.sourceCommitSha)
    || !Number.isSafeInteger(input.expectedWalGeneration) || input.expectedWalGeneration <= 0
    || !input.expected || !SHA.test(input.expected.destinationCommitSha)
    || !input.expected.sourcePassphraseSecretId || !input.expected.destinationPassphraseSecretId
    || input.expected.sourcePassphraseSecretId === input.expected.destinationPassphraseSecretId
    || !input.expected.deviceId
    || typeof input.indexRoot !== "string" || !input.indexRoot
    || input.indexRoot.includes("\\")
    || input.indexRoot.split("/").some(part => !part || part === "." || part === "..")
    || typeof input.getSecret !== "function"
    || typeof input.indexAdapter?.read !== "function"
    || typeof input.indexAdapter.exists !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || input.journal.sourceCommitSha !== input.sourceCommitSha
    || input.journal.destinationRepoId !== input.expected.destinationRepoId) {
    throw new Error("Re-encryption cutover evidence requires pinned WAL identity and strict durable lease.")
  }
  const old = parseIdentity(input.expected.sourceRepoId)
  const backup = parseIdentity(input.backupRepoId)
  const dest = parseIdentity(input.expected.destinationRepoId)
  if (old.owner !== backup.owner || old.owner !== dest.owner
    || old.repo !== backup.repo || old.repo !== dest.repo
    || old.branch === backup.branch || old.branch === dest.branch || backup.branch === dest.branch) {
    throw new Error("Re-encryption cutover evidence requires distinct Source/Backup/Destination in one repository.")
  }
}

function matchesPublishedFork(
  snapshot: V4ReencryptionJournalSnapshot, input: V4ReencryptionLocalCutoverEvidenceInput,
): boolean {
  if (!snapshot || snapshot.generation !== input.expectedWalGeneration
    || snapshot.requiresRemoteRevalidation !== true
    || snapshot.permissionToPublish !== false || snapshot.cutoverAuthorized !== false
    || snapshot.stageHandoffStarted !== true
    || !SHA256.test(snapshot.candidatePreparationSha256 ?? "")
    || snapshot.pendingIntents.length !== 0 || snapshot.pendingRefIntents.length !== 0
    || snapshot.verifiedRefObservations.length !== 2
    || !snapshot.preparedCandidateReceipt) return false
  const candidate = snapshot.preparedCandidateReceipt
  if (candidate.commitSha !== input.expected.destinationCommitSha
    || !SHA.test(candidate.treeSha) || !SHA256.test(candidate.manifestSha256)) return false
  const backup = snapshot.verifiedRefObservations.find(item => item.role === "backup")
  const dest = snapshot.verifiedRefObservations.find(item => item.role === "destination")
  return !!backup && !!dest
    && backup.repoId === input.backupRepoId
    && backup.commitSha === input.sourceCommitSha
    && SHA.test(backup.treeSha)
    && backup.manifestSha256 === undefined
    && dest.repoId === input.expected.destinationRepoId
    && dest.commitSha === candidate.commitSha
    && dest.treeSha === candidate.treeSha
    && dest.manifestSha256 === candidate.manifestSha256
}

/**
 * D132: compose existing authenticated WAL and D131 local observations,
 * without inventing a settings/secret/index durability transaction.
 *
 * A fully matching report is STILL UNCOMMITTED. The two WAL readbacks
 * protect against changes across local inspection, but cannot prevent
 * external edits after the last sample or replace a full remote readback.
 *
 * This helper has no writes or permission to auto-repair, resume Sync,
 * update Git refs or clear old credentials.
 */
export async function inspectV4ReencryptionCutoverEvidence(
  input: V4ReencryptionLocalCutoverEvidenceInput,
): Promise<V4ReencryptionLocalCutoverEvidenceReport> {
  validate(input)
  // Freeze caller-owned identity by VALUE before awaiting the WAL or platform
  // durability gate. Readonly TS annotations do not make runtime objects safe.
  const pinnedExpected = Object.freeze({ ...input.expected })
  const initialSettings = Object.freeze({ ...input.settings })
  const capturedInput = Object.freeze({ ...input, expected: pinnedExpected })
  const snapshotIdentity = Object.freeze({
    sourceCommitSha: input.sourceCommitSha,
    backupRepoId: input.backupRepoId,
    destinationRepoId: pinnedExpected.destinationRepoId,
    destinationCommitSha: pinnedExpected.destinationCommitSha,
    generation: input.expectedWalGeneration,
  })
  await input.assertExclusiveInitiatorLease()
  await input.assertCrashDurable()
  const first = await input.journal.assertHealthySnapshot(snapshotIdentity.generation)
  const firstCopy = JSON.stringify(first)
  const firstValid = matchesPublishedFork(first, capturedInput)
  const local = await inspectV4ReencryptionLocalCutoverAfterRestart(capturedInput)
  await input.assertExclusiveInitiatorLease()
  await input.assertCrashDurable()
  const second = await input.journal.assertHealthySnapshot(snapshotIdentity.generation)
  const coherent = firstValid && matchesPublishedFork(second, capturedInput)
    && firstCopy === JSON.stringify(second)
    && input.sourceCommitSha === snapshotIdentity.sourceCommitSha
    && input.backupRepoId === snapshotIdentity.backupRepoId
    && input.expected.destinationRepoId === snapshotIdentity.destinationRepoId
    && input.expected.destinationCommitSha === snapshotIdentity.destinationCommitSha
    && input.expectedWalGeneration === snapshotIdentity.generation
    && Object.entries(pinnedExpected).every(([key, value]) =>
      input.expected[key as keyof typeof pinnedExpected] === value)
    && Object.entries(initialSettings).every(([key, value]) =>
      input.settings[key as keyof typeof initialSettings] === value)
    && local.localCutoverAuthorized === false && local.resumeSyncAuthorized === false
  let observation: V4ReencryptionLocalCutoverEvidenceObservation = "manual-recovery-required"
  if (coherent && local.observation === "source-observed") {
    observation = "source-with-verified-remote-fork-uncommitted"
  } else if (coherent && local.observation === "destination-observed-unconfirmed") {
    observation = "destination-observed-without-local-commit"
  }
  return Object.freeze({ ...BASE, observation })
}
