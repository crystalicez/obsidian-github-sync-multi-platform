import { randomBytes, toBase64Url } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"

/**
 * Desktop-only, isolated-stage proof of Node filesystem WAL semantics.
 * NOT connected to the production migration wizard.
 *
 * The new run must hold a process-exclusive .exclusive.lock. Losing the lock
 * fails closed. No timeout, PID or automatic stale-lock reclamation: a crash
 * can leave the lock behind, and an operator must investigate before retry.
 */
export class V4DesktopRekeyWalRecoveryRequiredError extends Error {
  constructor() {
    super("Re-encryption Desktop WAL contains unrecognized interrupted temporary data; manual recovery required.")
    this.name = "V4DesktopRekeyWalRecoveryRequiredError"
  }
}

export class V4DesktopRekeyWalLockError extends Error {
  constructor(message = "Re-encryption Desktop WAL exclusive lock is absent, busy, or changed.") {
    super(message)
    this.name = "V4DesktopRekeyWalLockError"
  }
}

const MAX_SLOT_BYTES = 2 * 1024 * 1024
const SAFE_DIR = /^[a-zA-Z0-9_-]{1,64}$/u
const DENIED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu
const SYNC_UNSUPPORTED = new Set(["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EISDIR"])

function validRelativeRoot(root: string): readonly string[] {
  const parts = root.split("/")
  if (parts.length < 2 || parts.length > 8
    || parts.some(p => !SAFE_DIR.test(p) || DENIED_WINDOWS_NAMES.test(p))) {
    throw new Error("Invalid relative re-encryption Desktop WAL directory.")
  }
  return parts
}

async function desktopIo() {
  const [fs, path] = await Promise.all([
    import("node:fs/promises"), import("node:path"),
  ])
  return { fs, path }
}

export interface V4DesktopRekeyWalStorage {
  readonly adapter: V4LocalIndexAdapter
  readonly lockPath: string
  assertExclusiveStageLease(): Promise<void>
  /**
   * Windows may not support directory sync via Node fs. Always fail closed
   * rather than claiming power-loss durable intent without directory sync.
   */
  assertCrashDurable(): Promise<void>
  release(): Promise<void>
}

/**
 * rootAbsolute MUST be an existing, explicitly authorized, private directory.
 * It is NEVER inferred from the live user vault, and test callers use their
 * own disposable OS temp directory. Do not pass untrusted roots.
 */
