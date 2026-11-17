// Shared same-process best-effort exclusion for Mobile WAL readers and
// writers on the same live Vault Adapter. NOT an OS lock, durable fence or
// authority for cross-process writes, Sync resumption or Cutover.
const activeAdapters = new WeakSet<object>()

export function tryReserveV4MobileWalAdapter(adapter: object): (() => void) | null {
  if (activeAdapters.has(adapter)) return null
  activeAdapters.add(adapter)
  let released = false
  return () => {
    // A stale/repeated release must never free a newer holder on this adapter.
    if (released) return
    released = true
    activeAdapters.delete(adapter)
  }
}

/** Keep read-only diagnostic call sites on the same shared reservation. */
export const tryReserveV4MobileRecoveryAdapter = tryReserveV4MobileWalAdapter
