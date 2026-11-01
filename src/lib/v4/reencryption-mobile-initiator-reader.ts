import { throwIfV4Aborted } from "./cancellation"
import { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } from "./content-source"
import { normalizeV4VaultPath } from "./paths"
import type { V4InitiatorLocalReader, V4InitiatingFile } from "./reencryption-initiator-parity"
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

  const assertGuard = async (signal?: AbortSignal) => {
    throwIfV4Aborted(signal)
    await input.assertExclusiveInitiatorLease()
    await input.assertIdleAndNoPendingEdits()
    await input.assertSourceConfigurationUnchanged()
    const open = await input.listOpenEditorPaths()
    if (!Array.isArray(open) || open.length) {
      throw new Error("Re-encryption Mobile cannot verify parity while an editor is open or unknown.")
    }
    throwIfV4Aborted(signal)
  }

  return Object.freeze({
    assertExclusiveInitiatorLease: input.assertExclusiveInitiatorLease,
    assertIdleAndNoPendingEdits: input.assertIdleAndNoPendingEdits,
    assertSourceConfigurationUnchanged: input.assertSourceConfigurationUnchanged,
    listOpenEditorPaths: input.listOpenEditorPaths,
    async listFiles(): Promise<readonly V4InitiatingFile[]> {
      await assertGuard()
      const discovered = new Set<string>()
      const files: V4InitiatingFile[] = []
      const dirs: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }]
      while (dirs.length) {
        const current = dirs.pop()!
        await assertGuard()
        const listed = await adapter.list(current.path || "/")
        if (!listed || !Array.isArray(listed.files) || !Array.isArray(listed.folders)) {
          throw new Error("Re-encryption Mobile adapter returned an incomplete directory listing.")
        }
        for (const [kind, children] of [["folder", listed.folders], ["file", listed.files]] as const) {
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
              await assertGuard()
              requireStats(await adapter.stat(path), "folder")
              dirs.push({ path, depth: current.depth + 1 })
            } else if (inScope(path)) {
              await assertGuard()
              const stat = requireStats(await adapter.stat(path), "file")
              if (stat.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
                throw new Error("Re-encryption Mobile parity cannot verify files above the bounded whole-read limit.")
              }
              files.push(Object.freeze({ path, size: stat.size, mtime: stat.mtime }))
            }
          }
        }
      }
      await assertGuard()
      return Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path)))
    },
    async openFile(path: string) {
      safePath(path)
      if (!inScope(path)) throw new Error("Re-encryption Mobile reader cannot open excluded paths.")
      await assertGuard()
      const initial = requireStats(await adapter.stat(path), "file")
      if (initial.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        throw new Error("Re-encryption Mobile parity cannot verify files above the bounded whole-read limit.")
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
            throwIfV4Aborted(signal)
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
