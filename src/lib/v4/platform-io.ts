import type { V4ContentSource } from "./content-source"
import { createV4IncrementalSha256 } from "./incremental-hash"

export type V4PlatformKind = "desktop" | "mobile" | "other"
export type V4BoundedIoCapability = "bounded-read" | "bounded-append" | "free-space" | "stage-commit"

export class V4BoundedIoUnavailableError extends Error {
  readonly capability: V4BoundedIoCapability
  readonly path?: string

  constructor(capability: V4BoundedIoCapability, path?: string) {
    super(`V4 ${capability} is unavailable${path ? ` for ${path}` : ""}.`)
    this.name = "V4BoundedIoUnavailableError"
    this.capability = capability
    this.path = path
  }
}

export interface V4BinaryAdapterLike {
  readBinary?(path: string): Promise<ArrayBuffer>
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>
  appendBinary?(path: string, data: ArrayBuffer): Promise<void>
  remove?(path: string): Promise<void>
  mkdir?(path: string): Promise<void>
}

export interface V4PlatformIoCapabilities {
  platform: V4PlatformKind
  boundedRead: boolean
  boundedAppend: boolean
  freeSpace: boolean
  requiresObsidian1123ForAppend: boolean
}

export interface V4PlatformIo {
  readonly capabilities: V4PlatformIoCapabilities
  readWhole(path: string): Promise<Uint8Array>
  openBoundedSource(path: string, expectedSize: number): Promise<V4ContentSource>
  writeStage(path: string, bytes: Uint8Array): Promise<void>
  appendStage(path: string, bytes: Uint8Array): Promise<void>
  removeStage(path: string): Promise<void>
  freeBytes(path: string): Promise<number | undefined>
  commitStage(stagePath: string, targetPath: string, options: {
    expectedTarget: { exists: boolean; size?: number; mtime?: number }
    expectedStageSize: number
    expectedStageSha256: string
  }): Promise<void>
  rollbackStage(stagePath: string, targetPath: string, options: {
    expectedTarget: { exists: boolean; size?: number; mtime?: number }
    expectedStageSize: number
    expectedStageSha256: string
  }): Promise<void>
  assertVaultPathSafe(path: string, options?: { mustExist?: boolean }): Promise<void>
}

export interface V4PlatformIoOptions {
  platform: V4PlatformKind
  adapter?: V4BinaryAdapterLike
  resolveDesktopPath?: (path: string) => string
  desktopRootPath?: string
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer
}

function parent(path: string): string {
  return path.replace(/\\/gu, "/").split("/").slice(0, -1).join("/")
}

async function desktopFs() {
  return import("node:fs/promises")
}

async function desktopPath() {
  return import("node:path")
}

async function ensureDesktopParent(fullPath: string): Promise<void> {
  const [fs, path] = await Promise.all([desktopFs(), desktopPath()])
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
}

