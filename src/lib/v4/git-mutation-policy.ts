export type V4MutationRetryClass =
  | "immutable-idempotent"
  | "orphan-safe-commit"
  | "reachable-ref"

export type V4MutationFailureClass = "unknown-outcome" | "definitive"

export interface V4MutationRetryEvidence {
  originalCannotBeReachable?: boolean
}

export class V4GitMutationOutcomeUnknownError extends Error {
  readonly retryClass: V4MutationRetryClass
  readonly cause: unknown

  constructor(retryClass: V4MutationRetryClass, cause: unknown) {
    super(`V4 Git mutation has an unknown outcome (${retryClass}).`)
    this.name = "V4GitMutationOutcomeUnknownError"
    this.retryClass = retryClass
    this.cause = cause
  }
}

export function classifyV4MutationFailure(error: unknown): V4MutationFailureClass {
  const status = (error as { status?: number } | null)?.status
  if (status === undefined) return "unknown-outcome"
  if (status === 408 || status >= 500) return "unknown-outcome"
  return "definitive"
}

export function canRetryV4MutationAfterUnknownOutcome(
  retryClass: V4MutationRetryClass,
  evidence: V4MutationRetryEvidence = {},
): boolean {
  if (retryClass === "immutable-idempotent") return true
  if (retryClass === "orphan-safe-commit") return evidence.originalCannotBeReachable === true
  return false
}

export function isV4GitMutationOutcomeUnknownError(error: unknown): error is V4GitMutationOutcomeUnknownError {
  if (error instanceof V4GitMutationOutcomeUnknownError) return true
  const value = error as { name?: string; retryClass?: string } | null
  return value?.name === "V4GitMutationOutcomeUnknownError"
    && (value.retryClass === "immutable-idempotent" || value.retryClass === "orphan-safe-commit" || value.retryClass === "reachable-ref")
}
