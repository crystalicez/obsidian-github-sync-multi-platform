import {
  DEFAULT_V4_TRANSPORT_POLICY,
  resolveV4RateLimitDelay,
  resolveV4TransportPolicy,
  type V4TransportPolicy,
} from "./transport-policy"
import { sleepV4Abortable, throwIfV4Aborted, v4CancellationError } from "./cancellation"

export type V4RequestKind = "read" | "write"

export interface V4RequestSchedulerOptions extends Partial<V4TransportPolicy> {
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  onRetry?: (milliseconds: number) => void
  onDelay?: (input: { reason: "cooldown" | "pacing"; milliseconds: number }) => void
}

interface QueueItem<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class V4RequestScheduler {
  private readonly limits: Record<V4RequestKind, number>
  private readonly active: Record<V4RequestKind, number> = { read: 0, write: 0 }
  private readonly queues: Record<V4RequestKind, Array<QueueItem<unknown>>> = { read: [], write: [] }
  private readonly policy: V4TransportPolicy
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly onRetry?: (milliseconds: number) => void
  private readonly onDelay?: (input: { reason: "cooldown" | "pacing"; milliseconds: number }) => void
  private cooldownUntil = 0
  private lastMutationStartedAt: number | undefined

  constructor(options: V4RequestSchedulerOptions = {}) {
    this.policy = resolveV4TransportPolicy(options)
    this.limits = {
      read: this.policy.readConcurrency,
      write: this.policy.writeConcurrency,
    }
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)))
    this.now = options.now ?? (() => Date.now())
    this.onRetry = options.onRetry
    this.onDelay = options.onDelay
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
    const now = this.now()
    const cooldownDelay = Math.max(0, this.cooldownUntil - now)
    const pacingDelay = kind === "write" && this.lastMutationStartedAt !== undefined
      ? Math.max(0, this.lastMutationStartedAt + this.policy.mutationSpacingMs - now)
      : 0
    const milliseconds = Math.max(cooldownDelay, pacingDelay)
    if (milliseconds > 0) {
      this.onDelay?.({ reason: cooldownDelay >= pacingDelay ? "cooldown" : "pacing", milliseconds })
      await sleepV4Abortable(milliseconds, signal, this.sleep)
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
        if (delay === null || attempt === this.policy.maxAttempts) throw error
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay)
        this.onRetry?.(delay)
      }
    }
    throw lastError
  }
}

export { DEFAULT_V4_TRANSPORT_POLICY }
