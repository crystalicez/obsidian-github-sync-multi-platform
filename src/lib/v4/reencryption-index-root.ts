/**
 * Obsidian's existing V4 Index lives at this single component within the
 * plugin-private adapter namespace. Re-encryption must reuse it unchanged.
 * Do not interpret this as a vault-root or filesystem-absolute path.
 */
export const V4_RUNTIME_INDEX_ROOT = "github-sync-v4-index"

const SEGMENT = /^[A-Za-z0-9_.-]+$/u

/**
 * Preserve D134+ nested-root contracts and additionally accept only the one
 * proven production Source root. Arbitrary single-component roots stay invalid.
 */
export function isSafeV4ReencryptionSourceIndexRoot(root: unknown): root is string {
  if (typeof root !== "string") return false
  if (root === V4_RUNTIME_INDEX_ROOT) return true
  const segments = root.split("/")
  return segments.length >= 2
    && segments.every(segment => SEGMENT.test(segment)
      && segment !== "." && segment !== "..")
}
