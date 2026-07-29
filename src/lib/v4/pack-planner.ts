export const PACK_MIN_CHANGED_FILES = 64
export const PACK_MAX_FILES = 500
export const PACK_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024
export const PACK_MAX_ENTRY_BYTES = 1024 * 1024

export interface V4PackCandidateMeta {
  fileId: string
  path: string
  size: number
}

function folderOf(path: string): string {
  return path.split("/").slice(0, -1).join("/")
}

export function planV4PackGroups(
  candidates: readonly V4PackCandidateMeta[],
  options: { maxPlaintextBytes?: number } = {},
): V4PackCandidateMeta[][] {
  const maxPlaintextBytes = Math.min(PACK_MAX_PLAINTEXT_BYTES, options.maxPlaintextBytes ?? PACK_MAX_PLAINTEXT_BYTES)
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1) throw new TypeError("maxPlaintextBytes must be a positive safe integer")
  const eligible = candidates.filter(candidate => candidate.size <= PACK_MAX_ENTRY_BYTES && candidate.size <= maxPlaintextBytes)
  if (eligible.length < PACK_MIN_CHANGED_FILES) return []
  const groups: V4PackCandidateMeta[][] = []
  for (let start = 0; start < eligible.length;) {
    const folder = folderOf(eligible[start].path)
    const group: V4PackCandidateMeta[] = []
    let bytes = 0
    while (start < eligible.length && group.length < PACK_MAX_FILES) {
      const candidate = eligible[start]
      if (group.length > 0 && folderOf(candidate.path) !== folder) break
      if (group.length > 0 && bytes + candidate.size > maxPlaintextBytes) break
      group.push(candidate)
      bytes += candidate.size
      start++
    }
    groups.push(group)
  }
  return groups
}
