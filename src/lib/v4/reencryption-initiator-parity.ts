import { throwIfV4Aborted } from "./cancellation"
import { createV4IncrementalSha256 } from "./incremental-hash"
import type { V4IndexFileRecord } from "./local-index"
import type { V4ReencryptionVerifiedSource } from "./reencryption-content-verifier"

const SHA = /^[0-9a-f]{64}$/u
const GIT_SHA = /^[0-9a-f]{40}$/u
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

export interface V4InitiatingFile {
  readonly path: string
  readonly size: number
  /** Local device clock is not assumed equal to GitHub's source mtime. */
  readonly mtime: number
}

export interface V4InitiatorLocalReader {
  /** List all physical files in the *captured* sync scope, no cache-only data. */
  listFiles(): Promise<readonly V4InitiatingFile[]>
  /** Must read physical bytes rather than unsaved editor text or cached data. */
  openFile(path: string): Promise<{
    readonly size: number
    chunks(chunkSize: number, signal?: AbortSignal): AsyncIterable<Uint8Array>
  }>
  /** Fail closed if an editor has any open source file, even if saved. */
  listOpenEditorPaths(): Promise<readonly string[]>
  /** Real runtime-level Sync/Recovery/edit-queue guard. */
  assertIdleAndNoPendingEdits(): Promise<void>
  /** Unchanged source connection, captured ignore rules and owner device identity. */
  assertSourceConfigurationUnchanged(): Promise<void>
  /** OS process-local migration lease; caller must enforce it, not just assert boolean. */
  assertExclusiveInitiatorLease(): Promise<void>
}

