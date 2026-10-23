import type { V4ContentSource } from "./content-source"
import { createV4IncrementalSha256 } from "./incremental-hash"

export type V4PlatformKind = "desktop" | "mobile" | "other"
export type V4BoundedIoCapability = "bounded-read" | "bounded-append" | "free-space" | "stage-commit"

export class V4ManualRecoveryRequiredError extends Error {
  constructor(public readonly targetPath: string, reason: string) {
    super(`V4 staged recovery needs user review for ${targetPath}: ${reason}. Original backup and local files have been preserved.`)
    this.name = "V4ManualRecoveryRequiredError"
  }
}

export interface V4StageCommitOptions {
  expectedTarget: { exists: boolean; size?: number; mtime?: number; hash?: string }
  expectedStageSize: number
  expectedStageSha256: string
  /** Synchronous editor guard, checked immediately before filesystem renames. */
  assertNoOpenEditor?: () => void
}

export class V4BoundedIoUnavailableError extends Error {
  readonly capability: V4BoundedIoCapability
  readonly path?: string | undefined

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
  recoveryStagedCommit: boolean
  requiresObsidian1123ForAppend: boolean
}

export interface V4PlatformIo {
  readonly capabilities: V4PlatformIoCapabilities
  statFile(path: string): Promise<{ size: number; mtime: number } | null>
  readWhole(path: string): Promise<Uint8Array>
  openBoundedSource(path: string, expectedSize: number): Promise<V4ContentSource>
  writeStage(path: string, bytes: Uint8Array): Promise<void>
  appendStage(path: string, bytes: Uint8Array): Promise<void>
  removeStage(path: string): Promise<void>
  freeBytes(path: string): Promise<number | undefined>
  commitStage(stagePath: string, targetPath: string, options: V4StageCommitOptions): Promise<void>
  rollbackStage(stagePath: string, targetPath: string, options: V4StageCommitOptions): Promise<void>
  finalizeStage(stagePath: string, targetPath: string, options: V4StageCommitOptions): Promise<void>
}

export interface V4PlatformIoOptions {
  platform: V4PlatformKind
  adapter?: V4BinaryAdapterLike
  resolveDesktopPath?: ((path: string) => string) | undefined
  /** Required to prove that crash-recovery paths cannot escape the vault. */
  desktopRootPath?: string | undefined
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
  // Obsidian runs the production bundle as CommonJS inside Electron.
  // Browser-side dynamic import of node:* may resolve as a URL rather than Node IO.
  if (typeof exports === "object" && typeof require === "function") return require("node:fs/promises") as typeof import("node:fs/promises")
  return import("node:fs/promises")
}

async function desktopFsSync(): Promise<typeof import("node:fs")> {
  // Load outside the critical rename section. Only short directory-entry
  // renames are synchronous: never hash/read/write large bytes on the renderer
  // thread. The two renames must not yield after the last editor guard.
  if (typeof exports === "object" && typeof require === "function") return require("node:fs") as typeof import("node:fs")
  return import("node:fs")
}

async function desktopPath() {
  if (typeof exports === "object" && typeof require === "function") return require("node:path") as typeof import("node:path")
  return import("node:path")
}

async function ensureDesktopParent(fullPath: string): Promise<void> {
  const [fs, path] = await Promise.all([desktopFs(), desktopPath()])
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
}

