export interface V4TransportPolicy {
  readConcurrency: number
  writeConcurrency: number
  maxAttempts: number
  mutationSpacingMs: number
  secondaryLimitFallbackMs: number
  maxSecondaryCooldownMs: number
}

export const DEFAULT_V4_TRANSPORT_POLICY: V4TransportPolicy = {
  readConcurrency: 4,
  writeConcurrency: 1,
  maxAttempts: 3,
  mutationSpacingMs: 1_000,
  secondaryLimitFallbackMs: 60_000,
  maxSecondaryCooldownMs: 15 * 60_000,
}

export function resolveV4TransportPolicy(overrides: Partial<V4TransportPolicy> | undefined): V4TransportPolicy {
  const policy = { ...DEFAULT_V4_TRANSPORT_POLICY, ...overrides }
  return {
    readConcurrency: Math.max(1, Math.floor(policy.readConcurrency)),
    writeConcurrency: Math.max(1, Math.floor(policy.writeConcurrency)),
    maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)),
    mutationSpacingMs: Math.max(0, Math.floor(policy.mutationSpacingMs)),
    secondaryLimitFallbackMs: Math.max(0, Math.floor(policy.secondaryLimitFallbackMs)),
    maxSecondaryCooldownMs: Math.max(0, Math.floor(policy.maxSecondaryCooldownMs)),
  }
}

export function resolveV4RateLimitDelay(
  error: unknown,
  attempt: number,
  nowMs = Date.now(),
  policy: V4TransportPolicy = DEFAULT_V4_TRANSPORT_POLICY,
): number | null {
  const value = error as { status?: number; headers?: Record<string, string> } | null
  if (value?.status !== 403 && value?.status !== 429) return null
  const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([key, header]) => [key.toLowerCase(), header]))
  const retryAfter = Number(headers["retry-after"])
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000
  const reset = Number(headers["x-ratelimit-reset"])
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - nowMs)
  const fallback = policy.secondaryLimitFallbackMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(policy.maxSecondaryCooldownMs, fallback)
}
