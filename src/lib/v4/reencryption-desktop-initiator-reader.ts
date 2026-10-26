import type { V4InitiatorLocalReader, V4InitiatingFile } from "./reencryption-initiator-parity"
import { createV4ScopePredicate, type V4ScopeSettings } from "./scope"

const MAX_SCAN_ENTRIES = 100_000
const MAX_DIRECTORY_DEPTH = 64
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

export interface V4DesktopInitiatorReaderInput {
  /** Existing, trusted, physically local vault directory from Obsidian's adapter. */
  readonly rootAbsolute: string
  /** Copied settings at the moment the migration source was pinned. */
  readonly scope: Readonly<V4ScopeSettings>
  /** All guards are live calls into the actual initiating plugin/runtime. */
  readonly assertExclusiveInitiatorLease: V4InitiatorLocalReader["assertExclusiveInitiatorLease"]
  readonly assertIdleAndNoPendingEdits: V4InitiatorLocalReader["assertIdleAndNoPendingEdits"]
  readonly assertSourceConfigurationUnchanged: V4InitiatorLocalReader["assertSourceConfigurationUnchanged"]
  readonly listOpenEditorPaths: V4InitiatorLocalReader["listOpenEditorPaths"]
}

function safeLogicalPath(value: string): readonly string[] {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value !== value.normalize("NFC")) {
    throw new Error("Re-encryption desktop reader refuses unsafe or noncanonical vault paths.")
  }
  const parts = value.split("/")
  if (parts.some(part => !part || part === "." || part === ".." || part.includes(":")
    || /[. ]$/u.test(part) || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error("Re-encryption desktop reader refuses ambiguous or Windows-unsafe paths.")
  }
  return parts
}

async function nativeIO() {
  const [fs, path, constants] = await Promise.all([
    import("node:fs/promises"), import("node:path"), import("node:fs"),
  ])
  return { fs, path, constants: constants.constants }
}

/**
 * D106: real, read-only Node filesystem inventory + bounded file-handle reader.
 * This is NOT a filesystem snapshot, global editor lock, or source of
 * `initiatorLocalCutoverAuthorized`. External processes may race pathname
 * checks. A production cutover still needs a durable transaction and explicit
 * editor/change fencing.
 *
 * This module does NOT enumerate Obsidian's cached getFiles() list, follow
 * junctions/symlinks, write into a vault, or start a migration.
 */
