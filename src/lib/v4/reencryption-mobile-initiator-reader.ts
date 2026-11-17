import { throwIfV4Aborted } from "./cancellation"
import { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } from "./content-source"
import { normalizeV4VaultPath } from "./paths"
import type { V4InitiatorLocalReader, V4InitiatingFile, V4InitiatorSourceRecord } from "./reencryption-initiator-parity"
import { createV4ScopePredicate, type V4ScopeSettings } from "./scope"

const MAX_ENTRIES = 100_000
const MAX_DEPTH = 64
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

type MobileStats = { type: "file" | "folder"; size: number; mtime: number }
type MobileListing = { files: string[]; folders: string[] }

export interface V4MobileInitiatorReaderInput {
  readonly adapter: {
    list(path: string): Promise<MobileListing>
    stat(path: string): Promise<MobileStats | null>
    readBinary(path: string): Promise<ArrayBuffer>
  }
  readonly scope: Readonly<V4ScopeSettings>
  readonly assertExclusiveInitiatorLease: V4InitiatorLocalReader["assertExclusiveInitiatorLease"]
  readonly assertIdleAndNoPendingEdits: V4InitiatorLocalReader["assertIdleAndNoPendingEdits"]
  readonly assertSourceConfigurationUnchanged: V4InitiatorLocalReader["assertSourceConfigurationUnchanged"]
  readonly listOpenEditorPaths: V4InitiatorLocalReader["listOpenEditorPaths"]
}

function safePath(value: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC")
    || normalizeV4VaultPath(value) !== value) {
    throw new Error("Re-encryption Mobile adapter returned an unsafe or noncanonical path.")
  }
  return value
}

function safeChild(parent: string, child: string): string {
  const path = safePath(child)
  const prefix = parent ? parent + "/" : ""
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) {
    throw new Error("Re-encryption Mobile adapter returned a path outside its listed parent.")
  }
  return path
}

function requireStats(value: MobileStats | null, kind: MobileStats["type"]): MobileStats {
  if (!value || value.type !== kind || !Number.isSafeInteger(value.size)
    || value.size < 0 || !Number.isFinite(value.mtime) || value.mtime < 0) {
    throw new Error("Re-encryption Mobile adapter returned invalid file or directory metadata.")
  }
  // Capture primitive metadata, never a mutable adapter-owned object.
  return Object.freeze({ type: value.type, size: value.size, mtime: value.mtime })
}

function sameFile(a: MobileStats, b: MobileStats): boolean {
  return b.type === "file" && a.size === b.size && a.mtime === b.mtime
}

export const V4_MOBILE_REENCRYPTION_OVERSIZE_MESSAGE =
  "Mobile Re-encryption cannot start: an in-scope file exceeds the 32 MiB bounded whole-read limit. Initiate migration on Desktop. Large-file Mobile Sync needs separate acceptance."

export const V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE =
  "Mobile Re-encryption cannot start: physical Vault inventory differs from authenticated GitHub Source. Sync and reconcile the original Source before verifying again. Migration has not started."

type MobileMetadataAdapter = Pick<V4MobileInitiatorReaderInput["adapter"], "list" | "stat">

/** Physical DataAdapter metadata only. Never reads content or arms a Sync fence. */
async function listV4MobileScopedFileSizes(
  adapter: MobileMetadataAdapter,
  inScope: (path: string) => boolean,
  assertCurrent: () => Promise<void>,
): Promise<readonly V4InitiatingFile[]> {
  await assertCurrent()
  const discovered = new Set<string>()
  const files: V4InitiatingFile[] = []
  const dirs: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }]
  while (dirs.length) {
    const current = dirs.pop()!
    await assertCurrent()
    const listed = await adapter.list(current.path || "/")
    await assertCurrent()
    if (!listed || !Array.isArray(listed.files) || !Array.isArray(listed.folders)) {
      throw new Error("Re-encryption Mobile adapter returned an incomplete directory listing.")
    }
    for (const [kind, children] of [["folder", [...listed.folders]], ["file", [...listed.files]]] as const) {
      for (const child of children) {
        const path = safeChild(current.path, child)
        const folded = path.normalize("NFC").toLowerCase()
        if (discovered.has(folded) || discovered.size >= MAX_ENTRIES) {
          throw new Error("Re-encryption Mobile adapter detected duplicate, colliding or excessive paths.")
        }
        discovered.add(folded)
        if (kind === "folder") {
          if (current.depth >= MAX_DEPTH) {
            throw new Error("Re-encryption Mobile adapter directory depth exceeds the safe limit.")
          }
          await assertCurrent()
          requireStats(await adapter.stat(path), "folder")
          await assertCurrent()
          dirs.push({ path, depth: current.depth + 1 })
        } else if (inScope(path)) {
          await assertCurrent()
          const stat = requireStats(await adapter.stat(path), "file")
          await assertCurrent()
          if (stat.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
            throw new Error(V4_MOBILE_REENCRYPTION_OVERSIZE_MESSAGE)
          }
          files.push(Object.freeze({ path, size: stat.size, mtime: stat.mtime }))
        }
      }
    }
  }
  await assertCurrent()
  return Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path)))
}