export interface V4ReencryptionInitiatorParityInput {
  readonly pinnedSourceCommitSha: string
  readonly verifiedSource: V4ReencryptionVerifiedSource
  /** Authenticated remote records decoded from exactly pinned source commit. */
  readonly sourceRecords: readonly V4IndexFileRecord[]
  readonly reader: V4InitiatorLocalReader
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionInitiatorParityReport {
  readonly integrityScope: "initiator-live-vault-exact-pinned-source-parity"
  readonly pinnedSourceCommitSha: string
  readonly checkedFileCount: number
  readonly checkedPlaintextBytes: string
  readonly allFilesContentVerified: true
  readonly noUnexpectedLocalFiles: true
  readonly noOpenEditorsObserved: true
  readonly initiatorLocalCutoverAuthorized: false
}

/**
 * Read-only D105 initiating-device proof. This is not a write lease or
 * guarantee that a file cannot mutate milliseconds AFTER the final sample.
 * A future cutover transaction must retain a real event/IO fence and invoke
 * this immediately before local index/settings changes.
 *
 * Do not trust an "already verified" boolean from a UI, and do not compare
 * local mtimes to remote mtimes (other devices have different clocks).
 */
export async function verifyV4ReencryptionInitiatorLocalParity(
  input: V4ReencryptionInitiatorParityInput,
): Promise<V4ReencryptionInitiatorParityReport> {
  throwIfV4Aborted(input.signal)
  const { verifiedSource, reader, sourceRecords, pinnedSourceCommitSha } = input
  if (!GIT_SHA.test(pinnedSourceCommitSha)
    || verifiedSource?.integrityScope !== "all-live-objects"
    || verifiedSource.pinnedSourceCommitSha !== pinnedSourceCommitSha
    || !Number.isSafeInteger(verifiedSource.verifiedFileCount)
    || verifiedSource.verifiedFileCount < 0
    || !/^(?:0|[1-9][0-9]*)$/u.test(verifiedSource.totalVerifiedPlaintextBytes)
    || !Array.isArray(sourceRecords)
    || typeof reader?.listFiles !== "function"
    || typeof reader.openFile !== "function"
    || typeof reader.listOpenEditorPaths !== "function"
    || typeof reader.assertIdleAndNoPendingEdits !== "function"
    || typeof reader.assertSourceConfigurationUnchanged !== "function"
    || typeof reader.assertExclusiveInitiatorLease !== "function") {
    throw new Error("Re-encryption initiator needs authenticated source records and trusted live-vault reader.")
  }

  const expected = new Map<string, V4IndexFileRecord>()
  const expectedCanonical = new Map<string, string>()
  let expectedTotal = BigInt(0)
  for (const record of sourceRecords) {
    if (record.deleted || !record.path || !Number.isSafeInteger(record.size)
      || record.size < 0 || !SHA.test(record.plaintextSha256)) {
      throw new Error("Re-encryption initiator source record identity, hash or size invalid.")
    }
    const canonical = record.path.normalize("NFC").toLowerCase()
    if (record.path.startsWith("/") || record.path.includes("\\")
      || record.path.split("/").some((part: string) => !part || part === "." || part === "..")
      || expectedCanonical.has(canonical) || expected.has(record.path)) {
      throw new Error("Re-encryption initiator source paths are ambiguous or unsafe.")
    }
    expected.set(record.path, record)
    expectedCanonical.set(canonical, record.path)
    expectedTotal += BigInt(record.size)
  }
  if (sourceRecords.length !== verifiedSource.verifiedFileCount
    || expectedTotal.toString() !== verifiedSource.totalVerifiedPlaintextBytes) {
    throw new Error("Re-encryption initiator remote source inventory differs from authenticated totals.")
  }

  const fence = async () => {
    throwIfV4Aborted(input.signal)
    await reader.assertExclusiveInitiatorLease()
    throwIfV4Aborted(input.signal)
    await reader.assertIdleAndNoPendingEdits()
    throwIfV4Aborted(input.signal)
    await reader.assertSourceConfigurationUnchanged()
    throwIfV4Aborted(input.signal)
    const open = await reader.listOpenEditorPaths()
    throwIfV4Aborted(input.signal)
    if (!Array.isArray(open) || open.some(path => typeof path !== "string")
      || open.some(path => expectedCanonical.has(path.normalize("NFC").toLowerCase()))) {
      throw new Error("Re-encryption initiator cannot verify cutover with a source file open in an editor.")
    }
  }

  const observe = async (): Promise<Map<string, V4InitiatingFile>> => {
    await fence()
    const listed = await reader.listFiles()
    throwIfV4Aborted(input.signal)
    if (!Array.isArray(listed)) {
      throw new Error("Re-encryption initiator physical vault listing unavailable.")
    }
    const map = new Map<string, V4InitiatingFile>()
    const folded = new Set<string>()
    for (const file of listed) {
      if (!file || typeof file.path !== "string"
        || !Number.isSafeInteger(file.size) || file.size < 0
        || !Number.isFinite(file.mtime) || file.mtime < 0) {
        throw new Error("Re-encryption initiator invalid local file metadata.")
      }
      const canonical = file.path.normalize("NFC").toLowerCase()
      if (file.path.startsWith("/") || file.path.includes("\\")
        || file.path.split("/").some((part: string) => !part || part === "." || part === "..")
        || folded.has(canonical)) {
        throw new Error("Re-encryption initiator ambiguous local file path.")
      }
      folded.add(canonical)
      const remote = expected.get(file.path)
      if (!remote || remote.size !== file.size) {
        throw new Error("Re-encryption initiator contains an unexpected, missing, or changed local file.")
      }
      map.set(file.path, file)
    }
    if (map.size !== expected.size) {
      throw new Error("Re-encryption initiator physical vault has missing remote source files.")
    }
    return map
  }

  const start = await observe()
  let bytesVerified = BigInt(0)
  for (const [path, record] of expected) {
    await fence()
    const opened = await reader.openFile(path)
    throwIfV4Aborted(input.signal)
    if (!opened || opened.size !== record.size || typeof opened.chunks !== "function") {
      throw new Error("Re-encryption initiator local file size or stream changed.")
    }
    let read = 0
    const hasher = createV4IncrementalSha256()
    for await (const chunk of opened.chunks(MAX_CHUNK_BYTES, input.signal)) {
      throwIfV4Aborted(input.signal)
      if (!(chunk instanceof Uint8Array) || !chunk.byteLength
        || chunk.byteLength > MAX_CHUNK_BYTES || read + chunk.byteLength > record.size) {
        throw new Error("Re-encryption initiator local content chunk is invalid or too large.")
      }
      hasher.update(chunk)
      read += chunk.byteLength
    }
    throwIfV4Aborted(input.signal)
    if (read !== record.size || hasher.digestHex() !== record.plaintextSha256) {
      throw new Error("Re-encryption initiator local content does not match authenticated source SHA-256.")
    }
    bytesVerified += BigInt(read)
  }
  const end = await observe()
  if (bytesVerified.toString() !== verifiedSource.totalVerifiedPlaintextBytes
    || end.size !== start.size
    || [...start].some(([path, first]) => {
      const last = end.get(path)
      return !last || last.size !== first.size || last.mtime !== first.mtime
    })) {
    throw new Error("Re-encryption initiator local vault changed during the full parity scan.")
  }
  await fence()
  return Object.freeze({
    integrityScope: "initiator-live-vault-exact-pinned-source-parity",
    pinnedSourceCommitSha,
    checkedFileCount: end.size,
    checkedPlaintextBytes: bytesVerified.toString(),
    allFilesContentVerified: true,
    noUnexpectedLocalFiles: true,
    noOpenEditorsObserved: true,
    initiatorLocalCutoverAuthorized: false,
  })
}
