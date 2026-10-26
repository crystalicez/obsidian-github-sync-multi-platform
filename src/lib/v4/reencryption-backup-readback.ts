import { throwIfV4Aborted } from "./cancellation"
import type { V4ContentSource } from "./content-source"
import { createV4IncrementalSha256 } from "./incremental-hash"
import { inspectV4ReencryptionInventory, type V4ReencryptionInventoryInput } from "./reencryption-inventory"
import { normalizeV4VaultPath } from "./paths"
import { assertV4LogicalPathSetSafe } from "./remote-index"

const SNAPSHOT_SHA = /^[0-9a-f]{64}$/u
const COMMIT_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const READ_CHUNK_BYTES = 1024 * 1024
const MAX_BACKUP_MANIFEST_FILES = 100_000

/**
 * A listing from an independent backup SNAPSHOT, not from the live vault.
 * The adapter must read an actual stored copy (and not proxy the live source).
 * This read-only helper cannot independently establish physical separation.
 */
export interface V4BackupSnapshotFile {
  readonly path: string
  readonly size: number
  readonly plaintextSha256: string
  readonly mtime: number
}

export interface V4BackupSnapshotReader {
  readonly snapshotId: string
  readonly sourceCommitSha: string
  readCurrentSnapshotId(): Promise<string | null>
  listFiles(): Promise<readonly V4BackupSnapshotFile[]>
  openFile(path: string, expectedSize: number): Promise<V4ContentSource>
}

export interface V4ReencryptionBackupReadbackInput extends V4ReencryptionInventoryInput {
  readonly backup: V4BackupSnapshotReader
  readonly readCurrentSourceHeadSha: () => Promise<string | null>
  /** D90: a backed-up immutable source snapshot is not invalidated by other devices
   * advancing the old branch HEAD. Explicitly opt in after snapshot pin validation. */
  readonly sourceRefPolicy?: "require-stable-head" | "pinned-immutable-commit" | undefined
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionBackupReadbackReport {
  readonly integrityScope: "backup-snapshot-content-parity-only"
  readonly pinnedSourceCommitSha: string
  readonly matchedLiveFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly sourceTombstoneCount: number
  readonly backupContentsMatchSource: true
  readonly independentStorageVerified: false
  readonly restoreTested: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
}

function assertStableSnapshot(observed: string | null, expected: string): void {
  if (observed !== expected) throw new Error("Re-encryption backup snapshot changed or cannot be read safely.")
}

function assertStableHead(observed: string | null, expected: string): void {
  if (observed !== expected) throw new Error("Re-encryption backup verification source HEAD changed or cannot be verified.")
}

function assertBackupFile(value: V4BackupSnapshotFile): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.path !== "string"
    || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.plaintextSha256 !== "string" || !SHA256.test(value.plaintextSha256)
    || typeof value.mtime !== "number" || !Number.isFinite(value.mtime)) {
    throw new Error("Re-encryption backup snapshot file metadata is invalid.")
  }
  try {
    if (normalizeV4VaultPath(value.path) !== value.path) {
      throw new Error("backup path is not normalized")
    }
  } catch {
    throw new Error("Re-encryption backup snapshot contains an unsafe logical path.")
  }
}

/**
 * Compare a separate snapshot's COMPLETE logical manifest and stream every
 * backed-up plaintext file against the authenticated original remote index.
 * NEVER writes a vault, modifies backup files, or certifies where they live.
 */
