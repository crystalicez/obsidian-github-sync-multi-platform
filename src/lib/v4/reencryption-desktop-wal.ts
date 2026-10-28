import { randomBytes, toBase64Url } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"

/**
 * Desktop-only, isolated-stage proof of Node filesystem WAL semantics.
 * NOT connected to the production migration wizard.
 *
 * The new run must hold a process-exclusive .exclusive.lock. Losing the lock
 * fails closed. This lock excludes only COOPERATING WAL clients; it does NOT
 * prevent an independent OS process, external writer, or Obsidian editor from
 * modifying the underlying files. Never use it as a global Vault edit fence
 * or as cutover authority. No timeout, PID or automatic stale-lock reclamation:
 * a crash can leave the lock behind for manual investigation.
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

/**
 * Each WAL rename changes the leaf directory. A previous successful fsync
 * must NEVER certify a later rename whose fsync throws before completion.
 * Kept independently testable so exceptional I/O outcomes cannot leave a
 * stale-positive durability claim.
 */
export class V4RekeyWalDirectorySyncProof {
  private confirmed = false
  private latestAttempt = 0
  private activeSyncs = 0
  private overlapObserved = false

  async refresh(parentSyncConfirmed: boolean, syncLeaf: () => Promise<boolean>): Promise<void> {
    const attempt = ++this.latestAttempt
    this.confirmed = false
    this.activeSyncs++
    if (this.activeSyncs > 1) this.overlapObserved = true
    try {
      const leafSynced = await syncLeaf()
      // An overlapping or older completion cannot vouch for all later WAL
      // renames. Require a fresh, nonoverlapping sync before declaring durable.
      this.confirmed = attempt === this.latestAttempt
        && this.activeSyncs === 1 && !this.overlapObserved
        && parentSyncConfirmed && leafSynced
    } finally {
      this.activeSyncs--
      if (this.activeSyncs > 0) this.confirmed = false
      else this.overlapObserved = false
    }
  }

  // Any new WAL mutation invalidates prior fsync evidence synchronously,
  // BEFORE its first asynchronous filesystem operation or rename.
  invalidate(): void {
    this.confirmed = false
  }

