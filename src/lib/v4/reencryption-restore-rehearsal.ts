import { throwIfV4Aborted } from "./cancellation"
import { createV4IncrementalSha256 } from "./incremental-hash"
import { verifyV4ReencryptionBackupReadback, type V4ReencryptionBackupReadbackInput } from "./reencryption-backup-readback"
import type { V4StagedSink, V4StageRef, V4StagingStore } from "./staging-store"

const CHUNK_BYTES = 1024 * 1024

/**
 * BACKUP REHEARSAL ONLY. This may write to an isolated, explicitly provided
 * staging store; it must NEVER target the live Obsidian vault or migration
 * destination. The caller is responsible for enforcing physical isolation.
 *
 * D84 checks snapshot contents first; then D85 restores one file at a time
 * into scratch storage, reads the bytes back independently, and hashes them.
 * All scratch files are removed on success and ordinary error paths.
 * A process crash or cleanup failure still requires manual scratch inspection.
 */
export interface V4ReencryptionRestoreRehearsalInput extends V4ReencryptionBackupReadbackInput {
  readonly scratch: V4StagingStore
  /** Fail-closed caller guard against targeting the live vault. This is NOT physical proof. */
  readonly assertScratchIsIsolated: () => Promise<void>
}

export interface V4ReencryptionRestoreRehearsalReport {
  readonly integrityScope: "isolated-scratch-restore-roundtrip-only"
  readonly pinnedSourceCommitSha: string
  readonly roundTripFileCount: number
  readonly roundTripPlaintextBytes: string
  readonly scratchReadbackMatched: true
  readonly independentStorageVerified: false
  readonly installedObsidianRestoreVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
}

function assertStream(source: { size: number; chunks: unknown }, expectedSize: number): void {
  if (!source || source.size !== expectedSize || typeof source.chunks !== "function") {
    throw new Error("Backup rehearsal source or scratch readback size/stream is invalid.")
  }
}

async function digestSource(
  source: { size: number; chunks(chunkBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array> },
  expectedSize: number,
  signal?: AbortSignal,
  sink?: V4StagedSink,
): Promise<string> {
  assertStream(source, expectedSize)
  const hash = createV4IncrementalSha256()
  let size = 0
  for await (const chunk of source.chunks(CHUNK_BYTES, signal)) {
    throwIfV4Aborted(signal)
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1
      || chunk.byteLength > CHUNK_BYTES || size + chunk.byteLength > expectedSize) {
      throw new Error("Backup rehearsal stream returned invalid or excessive bytes.")
    }
    hash.update(chunk)
    if (sink) await sink.append(chunk)
    size += chunk.byteLength
  }
  throwIfV4Aborted(signal)
  if (size !== expectedSize) throw new Error("Backup rehearsal stream is truncated or wrong size.")
  return hash.digestHex()
}

export async function verifyV4ReencryptionBackupRestoreRehearsal(
  input: V4ReencryptionRestoreRehearsalInput,
): Promise<V4ReencryptionRestoreRehearsalReport> {
  throwIfV4Aborted(input.signal)
  if (!input.scratch || typeof input.scratch.beginStage !== "function"
    || typeof input.scratch.open !== "function"
    || typeof input.scratch.remove !== "function"
    || typeof input.assertScratchIsIsolated !== "function") {
    throw new Error("Backup rehearsal requires an explicitly isolated scratch store.")
  }
  await input.assertScratchIsIsolated()
  throwIfV4Aborted(input.signal)
  // Authenticate entire source snapshot and every backed-up plaintext byte
  // before a single scratch stage is created.
  const backupProof = await verifyV4ReencryptionBackupReadback(input)
  throwIfV4Aborted(input.signal)
  await input.assertScratchIsIsolated()
  const expected = Object.values(input.shards).flatMap(shard =>
    Object.values(shard.records).filter(record => !record.deleted))
    .sort((a, b) => a.pathId.localeCompare(b.pathId))
  if (expected.length !== backupProof.matchedLiveFileCount) {
    throw new Error("Backup rehearsal source inventory changed after preflight.")
  }

  let count = 0
  let total = BigInt(0)
  for (const record of expected) {
    throwIfV4Aborted(input.signal)
    await input.assertScratchIsIsolated()
    throwIfV4Aborted(input.signal)
    let opened: V4StagedSink | undefined
    let staged: V4StageRef | undefined
    let stageError: unknown
    try {
      if (await input.backup.readCurrentSnapshotId() !== input.backup.snapshotId
        || await input.readCurrentSourceHeadSha() !== input.pinnedSourceCommitSha) {
        throw new Error("Backup rehearsal source or snapshot changed before staging.")
      }
      const source = await input.backup.openFile(record.path, record.size)
      throwIfV4Aborted(input.signal)
      assertStream(source, record.size)
      opened = await input.scratch.beginStage({
        expectedSize: record.size, mtime: record.mtime, existingTargetBytes: 0,
        atomicReplace: true, ...(input.signal ? { signal: input.signal } : {}),
      })
      // Bounded 1 MiB appends; no whole-file in-memory staging copy.
      const copiedSha = await digestSource(source, record.size, input.signal, opened)
      if (copiedSha !== record.plaintextSha256) {
        throw new Error("Backup rehearsal source bytes changed since preflight.")
      }
      staged = await opened.finish({ plaintextSha256: copiedSha, size: record.size })
      opened = undefined
      await input.assertScratchIsIsolated()
      throwIfV4Aborted(input.signal)
      const replay = await input.scratch.open(staged)
      const restoredSha = await digestSource(replay, record.size, input.signal)
      if (restoredSha !== record.plaintextSha256) {
        throw new Error("Backup rehearsal scratch restore readback SHA-256 mismatch.")
      }
      if (await input.backup.readCurrentSnapshotId() !== input.backup.snapshotId) {
        throw new Error("Backup rehearsal snapshot changed during restored-file readback.")
      }
      count++
      total += BigInt(record.size)
    } catch (error) {
      stageError = error
      throw error
    } finally {
      // Scratch output never becomes a committed vault file. Cleanup is
      // mandatory on success and ordinary failures; do not swallow errors.
      if (staged) {
        await input.scratch.remove(staged)
      } else if (opened) {
        try { await opened.abort() }
        catch (error) {
          if (stageError === undefined) throw error
          throw new Error("Backup rehearsal failed and scratch abort also failed.", { cause: error })
        }
      }
    }
  }
  throwIfV4Aborted(input.signal)
  await input.assertScratchIsIsolated()
  if (await input.backup.readCurrentSnapshotId() !== input.backup.snapshotId
    || await input.readCurrentSourceHeadSha() !== input.pinnedSourceCommitSha
    || count !== backupProof.matchedLiveFileCount
    || total.toString() !== backupProof.verifiedPlaintextBytes) {
    throw new Error("Backup rehearsal complete-vault readback or source pin changed.")
  }
  return Object.freeze({
    integrityScope: "isolated-scratch-restore-roundtrip-only",
    pinnedSourceCommitSha: input.pinnedSourceCommitSha,
    roundTripFileCount: count,
    roundTripPlaintextBytes: total.toString(),
    scratchReadbackMatched: true,
    independentStorageVerified: false,
    installedObsidianRestoreVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
}