export async function acquireV4DesktopRekeyWalStorage(options: {
  readonly rootAbsolute: string
  readonly journalRoot: string
}): Promise<V4DesktopRekeyWalStorage> {
  const { fs, path } = await desktopIo()
  const parts = validRelativeRoot(options.journalRoot)
  if (!path.isAbsolute(options.rootAbsolute)) {
    throw new Error("Re-encryption Desktop WAL requires a trusted absolute root.")
  }
  const root = path.resolve(options.rootAbsolute)
  const statRoot = await fs.lstat(root)
  if (!statRoot.isDirectory() || statRoot.isSymbolicLink()
    || (await fs.realpath(root)).toLowerCase() !== root.toLowerCase()) {
    throw new Error("Re-encryption Desktop WAL root is unsafe or a symlink/junction.")
  }
  const directory = path.join(root, ...parts)
  const lockPath = path.join(directory, ".exclusive.lock")
  const ensureSafeDir = async (segments: readonly string[], create: boolean): Promise<void> => {
    let current = root
    for (const segment of segments) {
      current = path.join(current, segment)
      let stat: Awaited<ReturnType<typeof fs.lstat>>
      try { stat = await fs.lstat(current) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error
        await fs.mkdir(current, { mode: 0o700 })
        stat = await fs.lstat(current)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (await fs.realpath(current)).toLowerCase() !== current.toLowerCase()) {
        throw new Error("Re-encryption Desktop WAL directory is a symlink/junction or unsafe.")
      }
    }
  }

  await ensureSafeDir(parts, true)
  const token = toBase64Url(randomBytes(24))
  let lockHandle: Awaited<ReturnType<typeof fs.open>>
  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new V4DesktopRekeyWalLockError()
    throw error
  }

  let closed = false
  let directorySyncConfirmed = false
  const syncDirectory = async (): Promise<void> => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(directory, "r")
      await handle.sync()
      directorySyncConfirmed = true
    } catch (error) {
      if (!SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      directorySyncConfirmed = false
    } finally {
      await handle?.close()
    }
  }
  const assertHeld = async (): Promise<void> => {
    if (closed) throw new V4DesktopRekeyWalLockError("Re-encryption Desktop WAL lease already released.")
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      await ensureSafeDir(parts, false)
      const link = await fs.lstat(lockPath)
      const held = await lockHandle.stat()
      if (!link.isFile() || link.isSymbolicLink()
        || link.ino !== held.ino || link.dev !== held.dev) {
        throw new V4DesktopRekeyWalLockError()
      }
      stat = link
      const current = await fs.readFile(lockPath, "utf8")
      if (current !== token || stat.size !== token.length) {
        throw new V4DesktopRekeyWalLockError()
      }
    } catch {
      throw new V4DesktopRekeyWalLockError()
    }
  }

  try {
    await lockHandle.writeFile(token, "utf8")
    await lockHandle.sync()
    await syncDirectory()
    // Never silently ignore a temp slot that may represent an interrupted
    // transaction. It can contain evidence newer than the last valid WAL.
    const entries = await fs.readdir(directory)
    if (entries.some(entry => ![".exclusive.lock", "slot-0.json", "slot-1.json"].includes(entry))) {
      throw new V4DesktopRekeyWalRecoveryRequiredError()
    }
  } catch (error) {
    await lockHandle.close()
    // The lock was exclusively created by this operation, so it may be
    // removed on construction failure. NEVER reclaim a preexisting lock.
    await fs.unlink(lockPath)
    throw error
  }
  const prefixes = new Set(parts.map((_, i) => parts.slice(0, i + 1).join("/")))
  const slotPath = (logical: string): string => {
    if (logical !== options.journalRoot + "/slot-0.json"
      && logical !== options.journalRoot + "/slot-1.json") {
      throw new Error("Re-encryption Desktop WAL unsafe slot path.")
    }
    return path.join(directory, logical.endsWith("slot-0.json") ? "slot-0.json" : "slot-1.json")
  }
  const safeFile = async (filename: string): Promise<boolean> => {
    await ensureSafeDir(parts, false)
    try {
      const info = await fs.lstat(filename)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Re-encryption Desktop WAL unsafe symlink/junction slot.")
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }
  const adapter: V4LocalIndexAdapter = Object.freeze({
    async exists(logical: string) {
      const filename = slotPath(logical)
      await assertHeld()
      return safeFile(filename)
    },
    async read(logical: string) {
      const filename = slotPath(logical)
      await assertHeld()
      if (!(await safeFile(filename))) throw new Error("Re-encryption Desktop WAL slot not found.")
      const stat = await fs.stat(filename)
      if (stat.size > MAX_SLOT_BYTES) throw new Error("Re-encryption Desktop WAL slot exceeds size limit.")
      return fs.readFile(filename, "utf8")
    },
    async mkdir(logical: string) {
      await assertHeld()
      if (!prefixes.has(logical)) throw new Error("Re-encryption Desktop WAL unsafe directory.")
      await ensureSafeDir(parts.slice(0, logical.split("/").length), true)
    },
    async write(logical: string, text: string) {
      const target = slotPath(logical)
      await assertHeld()
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SLOT_BYTES) {
        throw new Error("Re-encryption Desktop WAL slot exceeds size limit.")
      }
      await safeFile(target)
      const temporary = path.join(directory, ".slot-" + toBase64Url(randomBytes(18)) + ".tmp")
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(temporary, "wx", 0o600)
        await handle.writeFile(text, "utf8")
        await handle.sync() // file data + inode flushed before atomic rename
        await handle.close()
        handle = undefined
        await assertHeld()
        await safeFile(target) // reject late symlink before rename
        await fs.rename(temporary, target) // never unlink the prior valid slot
        await syncDirectory()
      } finally {
        await handle?.close()
        try { await fs.unlink(temporary) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    },
  })

  return Object.freeze({
    adapter, lockPath,
    assertExclusiveStageLease: assertHeld,
    async assertCrashDurable() {
      await assertHeld()
      if (!directorySyncConfirmed) {
        throw new Error("Re-encryption Desktop WAL directory fsync is not supported; crash durability is unproven.")
      }
    },
    async release() {
      await assertHeld()
      closed = true
      await fs.unlink(lockPath)
      try { await syncDirectory() } finally { await lockHandle.close() }
    },
  })
}