  assertConfirmed(): void {
    if (!this.confirmed) {
      throw new Error("Re-encryption Desktop WAL directory fsync is not supported; crash durability is unproven.")
    }
  }
}

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
    // Exclusive creation is unchanged; read/write access lets us verify the
    // ownership token through the same pinned inode instead of reopening by path.
    lockHandle = await fs.open(lockPath, "wx+", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new V4DesktopRekeyWalLockError()
    throw error
  }

  let closed = false
  let releasing = false
  let writing = false
  let activeOperations = 0
  let finishDrain: (() => void) | undefined
  // Claim synchronously, before the first fs await. A release must NEVER
  // unlink its exclusive lock while an adapter read/write is still in flight.
  const withLiveLease = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed || releasing) throw new V4DesktopRekeyWalLockError()
    activeOperations++
    try { return await operation() } finally {
      activeOperations--
      if (activeOperations === 0) {
        const resolve = finishDrain
        finishDrain = undefined
        resolve?.()
      }
    }
  }
  const drainActiveOperations = async (): Promise<void> => {
    if (activeOperations === 0) return
    // Releasing is already true; no new operations may enter. Wait for any
    // reads/writes still active after a Promise.all fail-fast rejection.
    await new Promise<void>(resolve => { finishDrain = resolve })
  }
  const directorySyncProof = new V4RekeyWalDirectorySyncProof()
  // WAL directory creation changes PARENT directory entries. Fsyncing only
  // the WAL leaf cannot prove that newly created parents survive power loss.
  // The trusted root is pre-existing; sync each parent within its boundary
  // once after mkdir, then sync the WAL leaf after every later slot rename.
  let ancestorSyncConfirmed = false
  const syncOneDirectory = async (name: string): Promise<boolean> => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(name, "r")
      await handle.sync()
      return true
    } catch (error) {
      if (!SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      return false
    } finally {
      await handle?.close()
    }
  }
  const syncCreatedDirectoryParents = async (): Promise<boolean> => {
    let parent = root
    for (const segment of parts) {
      if (!(await syncOneDirectory(parent))) return false
      parent = path.join(parent, segment)
    }
    return true
  }
  const syncDirectory = async (): Promise<void> => {
    await directorySyncProof.refresh(ancestorSyncConfirmed, () => syncOneDirectory(directory))
  }
  const assertHeld = async (): Promise<void> => {
    if (closed) throw new V4DesktopRekeyWalLockError("Re-encryption Desktop WAL lease already released.")
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      await ensureSafeDir(parts, false)
      const link = await fs.lstat(lockPath)
      const held = await lockHandle.stat()
      if (!link.isFile() || link.isSymbolicLink()
        || link.nlink !== 1 || held.nlink !== 1
        || link.ino === 0 || held.ino === 0
        || link.ino !== held.ino || link.dev !== held.dev) {
        throw new V4DesktopRekeyWalLockError()
      }
      stat = link
      // Read through the pinned lock handle, not a second pathname open.
      // A concurrent rename/symlink swap cannot redirect token validation.
      const currentBytes = Buffer.alloc(token.length + 1)
      const { bytesRead } = await lockHandle.read(currentBytes, 0, currentBytes.length, 0)
      if (stat.size !== token.length || bytesRead !== token.length
        || currentBytes.toString("utf8", 0, bytesRead) !== token) {
        throw new V4DesktopRekeyWalLockError()
      }
    } catch {
      throw new V4DesktopRekeyWalLockError()
    }
  }

  try {
    await lockHandle.writeFile(token, "utf8")
    await lockHandle.sync()
    ancestorSyncConfirmed = await syncCreatedDirectoryParents()
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
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new Error("Re-encryption Desktop WAL unsafe symlink, junction or hardlinked slot.")
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }
  const rawAdapter: V4LocalIndexAdapter = Object.freeze({
    async exists(logical: string) {
      const filename = slotPath(logical)
      await assertHeld()
      return safeFile(filename)
    },
    async read(logical: string) {
      const filename = slotPath(logical)
      await assertHeld()
      if (!(await safeFile(filename))) throw new Error("Re-encryption Desktop WAL slot not found.")
      // Bind validation and data access to the SAME opened inode. Reading by
      // pathname after lstat allowed a concurrent path replacement (including
      // an external symlink) to redirect the read outside the WAL root.
      const handle = await fs.open(filename, "r")
      try {
        const current = await fs.lstat(filename, { bigint: true })
        const opened = await handle.stat({ bigint: true })
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
          || !opened.isFile() || opened.nlink !== BigInt(1)
          || current.ino === BigInt(0) || opened.ino === BigInt(0)
          || current.dev !== opened.dev || current.ino !== opened.ino) {
          throw new Error("Re-encryption Desktop WAL slot changed during read.")
        }
        if (opened.size > BigInt(MAX_SLOT_BYTES)) throw new Error("Re-encryption Desktop WAL slot exceeds size limit.")
        // Even if an uncooperative external writer grows the inode AFTER
        // stat(), never allocate/read beyond our 2 MiB slot size budget.
        const chunks: Buffer[] = []
        let count = 0
        while (count <= MAX_SLOT_BYTES) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SLOT_BYTES + 1 - count))
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, count)
          if (bytesRead === 0) break
          count += bytesRead
          chunks.push(chunk.subarray(0, bytesRead))
        }
        if (count > MAX_SLOT_BYTES) throw new Error("Re-encryption Desktop WAL slot exceeds size limit.")
        return Buffer.concat(chunks, count).toString("utf8")
      } finally {
        await handle.close()
      }
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

  // Hide the raw filesystem adapter. Each outward operation holds the live
  // lease until ALL async I/O (including temporary-file cleanup) finishes.
  const adapter: V4LocalIndexAdapter = Object.freeze({
    exists: (logical: string) => withLiveLease(() => rawAdapter.exists(logical)),
    read: (logical: string) => withLiveLease(() => rawAdapter.read(logical)),
    mkdir: (logical: string) => withLiveLease(() => rawAdapter.mkdir(logical)),
    async write(logical: string, value: string) {
      // A real WAL lease may have multiple consumers. Do not permit direct
      // adapter callers to race two independent slot renames under that lease.
      if (writing || closed || releasing) {
        throw new V4DesktopRekeyWalLockError("Re-encryption Desktop WAL already has an active writer.")
      }
      writing = true
      // A previously fsynced generation cannot certify a newly begun write.
      directorySyncProof.invalidate()
      try { await withLiveLease(() => rawAdapter.write(logical, value)) }
      finally { writing = false }
    },
  })

  return Object.freeze({
    adapter, lockPath,
    assertExclusiveStageLease: () => withLiveLease(assertHeld),
    assertCrashDurable: () => withLiveLease(async () => {
      await assertHeld()
      if (writing) {
        throw new Error("Re-encryption Desktop WAL has an active write; crash durability is unproven.")
      }
      directorySyncProof.assertConfirmed()
    }),
    async release() {
      // Claim release before any await; new operations are now forbidden.
      // Retain the OS lock while earlier I/O drains, including sibling reads
      // still running after a fail-fast Promise.all rejected elsewhere.
      if (closed || releasing) {
        throw new V4DesktopRekeyWalLockError("Re-encryption Desktop WAL lease is already releasing or released.")
      }
      releasing = true
      try {
        await drainActiveOperations()
        await assertHeld()
        await fs.unlink(lockPath)
        closed = true
        try { await syncDirectory() } finally { await lockHandle.close() }
      } finally {
        releasing = false
      }
    },
  })
}
