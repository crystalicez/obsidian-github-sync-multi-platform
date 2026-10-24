import {
  DEFAULT_V4_TRANSPORT_POLICY,
  resolveV4RateLimitDelay,
  resolveV4TransportPolicy,
  type V4TransportPolicy,
} from "./transport-policy"
import { sleepV4Abortable, throwIfV4Aborted, v4CancellationError } from "./cancellation"

export type V4RequestKind = "read" | "write"

export interface V4RequestSchedulerSnapshot {
  queuedReads: number
  queuedWrites: number
  activeReads: number
  activeWrites: number
  cooldownRemainingMs: number
  mutationPacingRemainingMs: number
  activePolicySleeps: number
  oldestPolicySleepOverdueMs: number
  maxPolicySleepOvershootMs: number
}

export interface V4RequestSchedulerOptions extends Partial<V4TransportPolicy> {
  sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined
  now?: (() => number) | undefined
  retryRateLimits?: boolean
  onRetry?: (milliseconds: number) => void
  onCooldown?: (deadlineEpochMs: number) => Promise<void> | void
  onDelay?: (input: { reason: "cooldown" | "pacing"; milliseconds: number }) => void
}

interface QueueItem<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal?: AbortSignal | undefined
  onAbort?: () => void
}

export class V4RequestScheduler {
  private readonly limits: Record<V4RequestKind, number>
  private readonly active: Record<V4RequestKind, number> = { read: 0, write: 0 }
  private readonly queues: Record<V4RequestKind, Array<QueueItem<unknown>>> = { read: [], write: [] }
  private readonly policy: V4TransportPolicy
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly retryRateLimits: boolean
  private readonly onRetry: ((milliseconds: number) => void) | undefined
  private readonly onCooldown: ((deadlineEpochMs: number) => Promise<void> | void) | undefined
  private readonly onDelay: ((input: { reason: "cooldown" | "pacing"; milliseconds: number }) => void) | undefined
  private cooldownUntil = 0
  private lastMutationStartedAt: number | undefined
  private mutationStartGate: Promise<void> = Promise.resolve()
  private readonly policySleepDeadlines = new Map<number, number>()
  private nextPolicySleepId = 0
  private maxPolicySleepOvershootMs = 0

  constructor(options: V4RequestSchedulerOptions = {}) {
    this.policy = resolveV4TransportPolicy(options)
    this.limits = {
      read: this.policy.readConcurrency,
      write: this.policy.writeConcurrency,
    }
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)))
    this.now = options.now ?? (() => Date.now())
    this.retryRateLimits = options.retryRateLimits ?? true
    this.onRetry = options.onRetry
    this.onCooldown = options.onCooldown
    this.onDelay = options.onDelay
  }

  /** Restore a previously observed server rate-limit deadline before any request runs. */
  restoreCooldown(deadlineEpochMs: number): void {
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) return
    this.cooldownUntil = Math.max(this.cooldownUntil, deadlineEpochMs)
  }

  get snapshot(): V4RequestSchedulerSnapshot {
    const now = this.now()
    let oldestPolicySleepOverdueMs = 0
    for (const deadline of this.policySleepDeadlines.values()) {
      oldestPolicySleepOverdueMs = Math.max(oldestPolicySleepOverdueMs, now - deadline)
    }
    return {
      queuedReads: this.queues.read.length,
      queuedWrites: this.queues.write.length,
      activeReads: this.active.read,
      activeWrites: this.active.write,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
      mutationPacingRemainingMs: this.lastMutationStartedAt === undefined
        ? 0 : Math.max(0, this.lastMutationStartedAt + this.policy.mutationSpacingMs - now),
      activePolicySleeps: this.policySleepDeadlines.size,
      oldestPolicySleepOverdueMs,
      maxPolicySleepOvershootMs: this.maxPolicySleepOvershootMs,
    }
  }

  run<T>(kind: V4RequestKind, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(v4CancellationError(signal))
      const item = { task, resolve, reject, signal } as QueueItem<unknown>
      if (signal) {
        item.onAbort = () => {
          const index = this.queues[kind].indexOf(item)
          if (index >= 0) {
            this.queues[kind].splice(index, 1)
            reject(v4CancellationError(signal))
          }
        }
        signal.addEventListener("abort", item.onAbort, { once: true })
      }
      this.queues[kind].push(item)
      this.drain(kind)
    })
  }

  private drain(kind: V4RequestKind): void {
    while (this.active[kind] < this.limits[kind] && this.queues[kind].length > 0) {
      const item = this.queues[kind].shift()!
      if (item.onAbort && item.signal) item.signal.removeEventListener("abort", item.onAbort)
      if (item.signal?.aborted) { item.reject(v4CancellationError(item.signal)); continue }
      this.active[kind] += 1
      void this.execute(kind, item)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active[kind] -= 1
          this.drain(kind)
        })
    }
  }

  private async waitForPolicy(kind: V4RequestKind, signal?: AbortSignal): Promise<void> {
    if (kind === "write") {
      const turn = this.mutationStartGate.then(() => this.waitForPolicyStart(kind, signal))
      this.mutationStartGate = turn.catch(() => undefined)
      await turn
      return
    }
    await this.waitForPolicyStart(kind, signal)
  }

  private async waitForPolicyStart(kind: V4RequestKind, signal?: AbortSignal): Promise<void> {
    // Another request can discover a longer rate limit while this one sleeps.
    for (;;) {
      const now = this.now()
      const cooldownDelay = Math.max(0, this.cooldownUntil - now)
      const pacingDelay = kind === "write" && this.lastMutationStartedAt !== undefined
        ? Math.max(0, this.lastMutationStartedAt + this.policy.mutationSpacingMs - now)
        : 0
      const milliseconds = Math.max(cooldownDelay, pacingDelay)
      if (milliseconds <= 0) break
      this.onDelay?.({ reason: cooldownDelay >= pacingDelay ? "cooldown" : "pacing", milliseconds })
      const deadline = this.now() + milliseconds
      const sleepId = ++this.nextPolicySleepId
      this.policySleepDeadlines.set(sleepId, deadline)
      try {
        // Node/Electron clamps longer timers; re-evaluate the deadline after each chunk.
        await sleepV4Abortable(Math.min(milliseconds, 2_147_483_647), signal, this.sleep)
        this.maxPolicySleepOvershootMs = Math.max(this.maxPolicySleepOvershootMs, this.now() - deadline)
      } finally {
        this.policySleepDeadlines.delete(sleepId)
      }
      throwIfV4Aborted(signal)
    }
    throwIfV4Aborted(signal)
    if (kind === "write") this.lastMutationStartedAt = this.now()
  }

  private async execute<T>(kind: V4RequestKind, item: QueueItem<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
      await this.waitForPolicy(kind, item.signal)
      throwIfV4Aborted(item.signal)
      try {
        const value = await item.task()
        if (kind === "read") throwIfV4Aborted(item.signal)
        return value
      } catch (error) {
        lastError = error
        const delay = resolveV4RateLimitDelay(error, attempt, this.now(), this.policy)
        if (delay === null) throw error
        const previousDeadline = this.cooldownUntil
        this.restoreCooldown(Math.ceil(this.now() + delay))
        // Persist before returning/retrying, including the terminal attempt.
        if (this.cooldownUntil > previousDeadline) await this.onCooldown?.(this.cooldownUntil)
        if (!this.retryRateLimits || attempt === this.policy.maxAttempts) throw error
        this.onRetry?.(delay)
      }
    }
    throw lastError
  }
}

export { DEFAULT_V4_TRANSPORT_POLICY }