/**
 * Read-only eligibility observation for Mobile initiation, not physical parity.
 * The caller owns Sync/settings/Recovery consistency checks and must repeat
 * authenticated full-file parity under a real lease before any publication.
 */
export async function inspectV4MobileReencryptionFileSizePreflight(input: {
  readonly adapter: MobileMetadataAdapter
  readonly scope: Readonly<V4ScopeSettings>
  readonly assertPreviewStable: () => Promise<void>
  /** Authenticated pinned-commit live source records, not an untrusted cached file list. */
  readonly expectedSourceFiles?: readonly Readonly<Pick<V4InitiatorSourceRecord, "path" | "size">>[] | undefined
}): Promise<{ readonly checkedFileCount: number }> {
  const adapter = input?.adapter
  const stable = input?.assertPreviewStable
  if (!adapter || typeof adapter.list !== "function" || typeof adapter.stat !== "function"
    || !input.scope || typeof stable !== "function") {
    throw new Error("Mobile Re-encryption requires an available physical file-size inventory.")
  }
  const methods = { list: adapter.list, stat: adapter.stat }
  const inScope = createV4ScopePredicate(Object.freeze({ ...input.scope }))
  // Capture authenticated records before the first async metadata probe. A
  // caller may otherwise change the supposed remote inventory during list().
  const sourceInput = input.expectedSourceFiles
  if (sourceInput !== undefined && !Array.isArray(sourceInput)) {
    throw new Error(V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE)
  }
  const sourceSnapshot = sourceInput?.map(record => ({
    path: record?.path, size: record?.size,
  }))
  const expected = sourceInput === undefined ? undefined : new Map<string, number>()
  if (expected) {
    const folded = new Set<string>()
    for (const record of sourceSnapshot!) {
      if (!record || typeof record.path !== "string"
        || !Number.isSafeInteger(record.size) || record.size < 0) {
        throw new Error(V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE)
      }
      let path: string
      try { path = safePath(record.path) }
      catch { throw new Error(V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE) }
      const canonical = path.normalize("NFC").toLowerCase()
      if (folded.has(canonical) || !inScope(path)) {
        throw new Error(V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE)
      }
      folded.add(canonical)
      if (record.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        throw new Error(V4_MOBILE_REENCRYPTION_OVERSIZE_MESSAGE)
      }
      expected.set(path, record.size)
    }
  }
  const assertCurrent = async () => {
    if (input.adapter !== adapter || adapter.list !== methods.list
      || adapter.stat !== methods.stat || input.assertPreviewStable !== stable) {
      throw new Error("Mobile Re-encryption metadata adapter or runtime guard changed.")
    }
    await stable()
    if (input.adapter !== adapter || adapter.list !== methods.list
      || adapter.stat !== methods.stat || input.assertPreviewStable !== stable) {
      throw new Error("Mobile Re-encryption metadata adapter or runtime guard changed.")
    }
  }
  const files = await listV4MobileScopedFileSizes(adapter, inScope, assertCurrent)
  if (expected) {
    if (input.expectedSourceFiles !== sourceInput
      || sourceInput!.length !== sourceSnapshot!.length
      || sourceInput!.some((record, index) => record?.path !== sourceSnapshot![index]?.path
        || record?.size !== sourceSnapshot![index]?.size)
      || files.length !== expected.size
      || files.some(file => expected.get(file.path) !== file.size)) {
      throw new Error(V4_MOBILE_REENCRYPTION_SOURCE_INVENTORY_MESSAGE)
    }
  }
  await assertCurrent()
  return Object.freeze({ checkedFileCount: files.length })
}

/**
 * Read-only, adapter-enumerated mobile Vault parity reader. Adapter.list("/")
 * is used instead of Obsidian's potentially stale getFiles() cache.
 * No OS-wide lock, physical symlink proof or atomic filesystem snapshot is
 * claimed. Larger files require a bounded-read adapter not available here.
 * This reader never authorizes Cutover or remote publication.
 */
