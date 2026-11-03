// Same-process best-effort exclusion for read-only Mobile recovery only.
// This is not an OS lock and cannot guard another Obsidian process.
const activeAdapters = new WeakSet<object>()

export function tryReserveV4MobileRecoveryAdapter(adapter: object): (() => void) | null {
  if (activeAdapters.has(adapter)) return null
  activeAdapters.add(adapter)
  return () => { activeAdapters.delete(adapter) }
}
