type V4IntervalTimers = {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}

/** Only select Node timers at runtime on Desktop. Mobile never resolves Node. */
export function startV4PlatformInterval(
  desktop: boolean,
  callback: () => void,
  milliseconds: number,
  overrides?: { browser: V4IntervalTimers; node?: V4IntervalTimers },
): () => void {
  const timers: V4IntervalTimers = desktop
    ? overrides?.node ?? {
      set: (cb, ms) => require("node:timers").setInterval(cb, ms),
      clear: handle => require("node:timers").clearInterval(handle),
    }
    : overrides?.browser ?? {
      set: (cb, ms) => window.setInterval(cb, ms),
      clear: handle => window.clearInterval(handle as number),
    }
  const handle = timers.set(callback, milliseconds)
  return () => timers.clear(handle)
}


/** A one-shot wake can be canceled at unload and uses the native Node clock
 * only on Desktop; no Node module is ever resolved by Mobile.
 */
export function startV4PlatformTimeout(
  desktop: boolean,
  callback: () => void,
  milliseconds: number,
  overrides?: { browser: V4IntervalTimers; node?: V4IntervalTimers },
): () => void {
  const timers: V4IntervalTimers = desktop
    ? overrides?.node ?? {
      set: (cb, ms) => require("node:timers").setTimeout(cb, ms),
      clear: handle => require("node:timers").clearTimeout(handle),
    }
    : overrides?.browser ?? {
      set: (cb, ms) => window.setTimeout(cb, ms),
      clear: handle => window.clearTimeout(handle as number),
    }
  const handle = timers.set(callback, milliseconds)
  return () => timers.clear(handle)
}