export function createV4MobileInitiatorLocalReader(input: V4MobileInitiatorReaderInput): V4InitiatorLocalReader {
  const adapter = input?.adapter
  if (typeof adapter?.list !== "function" || typeof adapter.stat !== "function"
    || typeof adapter.readBinary !== "function" || !input.scope
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertIdleAndNoPendingEdits !== "function"
    || typeof input.assertSourceConfigurationUnchanged !== "function"
    || typeof input.listOpenEditorPaths !== "function") {
    throw new Error("Re-encryption Mobile parity requires adapter list/stat/readBinary and live runtime guards.")
  }
  const inScope = createV4ScopePredicate(Object.freeze({ ...input.scope }))
  const adapterMethods = { list: adapter.list, stat: adapter.stat, readBinary: adapter.readBinary }
  const liveGuards = {
    lease: input.assertExclusiveInitiatorLease,
    idle: input.assertIdleAndNoPendingEdits,
    source: input.assertSourceConfigurationUnchanged,
    editors: input.listOpenEditorPaths,
  }
  const assertAdapterOwner = () => {
    if (input.adapter !== adapter || adapter.list !== adapterMethods.list
      || adapter.stat !== adapterMethods.stat || adapter.readBinary !== adapterMethods.readBinary
      || input.assertExclusiveInitiatorLease !== liveGuards.lease
      || input.assertIdleAndNoPendingEdits !== liveGuards.idle
      || input.assertSourceConfigurationUnchanged !== liveGuards.source
      || input.listOpenEditorPaths !== liveGuards.editors) {
      throw new Error("Re-encryption Mobile Adapter or live guard changed during local parity.")
    }
  }

  const assertGuard = async (signal?: AbortSignal) => {
    assertAdapterOwner()
    throwIfV4Aborted(signal)
    await liveGuards.lease.call(input)
    await liveGuards.idle.call(input)
    await liveGuards.source.call(input)
    const open = await liveGuards.editors.call(input)
    if (!Array.isArray(open) || open.length) {
      throw new Error("Re-encryption Mobile cannot verify parity while an editor is open or unknown.")
    }
    // Obsidian's editor enumeration can yield to a complete Sync or lose
    // this run's migration lease/Source scope. Recheck AFTER its await before
    // touching DataAdapter stat/list or allocating the whole-file readBinary.
    // This is cooperative best-effort fencing, not an OS-wide write lock.
    assertAdapterOwner()
    throwIfV4Aborted(signal)
    await liveGuards.lease.call(input)
    throwIfV4Aborted(signal)
    await liveGuards.source.call(input)
    throwIfV4Aborted(signal)
    await liveGuards.idle.call(input)
    assertAdapterOwner()
    throwIfV4Aborted(signal)
  }

  return Object.freeze({
    assertExclusiveInitiatorLease: input.assertExclusiveInitiatorLease,
    assertIdleAndNoPendingEdits: input.assertIdleAndNoPendingEdits,
    assertSourceConfigurationUnchanged: input.assertSourceConfigurationUnchanged,
    listOpenEditorPaths: input.listOpenEditorPaths,
    async listFiles(): Promise<readonly V4InitiatingFile[]> {
      return listV4MobileScopedFileSizes(adapter, inScope, () => assertGuard())
    },
    async openFile(path: string) {
      safePath(path)
      if (!inScope(path)) throw new Error("Re-encryption Mobile reader cannot open excluded paths.")
      await assertGuard()
      const initial = requireStats(await adapter.stat(path), "file")
      if (initial.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        throw new Error(V4_MOBILE_REENCRYPTION_OVERSIZE_MESSAGE)
      }
      return Object.freeze({
        size: initial.size,
        async *chunks(chunkSize: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
          if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
            throw new Error("Re-encryption Mobile reader refuses an invalid chunk size.")
          }
          await assertGuard(signal)
          const before = requireStats(await adapter.stat(path), "file")
          if (!sameFile(initial, before)) throw new Error("Re-encryption Mobile file changed before hashing.")
          // stat() is asynchronous: a completed Sync, changed Source, lost
          // lease, or new editor can appear while the metadata is in flight.
          // Recheck before readBinary allocates the whole Mobile file.
          await assertGuard(signal)
          const buffer = await adapter.readBinary(path)
          throwIfV4Aborted(signal)
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== initial.size) {
            throw new Error("Re-encryption Mobile reader received changed or invalid bytes.")
          }
          const after = requireStats(await adapter.stat(path), "file")
          if (!sameFile(initial, after)) throw new Error("Re-encryption Mobile file changed during read.")
          await assertGuard(signal)
          const bytes = new Uint8Array(buffer)
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            // A consumer can yield control between chunks while the initiating
            // lease, Source or Sync generation changes. Recheck before giving
            // it another slice of an already allocated whole-file buffer.
            await assertGuard(signal)
            yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize))
          }
          const final = requireStats(await adapter.stat(path), "file")
          if (!sameFile(initial, final)) throw new Error("Re-encryption Mobile file changed during hashing.")
          await assertGuard(signal)
        },
      })
    },
  })
}
