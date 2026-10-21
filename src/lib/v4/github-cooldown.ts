/** GitHub's Retry-After / primary reset takes precedence over the 60-second fallback. */
export function githubRateLimitUntil(headers: Record<string, string>, now = Date.now()): number {
  const h = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  const after = h["retry-after"]?.trim()
  const seconds = after && /^\d+(?:\.\d+)?$/u.test(after) ? Number(after) : 0
  const retryUntil = seconds > 0 && Number.isSafeInteger(now + Math.ceil(seconds * 1_000))
    && now + Math.ceil(seconds * 1_000) <= 8_640_000_000_000_000
    ? now + Math.ceil(seconds * 1_000) : 0
  const reset = h["x-ratelimit-reset"]?.trim()
  const resetSeconds = reset && /^\d+$/u.test(reset) ? Number(reset) : 0
  const resetUntil = h["x-ratelimit-remaining"] === "0"
    && Number.isSafeInteger(resetSeconds) && Number.isSafeInteger(resetSeconds * 1_000)
    && resetSeconds * 1_000 > now && resetSeconds * 1_000 <= 8_640_000_000_000_000
    ? resetSeconds * 1_000 : 0
  // When both are present, primary exhaustion must not be shortened by Retry-After.
  // Zero, expired, invalid or implausibly large headers fall back to a safe minute.
  return Math.max(retryUntil, resetUntil, retryUntil || resetUntil ? 0 : now + 60_000)
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