export function createV4DesktopInitiatorLocalReader(
  input: V4DesktopInitiatorReaderInput,
): V4InitiatorLocalReader {
  if (!input || typeof input.rootAbsolute !== "string"
    || !input.scope
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertIdleAndNoPendingEdits !== "function"
    || typeof input.assertSourceConfigurationUnchanged !== "function"
    || typeof input.listOpenEditorPaths !== "function") {
    throw new Error("Re-encryption desktop physical reader requires all initiating-device guards.")
  }
  const capturedScope = Object.freeze({ ...input.scope })
  const inScope = createV4ScopePredicate(capturedScope)
  const rootAbsolute = input.rootAbsolute

  async function trustedRoot() {
    const io = await nativeIO()
    const { fs, path } = io
    if (!path.isAbsolute(rootAbsolute) || path.resolve(rootAbsolute) !== rootAbsolute) {
      throw new Error("Re-encryption desktop reader requires a canonical absolute vault root.")
    }
    const stat = await fs.lstat(rootAbsolute)
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (await fs.realpath(rootAbsolute)).toLowerCase() !== rootAbsolute.toLowerCase()) {
      throw new Error("Re-encryption desktop reader cannot trust a symlink or junction vault root.")
    }
    return io
  }

  async function safeEntry(io: Awaited<ReturnType<typeof nativeIO>>, parts: readonly string[],
    kind: "directory" | "file") {
    const { fs, path } = io
    let current = rootAbsolute
    let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined
    for (const [i, part] of parts.entries()) {
      current = path.join(current, part)
      stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) {
        throw new Error("Re-encryption desktop reader refuses symbolic links or junctions inside a vault.")
      }
      if ((i < parts.length - 1 || kind === "directory") && !stat.isDirectory()) {
        throw new Error("Re-encryption desktop reader encountered a non-directory path component.")
      }
      if (i === parts.length - 1 && kind === "file") {
        if (!stat.isFile() || Number(stat.nlink) !== 1) {
          throw new Error("Re-encryption desktop reader requires a regular, non-hardlinked physical file.")
        }
      }
      const actual = await fs.realpath(current)
      if (path.resolve(actual).toLowerCase() !== path.resolve(current).toLowerCase()) {
        throw new Error("Re-encryption desktop reader refuses a junction or redirected vault path.")
      }
    }
    if (!stat) throw new Error("Re-encryption desktop reader has no physical file identity.")
    return { full: current, stat }
  }

  return Object.freeze({
    assertExclusiveInitiatorLease: input.assertExclusiveInitiatorLease,
    assertIdleAndNoPendingEdits: input.assertIdleAndNoPendingEdits,
    assertSourceConfigurationUnchanged: input.assertSourceConfigurationUnchanged,
    listOpenEditorPaths: input.listOpenEditorPaths,
    async listFiles(): Promise<readonly V4InitiatingFile[]> {
      const io = await trustedRoot()
      const { fs, path } = io
      const seen = new Set<string>()
      const files: V4InitiatingFile[] = []
      const pending: Array<readonly string[]> = [[]]
      let counted = 0
      while (pending.length) {
        const parts = pending.pop()!
        if (parts.length > MAX_DIRECTORY_DEPTH) {
          throw new Error("Re-encryption desktop reader directory depth exceeds the safe limit.")
        }
        if (parts.length) await safeEntry(io, parts, "directory")
        const entries = await fs.readdir(path.join(rootAbsolute, ...parts), { withFileTypes: true })
        for (const entry of entries) {
          if (++counted > MAX_SCAN_ENTRIES) {
            throw new Error("Re-encryption desktop reader vault inventory exceeds the safe limit.")
          }
          const logicalParts = [...parts, entry.name]
          const logical = logicalParts.join("/")
          safeLogicalPath(logical)
          // Do not silently follow links even inside folders that are excluded.
          if (entry.isSymbolicLink()) {
            throw new Error("Re-encryption desktop reader refuses a symlink/junction in the vault.")
          }
          if (entry.isDirectory()) {
            if (logicalParts.length > MAX_DIRECTORY_DEPTH) {
              throw new Error("Re-encryption desktop reader directory depth exceeds the safe limit.")
            }
            await safeEntry(io, logicalParts, "directory")
            pending.push(logicalParts)
          } else if (entry.isFile()) {
            if (!inScope(logical)) continue
            const { stat } = await safeEntry(io, logicalParts, "file")
            const normalized = logical.normalize("NFC").toLowerCase()
            if (seen.has(normalized)) {
              throw new Error("Re-encryption desktop reader found a case-insensitive file collision.")
            }
            seen.add(normalized)
            if (!Number.isSafeInteger(stat.size) || stat.size < 0
              || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs < 0) {
              throw new Error("Re-encryption desktop reader invalid physical file metadata.")
            }
            files.push(Object.freeze({ path: logical, size: Number(stat.size), mtime: Number(stat.mtimeMs) }))
          } else {
            throw new Error("Re-encryption desktop reader encountered an unsafe filesystem entry.")
          }
        }
      }
      return Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path)))
    },
    async openFile(logical: string) {
      const parts = safeLogicalPath(logical)
      if (!inScope(logical)) {
        throw new Error("Re-encryption desktop reader cannot open excluded vault paths.")
      }
      const io = await trustedRoot()
      const { fs, constants } = io
      const initial = await safeEntry(io, parts, "file")
      if (!Number.isSafeInteger(initial.stat.size) || initial.stat.size < 0) {
        throw new Error("Re-encryption desktop reader unsafe physical file size.")
      }
      return Object.freeze({
        size: Number(initial.stat.size),
        async *chunks(chunkSize: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
          if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
            throw new Error("Re-encryption desktop reader refuses unbounded chunk sizes.")
          }
          let handle: Awaited<ReturnType<typeof fs.open>> | undefined
          try {
            if (signal?.aborted) throw signal.reason ?? new Error("Re-encryption reader aborted.")
            await safeEntry(io, parts, "file")
            handle = await fs.open(initial.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            const opened = await handle.stat()
            if (!opened.isFile() || opened.isSymbolicLink()
              || opened.size !== initial.stat.size
              || opened.dev !== initial.stat.dev || opened.ino !== initial.stat.ino
              || opened.mtimeMs !== initial.stat.mtimeMs
              || opened.ctimeMs !== initial.stat.ctimeMs) {
              throw new Error("Re-encryption desktop reader file identity changed before hashing.")
            }
            let position = 0
            while (position < opened.size) {
              if (signal?.aborted) throw signal.reason ?? new Error("Re-encryption reader aborted.")
              const buffer = new Uint8Array(Math.min(chunkSize, opened.size - position))
              let filled = 0
              while (filled < buffer.byteLength) {
                const result = await handle.read(buffer, filled, buffer.byteLength - filled, position + filled)
                if (result.bytesRead === 0) throw new Error("Re-encryption desktop reader detected truncated physical file.")
                filled += result.bytesRead
              }
              position += filled
              yield buffer
            }
            const finalHandle = await handle.stat()
            const finalPath = await safeEntry(io, parts, "file")
            if (finalHandle.dev !== opened.dev || finalHandle.ino !== opened.ino
              || finalHandle.size !== opened.size || finalHandle.mtimeMs !== opened.mtimeMs
              || finalHandle.ctimeMs !== opened.ctimeMs || finalPath.stat.dev !== opened.dev
              || finalPath.stat.ino !== opened.ino || finalPath.stat.size !== opened.size
              || finalPath.stat.mtimeMs !== opened.mtimeMs || finalPath.stat.ctimeMs !== opened.ctimeMs) {
              throw new Error("Re-encryption desktop reader physical file changed during hashing.")
            }
          } finally {
            await handle?.close()
          }
        },
      })
    },
  })
}
