export class V4CancelledError extends Error {
  readonly reason: unknown

  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "V4 operation cancelled.")
    this.name = "V4CancelledError"
    this.reason = reason
  }
}

export function v4CancellationError(signal?: AbortSignal): V4CancelledError {
  if (signal?.reason instanceof V4CancelledError) return signal.reason
  return new V4CancelledError(signal?.reason)
}

export function throwIfV4Aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw v4CancellationError(signal)
}

export async function sleepV4Abortable(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  throwIfV4Aborted(signal)
  if (!signal) return sleep(milliseconds)
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(v4CancellationError(signal))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([sleep(milliseconds), aborted])
    throwIfV4Aborted(signal)
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

export async function deferV4Cancellation<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  throwIfV4Aborted(signal)
  const value = await task()
  throwIfV4Aborted(signal)
  return value
}
