export class V4RepositoryBootstrapRaceError extends Error {
  readonly code = "V4_REPOSITORY_BOOTSTRAP_RACE" as const

  constructor(
    readonly observedRefSha: string,
    readonly cause: unknown,
  ) {
    super("GitHub repository bootstrap state changed concurrently.")
    this.name = "V4RepositoryBootstrapRaceError"
  }
}

export function isV4RepositoryBootstrapRaceError(error: unknown): error is V4RepositoryBootstrapRaceError {
  if (error instanceof V4RepositoryBootstrapRaceError) return true
  if (!error || typeof error !== "object") return false
  const candidate = error as Partial<V4RepositoryBootstrapRaceError>
  return candidate.code === "V4_REPOSITORY_BOOTSTRAP_RACE"
    && typeof candidate.observedRefSha === "string"
    && candidate.observedRefSha.length > 0
}
