import type { GitHubClient, GitHubRepositoryIdentity } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { computeV4GitBlobSha1 } from "./git-blob-identity"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"
import type { V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import { assertV4ReencryptionJournalObjectReceipt, type V4ReencryptionRecoveryJournal, type V4ReencryptionJournalSnapshot } from "./reencryption-recovery-journal"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"

/**
 * Read-only reconnaissance for staged Git objects, including uploads whose
 * response was ambiguous. It does NOT verify tree reachability or decrypt
 * ciphertext; a Git Blob SHA is not a complete V4/second-device proof.
 *
 * GitHub /git/blobs/:sha may return 404 for an unreachable recent object or
 * eventual consistency. Treat ALL lookup failures as INCONCLUSIVE, never as
 * evidence of missing data and NEVER perform retries/writes here.
 */
export interface V4ReencryptionBlobReconciliationInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "load">
  readonly github: Pick<GitHubClient, "getRepositoryIdentity" | "getBlob">
  /** Per-call bounded audit. Oversize batches remain explicitly inconclusive. */
  readonly maxObjects?: number | undefined
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionBlobReconciliationReport {
  readonly integrityScope: "git-blob-by-sha-only"
  readonly status: "verified" | "inconclusive"
  readonly confirmedReceiptCount: number
  readonly pendingIntentCount: number
  readonly verifiedObjectCount: number
  readonly inconclusiveObjectCount: number
  readonly requiresRemoteRevalidation: true
  readonly destinationContentVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
}

const GIT_SHA = /^[0-9a-f]{40}$/u
const MAX_AUDIT_OBJECTS = 4096

// Reuse D80's exact WAL record validation (including safe opaque path shape).
// Do not create a second permissive validation policy for remote readback.

function validateRepositoryIdentity(
  identity: GitHubRepositoryIdentity,
  physicalRepositoryId: number,
  expectedFullName: string,
): void {
  if (!identity || identity.id !== physicalRepositoryId
    || identity.fullName?.toLowerCase() !== expectedFullName.toLowerCase()) {
    throw new Error("Re-encryption GitHub physical repository identity changed or is invalid.")
  }
}

function assertSameJournal(before: V4ReencryptionJournalSnapshot, after: V4ReencryptionJournalSnapshot | null): void {
  const eq = (a: readonly V4ReencryptionObjectReceipt[], b: readonly V4ReencryptionObjectReceipt[]) =>
    a.length === b.length && a.every((r, i) =>
      r.path === b[i]?.path && r.sha === b[i]?.sha && r.byteLength === b[i]?.byteLength)
  if (!after || after.generation !== before.generation
    || !eq(before.receipts, after.receipts)
    || !eq(before.pendingIntents, after.pendingIntents)) {
    throw new Error("Re-encryption WAL changed during Git blob reconciliation; results are invalid.")
  }
}

export async function verifyStagedV4ReencryptionGitBlobs(
  input: V4ReencryptionBlobReconciliationInput,
): Promise<V4ReencryptionBlobReconciliationReport> {
  throwIfV4Aborted(input.signal)
  const { plan } = input
  if (plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || !GIT_SHA.test(plan.pinnedSourceCommitSha)
    || !Number.isSafeInteger(plan.physicalRepositoryId) || plan.physicalRepositoryId < 1
    || input.journal.destinationRepoId !== plan.destinationRepoId
    || input.journal.sourceCommitSha !== plan.pinnedSourceCommitSha) {
    throw new Error("Re-encryption journal/plan source or destination identity mismatch.")
  }
  const split = plan.destinationRepoId.split("#")
  if (split.length !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(split[0] ?? "")
    || !split[1]) {
    throw new Error("Re-encryption destination identity is invalid.")
  }
  const maxObjects = input.maxObjects ?? 2048
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > MAX_AUDIT_OBJECTS) {
    throw new Error("Re-encryption Git blob audit limit must be 1 to 4096.")
  }

  const original = await input.journal.load()
  throwIfV4Aborted(input.signal)
  if (!original || original.permissionToPublish !== false || original.cutoverAuthorized !== false
    || original.requiresRemoteRevalidation !== true
    || !Array.isArray(original.receipts) || !Array.isArray(original.pendingIntents)) {
    throw new Error("Re-encryption journal is missing, corrupt, or not marked for remote revalidation.")
  }
  const listed = [...original.receipts, ...original.pendingIntents]
  const seen = new Set<string>()
  for (const receipt of listed) {
    assertV4ReencryptionJournalObjectReceipt(receipt)
    if (seen.has(receipt.path)) {
      throw new Error("Re-encryption Git blob audit contains duplicated WAL object paths.")
    }
    seen.add(receipt.path)
  }
  throwIfV4Aborted(input.signal)
  validateRepositoryIdentity(
    await input.github.getRepositoryIdentity(), plan.physicalRepositoryId, split[0]!,
  )
  throwIfV4Aborted(input.signal)

  let verified = 0
  let inconclusive = 0
  if (listed.length > maxObjects) {
    // Do not silently audit a subset as if the entire WAL were verified.
    inconclusive = listed.length
  } else {
    for (const receipt of listed) {
      throwIfV4Aborted(input.signal)
      let data: Uint8Array
      try {
        data = await input.github.getBlob(receipt.sha)
      } catch {
        throwIfV4Aborted(input.signal)
        // 404, timeout, rate limit and authorization failures never mean
        // "object absent" with reliable evidence. No retry, no WAL promotion.
        inconclusive++
        continue
      }
      throwIfV4Aborted(input.signal)
      if (!(data instanceof Uint8Array)
        || data.byteLength !== receipt.byteLength
        || data.byteLength > V4_GITHUB_REST_SAFE_WRITER_BYTES
        || computeV4GitBlobSha1(data) !== receipt.sha) {
        throw new Error("Re-encryption remote Git blob size or cryptographic object identity mismatch.")
      }
      verified++
    }
  }
  throwIfV4Aborted(input.signal)
  validateRepositoryIdentity(
    await input.github.getRepositoryIdentity(), plan.physicalRepositoryId, split[0]!,
  )
  throwIfV4Aborted(input.signal)
  assertSameJournal(original, await input.journal.load())
  throwIfV4Aborted(input.signal)

  return Object.freeze({
    integrityScope: "git-blob-by-sha-only",
    status: inconclusive === 0 && listed.length > 0 ? "verified" : "inconclusive",
    confirmedReceiptCount: original.receipts.length,
    pendingIntentCount: original.pendingIntents.length,
    verifiedObjectCount: verified,
    inconclusiveObjectCount: inconclusive,
    requiresRemoteRevalidation: true,
    destinationContentVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
}
