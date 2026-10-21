/** GitHub's Retry-After / primary reset takes precedence over the 60-second fallback. */
export function githubRateLimitUntil(headers: Record<string, string>, now = Date.now()): number {
  const h = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const after = h["retry-after"]
  if (after !== undefined && /^\d+(?:\.\d+)?$/u.test(after.trim())) {
    const seconds = Number(after)
    if (Number.isFinite(seconds)) return now + Math.ceil(seconds * 1_000)
  }
  if (h["x-ratelimit-remaining"] === "0") {
    const reset = Number(h["x-ratelimit-reset"])
    if (Number.isSafeInteger(reset) && reset * 1_000 > now) return reset * 1_000
  }
  return now + 60_000
}

export class GitHubRateLimitCooldownError extends Error {
  readonly name = "GitHubRateLimitCooldownError"
  readonly status = 429 // A known local pause, never an ambiguous remote mutation.
  constructor(readonly untilMs: number) {
    super(`GitHub rate limit: Sync paused until ${new Date(untilMs).toLocaleString()}.`)
  }
}

export function activeGitHubCooldownUntil(
  untilMs: number,
  savedContext: string,
  currentContext: string,
  now = Date.now(),
): number {
  return savedContext === currentContext && Number.isFinite(untilMs) && untilMs > now ? untilMs : 0
}