function desktopBoundedSource(fullPath: string, expectedSize: number, assertSafe?: () => Promise<void>): V4ContentSource {
  return {
    size: expectedSize,
    async *chunks(chunkBytes: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("chunkBytes must be a positive safe integer.")
      const fs = await desktopFs()
      await assertSafe?.()
      const before = await fs.stat(fullPath)
      if (before.size !== expectedSize) throw new Error(`V4 desktop source size changed: expected ${expectedSize}, got ${before.size}.`)
      await assertSafe?.()
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
    recoveryStagedCommit: desktopReady && !!options.desktopRootPath,
    requiresObsidian1123ForAppend: options.platform === "mobile" && mobileAppend,
  }
  const full = (path: string): string => {
    if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
    return options.resolveDesktopPath!(path)
  }
  const statOrNull = async (file: string) => {
    const fs = await desktopFs()
    try { return await fs.stat(file) } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null
      throw error
    }
  }
  // Normalize absolute vault adapter paths against the known Desktop vault root.
  // The root itself may be a user-configured junction; links INSIDE the vault
  // are not trusted to resolve to user-owned vault content.
  const assertDesktopPathSafe = async (logical: string, mustExist = false): Promise<void> => {
    if (!options.desktopRootPath) return // compatibility for isolated platform-IO tests
    const [fs, pathModule] = await Promise.all([desktopFs(), desktopPath()])
    const root = pathModule.resolve(options.desktopRootPath)
    const requested = pathModule.resolve(full(logical))
    const relative = pathModule.relative(root, requested)
    if (relative === "" || relative === ".." || relative.startsWith(".." + pathModule.sep) || pathModule.isAbsolute(relative)) {
      throw new V4ManualRecoveryRequiredError(logical, "path leaves the configured vault")
    }
    // Verify configured root is real before trusting any descendant.
    const realRoot = await fs.realpath(root)
    const rootStat = await fs.stat(realRoot)
    if (!rootStat.isDirectory()) throw new V4ManualRecoveryRequiredError(logical, "vault root is not a directory")
    let current = root
    const segments = relative.split(pathModule.sep)
    for (const [index, segment] of segments.entries()) {
      current = pathModule.join(current, segment)
      let info: Awaited<ReturnType<typeof fs.lstat>>
      try { info = await fs.lstat(current) }
      catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error
        if (mustExist) throw new V4ManualRecoveryRequiredError(logical, "required file is missing")
        break
      }
      if (info.isSymbolicLink()) throw new V4ManualRecoveryRequiredError(logical, "symlink or junction prevents safe vault IO")
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new V4ManualRecoveryRequiredError(logical, "non-directory path component")
      }
      const actual = await fs.realpath(current)
      const inside = pathModule.relative(realRoot, actual)
      if (inside === ".." || inside.startsWith(".." + pathModule.sep) || pathModule.isAbsolute(inside)) {
        throw new V4ManualRecoveryRequiredError(logical, "path resolves outside the vault")
      }
    }
  }
  const assertRecoveryPaths = async (stagePath: string, targetPath: string): Promise<void> => {
    if (!desktopReady || !options.desktopRootPath) throw new V4ManualRecoveryRequiredError(targetPath, "vault root is not verifiable")
    for (const logical of [stagePath, stagePath + ".target-backup", stagePath + ".replacement-residue", targetPath]) {
      await assertDesktopPathSafe(logical)
    }
  }
  const assertRecoveryPathsSync = (
    stagePath: string, targetPath: string,
    fsSync: typeof import("node:fs"), pathModule: typeof import("node:path"),
  ): void => {
    const root = pathModule.resolve(options.desktopRootPath!)
    for (const logical of [stagePath, stagePath + ".target-backup", stagePath + ".replacement-residue", targetPath]) {
      const relative = pathModule.relative(root, pathModule.resolve(full(logical)))
      if (!relative || relative === ".." || relative.startsWith(".." + pathModule.sep) || pathModule.isAbsolute(relative)) {
        throw new V4ManualRecoveryRequiredError(logical, "path leaves the configured vault")
      }
      let current = root
      const segments = relative.split(pathModule.sep)
      for (const [index, segment] of segments.entries()) {
        current = pathModule.join(current, segment)
        try {
          const info = fsSync.lstatSync(current)
          if (info.isSymbolicLink()) throw new V4ManualRecoveryRequiredError(logical, "late symlink or junction path change")
          if (index < segments.length - 1 && !info.isDirectory()) {
            throw new V4ManualRecoveryRequiredError(logical, "non-directory path component")
          }
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") break
          throw error
        }
      }
    }
  }
  const hashFile = async (file: string, size: number): Promise<string | null> => {
    const before = await statOrNull(file)
    if (!before || before.size !== size || !before.isFile()) return null
    const hash = createV4IncrementalSha256()
    for await (const chunk of desktopBoundedSource(file, size).chunks(4 * 1024 * 1024)) hash.update(chunk)
    const after = await statOrNull(file)
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null
    return hash.digestHex()
  }
  const confirmBackup = async (backup: string, expected: V4StageCommitOptions["expectedTarget"]): Promise<boolean> => {
    // Metadata alone is not proof of the original content. Older WALs without
    // an original SHA remain untouched for user review.
    if (!expected.exists || !Number.isSafeInteger(expected.size) || !expected.hash || !/^[0-9a-f]{64}$/u.test(expected.hash)) return false
    const info = await statOrNull(backup)
    return !!info && info.size === expected.size
      && (expected.mtime === undefined || Math.round(info.mtimeMs) === Math.round(expected.mtime))
      && await hashFile(backup, info.size) === expected.hash
  }
  return {
    capabilities,
    async statFile(path) {
      if (!desktopReady || !options.desktopRootPath) throw new V4BoundedIoUnavailableError("bounded-read", path)
      await assertDesktopPathSafe(path)
      const info = await statOrNull(full(path))
      if (!info) return null
      if (!info.isFile()) throw new V4ManualRecoveryRequiredError(path, "target is not a regular file")
      // Obsidian's FileSystemAdapter reports nearest-integer milliseconds.
      // Truncation made the same NTFS timestamp appear changed by 1 ms.
      return { size: info.size, mtime: Math.round(info.mtimeMs) }
    },
    async readWhole(path) {
      if (desktopReady && options.desktopRootPath) {
        await assertDesktopPathSafe(path, true)
        const fs = await desktopFs()
        return new Uint8Array(await fs.readFile(full(path)))
      }
      if (options.adapter?.readBinary) return new Uint8Array(await options.adapter.readBinary(path))
      if (desktopReady) {
        const fs = await desktopFs()
        return new Uint8Array(await fs.readFile(full(path)))
      }
      throw new V4BoundedIoUnavailableError("bounded-read", path)
    },
    async openBoundedSource(path, expectedSize) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("bounded-read", path)
      return desktopBoundedSource(full(path), expectedSize, () => assertDesktopPathSafe(path, true))
    },
    async writeStage(path, bytes) {
      if (desktopReady) {
        await assertDesktopPathSafe(path)
        const target = full(path)
        await ensureDesktopParent(target)
        await assertDesktopPathSafe(path)
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
        await assertDesktopPathSafe(path)
        const target = full(path)
        await ensureDesktopParent(target)
        await assertDesktopPathSafe(path)
        const fs = await desktopFs()
        await fs.appendFile(target, bytes)
        return
      }
      if (!mobileAppend) throw new V4BoundedIoUnavailableError("bounded-append", path)
      await options.adapter!.appendBinary!(path, asArrayBuffer(bytes))
    },
    async removeStage(path) {
      if (desktopReady) {
        await assertDesktopPathSafe(path)
        const fs = await desktopFs()
        await fs.rm(full(path), { force: true })
        return
      }
      if (options.adapter?.remove) await options.adapter.remove(path)
    },
    async freeBytes(path) {
      if (!desktopReady) return undefined
      await assertDesktopPathSafe(path)
      const target = full(path)
      await ensureDesktopParent(target)
      await assertDesktopPathSafe(path)
      const [fs, pathModule] = await Promise.all([desktopFs(), desktopPath()])
      const stats = await fs.statfs(pathModule.dirname(target))
      return Number(stats.bavail) * Number(stats.bsize)
    },
    async rollbackStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) return
      const pathModule = await desktopPath()
      await assertRecoveryPaths(stagePath, targetPath)
      const fsSync = await desktopFsSync()
      const target = full(targetPath)
      const backup = full(stagePath) + ".target-backup"
      if (!(await statOrNull(backup))) {
        const residue = full(stagePath) + ".replacement-residue"
        if (await statOrNull(residue)) {
          // Crash after backup->target restored the original, but before
          // removing the parked replacement. Proof-check *both* files;
          // preserve them for manual review if anything differs.
          if (!(await confirmBackup(target, commitOptions.expectedTarget))
            || await hashFile(residue, commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
            throw new V4ManualRecoveryRequiredError(targetPath, "rollback residue exists without a provably restored original")
          }
          commitOptions.assertNoOpenEditor?.()
          if (!(await confirmBackup(target, commitOptions.expectedTarget))) {
            throw new V4ManualRecoveryRequiredError(targetPath, "restored original changed during residue cleanup")
          }
          // Do not yield between the last confirmed target proof and removing
          // the plugin-owned residue; a late directory junction must fail closed.
          if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
          fsSync.rmSync(residue)
        }
        return
      }
      if (!(await confirmBackup(backup, commitOptions.expectedTarget))) {
        throw new V4ManualRecoveryRequiredError(targetPath, "the backup has no matching original-content hash")
      }
      const residue = full(stagePath) + ".replacement-residue"
      if (await statOrNull(residue)) {
        // This is only safe to complete if it is exactly the staged replacement,
        // left by a crash after the first rename of the rollback.
        if (await statOrNull(target) || await hashFile(residue, commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
          throw new V4ManualRecoveryRequiredError(targetPath, "an unverified rollback residue exists")
        }
      } else if (await statOrNull(target)) {
        if (await hashFile(target, commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
          throw new V4ManualRecoveryRequiredError(targetPath, "local target differs from the staged replacement")
        }
        // Park rather than delete the replacement. A crash during restoration
        // leaves both the original backup and the candidate replacement intact.
        commitOptions.assertNoOpenEditor?.()
        if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
        fsSync.renameSync(target, residue)
      }
      try {
        commitOptions.assertNoOpenEditor?.()
        if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
        fsSync.renameSync(backup, target)
      } catch (error) {
        if (await statOrNull(residue) && !(await statOrNull(target))) {
          try {
            if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
            fsSync.renameSync(residue, target)
          } catch {}
        }
        throw error
      }
      if (await statOrNull(residue)) {
        if (await hashFile(residue, commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
          throw new V4ManualRecoveryRequiredError(targetPath, "rollback residue changed during recovery")
        }
        if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
        fsSync.rmSync(residue)
      }
    },
    async finalizeStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) return
      await assertRecoveryPaths(stagePath, targetPath)
      const [fsSync, pathModule] = await Promise.all([desktopFsSync(), desktopPath()])
      const backup = full(stagePath) + ".target-backup"
      if (!(await statOrNull(backup))) {
        if (await statOrNull(full(stagePath) + ".replacement-residue")) {
          throw new V4ManualRecoveryRequiredError(targetPath, "rollback residue exists without its original backup")
        }
        return
      }
      if (!(await confirmBackup(backup, commitOptions.expectedTarget))) {
        throw new V4ManualRecoveryRequiredError(targetPath, "the backup has no matching original-content hash")
      }
      if (await hashFile(full(targetPath), commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
        throw new V4ManualRecoveryRequiredError(targetPath, "final target differs from the durable staged receipt")
      }
      // The last async content hash can yield while another process swaps a
      // parent for a junction. Close that avoidable gap before deleting the
      // only verified original backup, without awaiting between path checks
      // and the native deletion. OS-handle-relative operations are still needed
      // to eliminate a concurrent process race between the two syscalls.
      if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
      fsSync.rmSync(backup)
    },
    async commitStage(stagePath, targetPath, commitOptions) {
      if (!desktopReady) throw new V4BoundedIoUnavailableError("stage-commit", targetPath)
      if (options.desktopRootPath) await assertRecoveryPaths(stagePath, targetPath)
      const fs = await desktopFs()
      const fsSync = await desktopFsSync()
      const pathModule = await desktopPath()
      const stage = full(stagePath)
      const target = full(targetPath)
      const backup = `${stage}.target-backup`
      await ensureDesktopParent(target)
      if (options.desktopRootPath) await assertRecoveryPaths(stagePath, targetPath)
      const statOrNull = async (path: string) => { try { return await fs.stat(path) } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error } }
      const targetBefore = await statOrNull(target)
      const expected = commitOptions.expectedTarget
      if (expected.exists !== !!targetBefore
        || (expected.exists && expected.size !== undefined && targetBefore!.size !== expected.size)
        || (expected.exists && expected.mtime !== undefined && Math.round(targetBefore!.mtimeMs) !== Math.round(expected.mtime))) {
        throw new Error(`V4 local target changed before staged commit: ${targetPath}`)
      }
      const stageStat = await fs.stat(stage)
      if (stageStat.size !== commitOptions.expectedStageSize) throw new Error(`V4 staged content size changed before commit: ${stagePath}`)
      // Do not remove the only complete staged copy before checking its bytes.
      // After a rename, hash mismatches may represent concurrent user edits.
      if (await hashFile(stage, commitOptions.expectedStageSize) !== commitOptions.expectedStageSha256) {
        throw new V4ManualRecoveryRequiredError(targetPath, "staged content hash changed before replacement")
      }
      if (expected.exists && expected.hash) {
        if (await hashFile(target, expected.size!) !== expected.hash) {
          throw new V4ManualRecoveryRequiredError(targetPath, "the original target hash changed before staged commit")
        }
      }
      // A surviving backup belongs to an unresolved transaction.
      // Never silently discard it at the start of the next commit.
      if (await statOrNull(backup) || await statOrNull(stage + ".replacement-residue")) {
        throw new V4ManualRecoveryRequiredError(targetPath, "unresolved staged backup or rollback residue exists")
      }
      let backedUp = false
      let stageMoved = false
      try {
        if (options.desktopRootPath) await assertRecoveryPaths(stagePath, targetPath)
        commitOptions.assertNoOpenEditor?.()
        if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
        if (targetBefore) { fsSync.renameSync(target, backup); backedUp = true }
        // Recheck without yielding between the two synchronous renames.
        // If the guard vetoes, restore the verified original backup.
        commitOptions.assertNoOpenEditor?.()
        if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
        fsSync.renameSync(stage, target); stageMoved = true
        const after = await fs.stat(target)
        if (after.size !== commitOptions.expectedStageSize) throw new Error(`V4 committed target size mismatch: ${targetPath}`)
        const hash = createV4IncrementalSha256()
        for await (const chunk of desktopBoundedSource(target, commitOptions.expectedStageSize).chunks(4 * 1024 * 1024)) hash.update(chunk)
        if (hash.digestHex() !== commitOptions.expectedStageSha256) throw new Error(`V4 committed target hash mismatch: ${targetPath}`)
        // Retain the original until the caller saves a durable WAL receipt.
        // finalizeStage re-verifies it and cleans it only after that receipt.
      } catch (error) {
        if (stageMoved) {
          // A caller/user may have changed the newly moved target while the
          // verification was running. Never delete it or overwrite it with the
          // backup based on a size or cached SHA guess.
          throw new V4ManualRecoveryRequiredError(targetPath, `staged replacement requires review after an interrupted commit (${(error as Error).message})`)
        }
        if (backedUp) {
          if (!(await confirmBackup(backup, expected)) || await statOrNull(target)) {
            throw new V4ManualRecoveryRequiredError(targetPath, "backup cannot be proven safe after the staged rename failed")
          }
          try {
            if (options.desktopRootPath) assertRecoveryPathsSync(stagePath, targetPath, fsSync, pathModule)
            fsSync.renameSync(backup, target)
          }
          catch {
            throw new V4ManualRecoveryRequiredError(targetPath, "verified original backup could not be restored")
          }
        }
        throw error
      }
    },
  }
}
