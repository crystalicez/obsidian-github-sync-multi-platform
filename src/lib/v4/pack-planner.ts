import { estimateV4GitBlobTransportBytes } from "./resource-controller"

export const PACK_MIN_CHANGED_FILES = 64
export const PACK_MAX_FILES = 500
export const PACK_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024
export const PACK_MAX_ENTRY_BYTES = 1024 * 1024
const PACK_PAYLOAD_OVERHEAD_BYTES = 33
const PACK_ARCHIVE_PREFIX_BYTES = new TextEncoder().encode('{"version":1,"entries":{').byteLength
const PACK_ARCHIVE_SUFFIX_BYTES = new TextEncoder().encode('}}').byteLength

export interface V4PackCandidateMeta {
  fileId: string
  path: string
  size: number
}

export interface V4PackGroupResources {
  plaintextBytes: number
  archiveBytes: number
  ciphertextBytes: number
  base64ScratchBytes: number
  residentBytes: number
  transportBytes: number
}

function folderOf(path: string): string {
  return path.split("/").slice(0, -1).join("/")
}

function base64Bytes(size: number): number {
  return 4 * Math.ceil(size / 3)
}

function jsonKeyBytes(fileId: string): number {
  return new TextEncoder().encode(JSON.stringify(fileId)).byteLength
}

export function estimateV4PackGroupResources(candidates: readonly V4PackCandidateMeta[]): V4PackGroupResources {
  let plaintextBytes = 0
  let archiveBytes = PACK_ARCHIVE_PREFIX_BYTES + PACK_ARCHIVE_SUFFIX_BYTES
  let largestEntryBase64Bytes = 0
  for (const [index, candidate] of candidates.entries()) {
    if (!Number.isSafeInteger(candidate.size) || candidate.size < 0) throw new TypeError("V4 pack candidate size must be a non-negative safe integer")
    const encoded = base64Bytes(candidate.size)
    plaintextBytes += candidate.size
    largestEntryBase64Bytes = Math.max(largestEntryBase64Bytes, encoded)
    archiveBytes += (index > 0 ? 1 : 0) + jsonKeyBytes(candidate.fileId) + 2 + encoded + 1
  }
  const ciphertextBytes = archiveBytes + PACK_PAYLOAD_OVERHEAD_BYTES
  const base64ScratchBytes = largestEntryBase64Bytes * 2
  return {
    plaintextBytes,
    archiveBytes,
    ciphertextBytes,
    base64ScratchBytes,
    residentBytes: plaintextBytes + archiveBytes + ciphertextBytes + base64ScratchBytes,
    transportBytes: estimateV4GitBlobTransportBytes(ciphertextBytes),
  }
}

function assertOptionalBudget(value: number | undefined, label: string): number {
  if (value === undefined) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return value
}

export function planV4PackGroups(
  candidates: readonly V4PackCandidateMeta[],
  options: {
    maxPlaintextBytes?: number
    maxResidentBytes?: number
    maxTransportTransientBytes?: number
  } = {},
): V4PackCandidateMeta[][] {
  const maxPlaintextBytes = Math.min(PACK_MAX_PLAINTEXT_BYTES, options.maxPlaintextBytes ?? PACK_MAX_PLAINTEXT_BYTES)
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1) throw new TypeError("maxPlaintextBytes must be a positive safe integer")
  const maxResidentBytes = assertOptionalBudget(options.maxResidentBytes, "maxResidentBytes")
  const maxTransportTransientBytes = assertOptionalBudget(options.maxTransportTransientBytes, "maxTransportTransientBytes")
  const withinBudgets = (group: readonly V4PackCandidateMeta[]): boolean => {
    const budget = estimateV4PackGroupResources(group)
    return budget.plaintextBytes <= maxPlaintextBytes
      && budget.residentBytes <= maxResidentBytes
      && budget.transportBytes <= maxTransportTransientBytes
  }
  const eligible = candidates.filter(candidate => candidate.size <= PACK_MAX_ENTRY_BYTES && withinBudgets([candidate]))
  if (eligible.length < PACK_MIN_CHANGED_FILES) return []
  const groups: V4PackCandidateMeta[][] = []
  for (let start = 0; start < eligible.length;) {
    const folder = folderOf(eligible[start].path)
    const group: V4PackCandidateMeta[] = []
    while (start < eligible.length && group.length < PACK_MAX_FILES) {
      const candidate = eligible[start]
      if (group.length > 0 && folderOf(candidate.path) !== folder) break
      if (group.length > 0 && !withinBudgets([...group, candidate])) break
      group.push(candidate)
      start++
    }
    groups.push(group)
  }
  return groups
}
