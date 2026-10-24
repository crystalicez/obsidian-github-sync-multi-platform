import { v4CancellationError } from "./cancellation"

// GitHub transport scheduling only. Do not change UI, autosync or mobile timers.
export function selectV4GitHubSchedulerSleep(
  isDesktop: boolean,
  nodeTimer?: (callback: () => void, milliseconds: number) => unknown,
  clearNodeTimer?: (handle: unknown) => void,
): ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined {
  if (!isDesktop) return undefined
  // Resolve Node only for Desktop. An injected timer keeps mobile-oriented tests Node-free.
  const nodeTimers = nodeTimer ? undefined : require("node:timers") as {
    setTimeout: (callback: () => void, milliseconds: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  const timer = nodeTimer ?? nodeTimers!.setTimeout
  const clearTimer = clearNodeTimer ?? nodeTimers?.clearTimeout
  return (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(v4CancellationError(signal)); return }

    let settled = false
    let timerArmed = false
    let timerCompleted = false
    let handle: unknown
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      if (timerArmed) clearTimer?.(handle)
      reject(v4CancellationError(signal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      handle = timer(() => {
        if (settled) return
        timerCompleted = true
        settled = true
        cleanup()
        resolve()
      }, milliseconds)
      timerArmed = true
    } catch (error) {
      if (!settled) { settled = true; cleanup(); reject(error) }
      return
    }
    // Covers an injected timer that synchronously aborts during registration.
    if (signal?.aborted && !timerCompleted) {
      if (settled) clearTimer?.(handle)
      else onAbort()
    }
  })
}
