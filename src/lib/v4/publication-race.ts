export type V4PublicationRacePhase =
  | "bootstrap-config"
  | "bootstrap-publish"
  | "pre-publish"
  | "post-publish"

export type V4PublicationOutcome = "published" | "not-published" | "unknown"

export interface V4PublicationRaceErrorInput {
  phase: V4PublicationRacePhase
  expectedHeadSha: string | null
  observedHeadSha: string | null
  publicationOutcome: V4PublicationOutcome
  cause?: unknown
  message?: string
}

export class V4PublicationRaceError extends Error {
  readonly code = "V4_PUBLICATION_RACE" as const
  readonly phase: V4PublicationRacePhase
  readonly expectedHeadSha: string | null
  readonly observedHeadSha: string | null
  readonly publicationOutcome: V4PublicationOutcome
  readonly cause: unknown

  constructor(input: V4PublicationRaceErrorInput) {
    super(input.message ?? "Remote branch changed while syncing.")
    this.name = "V4PublicationRaceError"
    this.phase = input.phase
    this.expectedHeadSha = input.expectedHeadSha
    this.observedHeadSha = input.observedHeadSha
    this.publicationOutcome = input.publicationOutcome
    this.cause = input.cause
  }
}

export function isV4PublicationRaceError(error: unknown): error is V4PublicationRaceError {
  if (error instanceof V4PublicationRaceError) return true
  if (!error || typeof error !== "object") return false
  const value = error as Partial<V4PublicationRaceError>
  return value.code === "V4_PUBLICATION_RACE"
    && (value.phase === "bootstrap-config"
      || value.phase === "bootstrap-publish"
      || value.phase === "pre-publish"
      || value.phase === "post-publish")
    && (value.publicationOutcome === "published"
      || value.publicationOutcome === "not-published"
      || value.publicationOutcome === "unknown")
    && (value.expectedHeadSha === null || typeof value.expectedHeadSha === "string")
    && (value.observedHeadSha === null || typeof value.observedHeadSha === "string")
}
