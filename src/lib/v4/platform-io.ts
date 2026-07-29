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
}

export interface V4PlatformIoOptions {
  platform: V4PlatformKind
  adapter?: V4BinaryAdapterLike
  resolveDesktopPath?: (path: string) => string
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

function desktopBoundedSource(fullPath: string, expectedSize: number): V4ContentSource {
  return {
    size: expectedSize,
    async *chunks(chunkBytes: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("chunkBytes must be a positive safe integer.")
      const fs = await desktopFs()
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
  const desktopReady = options.platform === "desktop" && typeof options.resolveDesktopPath === "function"
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
  return {
    capabilities,
    async readWhole(path) {
      if (options.adapter?.readBinary) return new Uint8Array(await options.adapter.readBinary(path))
      if (desktopReady) {
        const fs = await desktopFs()
        return new Uint8Array(await fs.readFile(full(path)))
      }
      throw new V4BoundedIoUnavailableError("bounded-read", path)
    },
    async openBoundedSource(path, expectedSize) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
      return desktopBoundedSource(full(path), expectedSize)
    },
    async writeStage(path, bytes) {
      if (desktopReady) {
        const target = full(path)
        await ensureDesktopParent(target)
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
        const target = full(path)
        await ensureDesktopParent(target)
        const fs = await desktopFs()
        await fs.appendFile(target, bytes)
        return
      }
      if (!mobileAppend) throw new V4BoundedIoUnavailableError("bounded-append", path)
      await options.adapter!.appendBinary!(path, asArrayBuffer(bytes))
    },
    async removeStage(path) {
      if (desktopReady) {
        const fs = await desktopFs()
        await fs.rm(full(path), { force: true })
        return
      }
      if (options.adapter?.remove) await options.adapter.remove(path)
    },
    async freeBytes(path) {
      if (!desktopReady) return undefined
      const target = full(path)
      await ensureDesktopParent(target)
      const [fs, pathModule] = await Promise.all([desktopFs(), desktopPath()])
      const stats = await fs.statfs(pathModule.dirname(target))
      return Number(stats.bavail) * Number(stats.bsize)
    },
    async commitStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("stage-commit", targetPath)
      const fs = await desktopFs()
      const stage = full(stagePath)
      const target = full(targetPath)
      const backup = `${stage}.target-backup`
      await ensureDesktopParent(target)
      const statOrNull = async (path: string) => { try { return await fs.stat(path) } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error } }
      const targetBefore = await statOrNull(target)
      const expected = commitOptions.expectedTarget
      if (expected.exists !== !!targetBefore
        || (expected.exists && expected.size !== undefined && targetBefore!.size !== expected.size)
        || (expected.exists && expected.mtime !== undefined && Math.trunc(targetBefore!.mtimeMs) !== Math.trunc(expected.mtime))) {
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