function pathInside(root: string, candidate: string, pathModule: typeof import("node:path")): boolean {
  const relative = pathModule.relative(root, candidate)
  return relative === "" || (!pathModule.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathModule.sep}`))
}

function desktopBoundedSource(
  fullPath: string,
  expectedSize: number,
  assertSafe: () => Promise<void>,
): V4ContentSource {
  return {
    size: expectedSize,
    async *chunks(chunkBytes: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("chunkBytes must be a positive safe integer.")
      const fs = await desktopFs()
      await assertSafe()
      const before = await fs.stat(fullPath)
      if (before.size !== expectedSize) throw new Error(`V4 desktop source size changed: expected ${expectedSize}, got ${before.size}.`)
      const handle = await fs.open(fullPath, "r")
      try {
        let offset = 0
        while (offset < expectedSize) {
          if (signal?.aborted) throw signal.reason ?? new Error("V4 bounded read aborted.")
          const wanted = Math.min(chunkBytes, expectedSize - offset)
          const chunk = new Uint8Array(wanted)
          let filled = 0
          while (filled < wanted) {
            const result = await handle.read(chunk, filled, wanted - filled, offset + filled)
            if (result.bytesRead === 0) throw new Error(`Unexpected EOF while reading ${fullPath}.`)
            filled += result.bytesRead
          }
          offset += filled
          yield chunk
        }
      } finally {
        await handle.close()
      }
    },
  }
}

export function createV4PlatformIo(options: V4PlatformIoOptions): V4PlatformIo {
  const desktopReady = options.platform === "desktop"
    && typeof options.resolveDesktopPath === "function"
    && typeof options.desktopRootPath === "string"
    && options.desktopRootPath.length > 0
  const mobileAppend = options.platform === "mobile" && typeof options.adapter?.appendBinary === "function" && typeof options.adapter?.writeBinary === "function"
  const capabilities: V4PlatformIoCapabilities = {
    platform: options.platform,
    boundedRead: desktopReady,
    boundedAppend: desktopReady || mobileAppend,
    freeSpace: desktopReady,
    requiresObsidian1123ForAppend: options.platform === "mobile" && mobileAppend,
  }
  const full = (path: string): string => {
    if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
    return options.resolveDesktopPath!(path)
  }
  const assertDesktopPathSafe = async (path: string, mustExist = false): Promise<void> => {
    if (options.platform !== "desktop") return
    if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
    const [fs, pathModule] = await Promise.all([desktopFs(), desktopPath()])
    const lexicalRoot = pathModule.resolve(options.desktopRootPath!)
    const requested = pathModule.resolve(full(path))
    if (!pathInside(lexicalRoot, requested, pathModule)) {
      throw new Error(`V4 desktop path escapes the vault root: ${path}`)
    }
    const realRoot = await fs.realpath(lexicalRoot)
    const relative = pathModule.relative(lexicalRoot, requested)
    const segments = relative === "" ? [] : relative.split(pathModule.sep).filter(Boolean)
    let current = lexicalRoot
    let missing = false
    for (const [index, segment] of segments.entries()) {
      current = pathModule.join(current, segment)
      let stat: Awaited<ReturnType<typeof fs.lstat>>
      try {
        stat = await fs.lstat(current)
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error
        missing = true
        if (mustExist) throw new Error(`V4 desktop path is missing: ${path}`)
        break
      }
      if (stat.isSymbolicLink()) throw new Error(`V4 desktop path contains a symlink or junction: ${path}`)
      const realCurrent = await fs.realpath(current)
      if (!pathInside(realRoot, realCurrent, pathModule)) {
        throw new Error(`V4 desktop path resolves outside the vault root: ${path}`)
      }
      if (!stat.isDirectory() && index < segments.length - 1) {
        throw new Error(`V4 desktop path has a non-directory ancestor: ${path}`)
      }
    }
    if (mustExist && missing) throw new Error(`V4 desktop path is missing: ${path}`)
  }
  return {
    capabilities,
    async assertVaultPathSafe(path, check = {}) {
      await assertDesktopPathSafe(path, check.mustExist ?? false)
    },
    async readWhole(path) {
      if (options.platform === "desktop") {
        await assertDesktopPathSafe(path, true)
        const fs = await desktopFs()
        return new Uint8Array(await fs.readFile(full(path)))
      }
      if (options.adapter?.readBinary) return new Uint8Array(await options.adapter.readBinary(path))
      throw new V4BoundedIoUnavailableError("bounded-read", path)
    },
    async openBoundedSource(path, expectedSize) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
      return desktopBoundedSource(full(path), expectedSize, () => assertDesktopPathSafe(path, true))
    },
    async writeStage(path, bytes) {
      if (desktopReady) {
        await assertDesktopPathSafe(path, false)
        const target = full(path)
        await ensureDesktopParent(target)
        await assertDesktopPathSafe(path, false)
        const fs = await desktopFs()
        await fs.writeFile(target, bytes)
        return
      }
      if (!options.adapter?.writeBinary) throw new V4BoundedIoUnavailableError("bounded-append", path)
      if (options.adapter.mkdir) {
        const folder = parent(path)
        if (folder) { try { await options.adapter.mkdir(folder) } catch (error) { if (!/exist/iu.test((error as Error).message)) throw error } }
      }
      await options.adapter.writeBinary(path, asArrayBuffer(bytes))
    },
    async appendStage(path, bytes) {
      if (desktopReady) {
        await assertDesktopPathSafe(path, false)
        const target = full(path)
        await ensureDesktopParent(target)
        await assertDesktopPathSafe(path, false)
        const fs = await desktopFs()
        await fs.appendFile(target, bytes)
        return
      }
      if (!mobileAppend) throw new V4BoundedIoUnavailableError("bounded-append", path)
      await options.adapter!.appendBinary!(path, asArrayBuffer(bytes))
    },
    async removeStage(path) {
      if (desktopReady) {
        await assertDesktopPathSafe(path, false)
        await assertDesktopPathSafe(`${path}.target-backup`, false)
        const fs = await desktopFs()
        const stage = full(path)
        await fs.rm(stage, { force: true })
        await fs.rm(`${stage}.target-backup`, { force: true })
        return
      }
      if (options.adapter?.remove) await options.adapter.remove(path)
    },
    async freeBytes(path) {
      if (!desktopReady) return undefined
      await assertDesktopPathSafe(path, false)
      const target = full(path)
      await ensureDesktopParent(target)
      await assertDesktopPathSafe(path, false)
      const [fs, pathModule] = await Promise.all([desktopFs(), desktopPath()])
      const stats = await fs.statfs(pathModule.dirname(target))
      return Number(stats.bavail) * Number(stats.bsize)
    },
    async rollbackStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) return
      await assertDesktopPathSafe(stagePath, false)
      await assertDesktopPathSafe(targetPath, false)
      await assertDesktopPathSafe(`${stagePath}.target-backup`, false)
      const fs = await desktopFs()
      const stage = full(stagePath)
      const target = full(targetPath)
      const backup = `${stage}.target-backup`
      await ensureDesktopParent(target)
      await assertDesktopPathSafe(targetPath, false)
      const statOrNull = async (path: string) => { try { return await fs.stat(path) } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error } }
      const expected = commitOptions.expectedTarget
      const matchesExpected = (candidate: Awaited<ReturnType<typeof fs.stat>> | null): boolean =>
        expected.exists === !!candidate
        && (!expected.exists || expected.size === undefined || candidate!.size === expected.size)
        && (!expected.exists || expected.mtime === undefined || Math.trunc(candidate!.mtimeMs) === Math.trunc(expected.mtime))
      const backupStat = await statOrNull(backup)
      if (!backupStat) return
      if (!matchesExpected(backupStat)) throw new Error(`V4 interrupted target backup does not match the expected target: ${targetPath}`)
      const targetStat = await statOrNull(target)
      if (!targetStat) {
        await fs.rename(backup, target)
        return
      }
      if (matchesExpected(targetStat)) {
        await fs.rm(backup, { force: true })
        return
      }
      if (targetStat.size === commitOptions.expectedStageSize) {
        const hash = createV4IncrementalSha256()
        for await (const chunk of desktopBoundedSource(target, commitOptions.expectedStageSize, () => assertDesktopPathSafe(targetPath, true)).chunks(4 * 1024 * 1024)) hash.update(chunk)
        if (hash.digestHex() === commitOptions.expectedStageSha256) {
          await fs.rm(target, { force: true })
          await fs.rename(backup, target)
          return
        }
      }
      throw new Error(`V4 local target changed; staged rollback is unsafe: ${targetPath}`)
    },
    async commitStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("stage-commit", targetPath)
      await assertDesktopPathSafe(stagePath, true)
      await assertDesktopPathSafe(targetPath, false)
      await assertDesktopPathSafe(`${stagePath}.target-backup`, false)
      const fs = await desktopFs()
      const stage = full(stagePath)
      const target = full(targetPath)
      const backup = `${stage}.target-backup`
      await ensureDesktopParent(target)
      await assertDesktopPathSafe(targetPath, false)
      const statOrNull = async (path: string) => { try { return await fs.stat(path) } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error } }
      const expected = commitOptions.expectedTarget
      const matchesExpected = (candidate: Awaited<ReturnType<typeof fs.stat>> | null): boolean =>
        expected.exists === !!candidate
        && (!expected.exists || expected.size === undefined || candidate!.size === expected.size)
        && (!expected.exists || expected.mtime === undefined || Math.trunc(candidate!.mtimeMs) === Math.trunc(expected.mtime))
      let targetBefore = await statOrNull(target)
      const interruptedBackup = await statOrNull(backup)
      if (!targetBefore && interruptedBackup) {
        if (!matchesExpected(interruptedBackup)) {
          throw new Error(`V4 interrupted target backup does not match the expected target: ${targetPath}`)
        }
        await fs.rename(backup, target)
        targetBefore = await statOrNull(target)
      }
      if (!matchesExpected(targetBefore)) {
        throw new Error(`V4 local target changed before staged commit: ${targetPath}`)
      }
      const stageStat = await fs.stat(stage)
      if (stageStat.size !== commitOptions.expectedStageSize) throw new Error(`V4 staged content size changed before commit: ${stagePath}`)
      await fs.rm(backup, { force: true })
      let backedUp = false
      let stageMoved = false
      try {
        if (targetBefore) { await fs.rename(target, backup); backedUp = true }
        await fs.rename(stage, target); stageMoved = true
        const after = await fs.stat(target)
        if (after.size !== commitOptions.expectedStageSize) throw new Error(`V4 committed target size mismatch: ${targetPath}`)
        const hash = createV4IncrementalSha256()
        for await (const chunk of desktopBoundedSource(target, commitOptions.expectedStageSize).chunks(4 * 1024 * 1024)) hash.update(chunk)
        if (hash.digestHex() !== commitOptions.expectedStageSha256) throw new Error(`V4 committed target hash mismatch: ${targetPath}`)
        if (backedUp) await fs.rm(backup, { force: true })
      } catch (error) {
        if (stageMoved) { try { await fs.rm(target, { force: true }) } catch {} }
        if (backedUp) { try { await fs.rename(backup, target) } catch {} }
        throw error
      }
    },
  }
}
