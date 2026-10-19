import { estimateV4GitBlobTransportBytes } from "./resource-controller"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"

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

interface V4PackAccumulator {
  count: number
  plaintextBytes: number
  archiveBytes: number
  largestEntryBase64Bytes: number
}

function emptyV4PackAccumulator(): V4PackAccumulator {
  return {
    count: 0,
    plaintextBytes: 0,
    archiveBytes: PACK_ARCHIVE_PREFIX_BYTES + PACK_ARCHIVE_SUFFIX_BYTES,
    largestEntryBase64Bytes: 0,
  }
}

function appendV4PackCandidate(state: V4PackAccumulator, candidate: V4PackCandidateMeta): V4PackAccumulator {
  if (!Number.isSafeInteger(candidate.size) || candidate.size < 0) throw new TypeError("V4 pack candidate size must be a non-negative safe integer")
  const encoded = base64Bytes(candidate.size)
  return {
    count: state.count + 1,
    plaintextBytes: state.plaintextBytes + candidate.size,
    archiveBytes: state.archiveBytes + (state.count > 0 ? 1 : 0) + jsonKeyBytes(candidate.fileId) + 2 + encoded + 1,
    largestEntryBase64Bytes: Math.max(state.largestEntryBase64Bytes, encoded),
  }
}

function packResources(state: V4PackAccumulator): V4PackGroupResources {
  const ciphertextBytes = state.archiveBytes + PACK_PAYLOAD_OVERHEAD_BYTES
  const base64ScratchBytes = state.largestEntryBase64Bytes * 2
  return {
    plaintextBytes: state.plaintextBytes,
    archiveBytes: state.archiveBytes,
    ciphertextBytes,
    base64ScratchBytes,
    residentBytes: state.plaintextBytes + state.archiveBytes + ciphertextBytes + base64ScratchBytes,
    transportBytes: estimateV4GitBlobTransportBytes(ciphertextBytes),
  }
}

export function estimateV4PackGroupResources(candidates: readonly V4PackCandidateMeta[]): V4PackGroupResources {
  let state = emptyV4PackAccumulator()
  for (const candidate of candidates) state = appendV4PackCandidate(state, candidate)
  return packResources(state)
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
  const withinBudgets = (state: V4PackAccumulator): boolean => {
    const budget = packResources(state)
    return budget.plaintextBytes <= maxPlaintextBytes
      && budget.ciphertextBytes <= V4_GITHUB_REST_SAFE_WRITER_BYTES
      && budget.residentBytes <= maxResidentBytes
      && budget.transportBytes <= maxTransportTransientBytes
  }
  const empty = emptyV4PackAccumulator()
  const eligible = candidates.filter(candidate => candidate.size <= PACK_MAX_ENTRY_BYTES
    && withinBudgets(appendV4PackCandidate(empty, candidate)))
  if (eligible.length < PACK_MIN_CHANGED_FILES) return []
  const groups: V4PackCandidateMeta[][] = []
  for (let start = 0; start < eligible.length;) {
    const folder = folderOf(eligible[start].path)
    const group: V4PackCandidateMeta[] = []
    let resources = empty
    while (start < eligible.length && group.length < PACK_MAX_FILES) {
      const candidate = eligible[start]
      if (group.length > 0 && folderOf(candidate.path) !== folder) break
      const nextResources = appendV4PackCandidate(resources, candidate)
      if (group.length > 0 && !withinBudgets(nextResources)) break
      group.push(candidate)
      resources = nextResources
      start++
    }
    groups.push(group)
  }
  return groups
}