export async function verifyV4ReencryptionBackupReadback(
  input: V4ReencryptionBackupReadbackInput,
): Promise<V4ReencryptionBackupReadbackReport> {
  throwIfV4Aborted(input.signal)
  if (input.sourceRefPolicy !== undefined
    && input.sourceRefPolicy !== "require-stable-head"
    && input.sourceRefPolicy !== "pinned-immutable-commit") {
    throw new Error("Invalid frozen backup source ref policy.")
  }
  const stableSourceHeadRequired = input.sourceRefPolicy !== "pinned-immutable-commit"
  if (!input.backup || !SNAPSHOT_SHA.test(input.backup.snapshotId)
    || !COMMIT_SHA.test(input.pinnedSourceCommitSha)
    || input.backup.sourceCommitSha !== input.pinnedSourceCommitSha) {
    throw new Error("Re-encryption backup source/snapshot identity is not pinned to the approved original commit.")
  }
  // Authenticate the WHOLE source index before opening any copy of the backup.
  const source = await inspectV4ReencryptionInventory(input)
  throwIfV4Aborted(input.signal)
  const originalFiles = new Map<string, V4BackupSnapshotFile>()
  let deletedCount = 0
  for (const shard of Object.values(input.shards)) {
    for (const record of Object.values(shard.records)) {
      if (record.deleted) { deletedCount++; continue }
      originalFiles.set(record.path, {
        path: record.path, size: record.size,
        plaintextSha256: record.plaintextSha256, mtime: record.mtime,
      })
    }
  }
  if (originalFiles.size !== source.fileCount || originalFiles.size > MAX_BACKUP_MANIFEST_FILES) {
    throw new Error("Re-encryption backup source inventory exceeds the bounded full-readback limit.")
  }
  if (stableSourceHeadRequired) {
    assertStableHead(await input.readCurrentSourceHeadSha(), input.pinnedSourceCommitSha)
  }
  throwIfV4Aborted(input.signal)
  assertStableSnapshot(await input.backup.readCurrentSnapshotId(), input.backup.snapshotId)
  throwIfV4Aborted(input.signal)

  const files = await input.backup.listFiles()
  throwIfV4Aborted(input.signal)
  if (!Array.isArray(files) || files.length !== originalFiles.size) {
    throw new Error("Re-encryption backup snapshot has missing or extra files.")
  }
  for (const entry of files) assertBackupFile(entry)
  // The shared V4 path rules reject unsafe paths, case/canonical aliases,
  // file/directory topology collisions and duplicate logical paths.
  assertV4LogicalPathSetSafe(files.map(file => file.path))
  const listed = new Map(files.map(file => [file.path, file]))
  if (listed.size !== originalFiles.size) throw new Error("Re-encryption backup snapshot duplicated a file.")
  for (const [path, expected] of originalFiles) {
    const found = listed.get(path)
    if (!found || found.size !== expected.size
      || found.plaintextSha256 !== expected.plaintextSha256
      || found.mtime !== expected.mtime) {
      throw new Error("Re-encryption backup snapshot file identity/hash/size/mtime mismatch.")
    }
  }
  throwIfV4Aborted(input.signal)
  assertStableSnapshot(await input.backup.readCurrentSnapshotId(), input.backup.snapshotId)

  let count = 0
  let bytesReadTotal = BigInt(0)
  for (const expected of originalFiles.values()) {
    throwIfV4Aborted(input.signal)
    const opened = await input.backup.openFile(expected.path, expected.size)
    throwIfV4Aborted(input.signal)
    if (!opened || opened.size !== expected.size
      || !Number.isSafeInteger(opened.size) || opened.size < 0
      || typeof opened.chunks !== "function") {
      throw new Error("Re-encryption backup content stream size changed or is invalid.")
    }
    const hasher = createV4IncrementalSha256()
    let readBytes = 0
    for await (const chunk of opened.chunks(READ_CHUNK_BYTES, input.signal)) {
      throwIfV4Aborted(input.signal)
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1
        || chunk.byteLength > READ_CHUNK_BYTES || readBytes + chunk.byteLength > expected.size) {
        throw new Error("Re-encryption backup returned invalid or excessive streamed bytes.")
      }
      hasher.update(chunk)
      readBytes += chunk.byteLength
    }
    throwIfV4Aborted(input.signal)
    if (readBytes !== expected.size || hasher.digestHex() !== expected.plaintextSha256) {
      throw new Error("Re-encryption backup plaintext SHA-256 or size does not match the original.")
    }
    count++
    bytesReadTotal += BigInt(readBytes)
  }
  throwIfV4Aborted(input.signal)
  assertStableSnapshot(await input.backup.readCurrentSnapshotId(), input.backup.snapshotId)
  throwIfV4Aborted(input.signal)
  if (stableSourceHeadRequired) {
    assertStableHead(await input.readCurrentSourceHeadSha(), input.pinnedSourceCommitSha)
  }
  if (count !== source.fileCount || bytesReadTotal.toString() !== source.totalLogicalBytes) {
    throw new Error("Re-encryption backup entire-vault plaintext totals do not match.")
  }
  return Object.freeze({
    integrityScope: "backup-snapshot-content-parity-only",
    pinnedSourceCommitSha: input.pinnedSourceCommitSha,
    matchedLiveFileCount: count,
    verifiedPlaintextBytes: bytesReadTotal.toString(),
    sourceTombstoneCount: deletedCount,
    backupContentsMatchSource: true,
    independentStorageVerified: false,
    restoreTested: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
}
