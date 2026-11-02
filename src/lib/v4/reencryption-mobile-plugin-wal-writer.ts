import { utf8ToBytes } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"
import { createV4PersistedWalFenceAssertion } from "./reencryption-persisted-wal-fence"
import { planV4PluginPrivateWalLocation } from "./reencryption-plugin-wal-location"

const MAX_SLOT_BYTES = 2 * 1024 * 1024

/** Only a local, per-Adapter cooperating writer guard. NOT an OS/file lock. */
const activeAdapters = new WeakSet<object>()

interface MobileStat {
  readonly type: "file" | "folder"
  readonly size: number
  readonly mtime: number
}

interface MobileListing {
  readonly files: readonly string[]
  readonly folders: readonly string[]
}

export interface V4MobilePluginWalWriterInput {
  /** Live Obsidian Vault Adapter. No Node filesystem, rename or local paths. */
  readonly adapter: {
    stat(path: string): Promise<MobileStat | null>
    list(path: string): Promise<MobileListing>
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
    mkdir(path: string): Promise<void>
  }
  /** D173 Index adapter over exactly this plugin-private Vault namespace. */
  readonly fenceAdapter: Pick<V4LocalIndexAdapter, "read" | "exists">
  readonly configDir: string
  readonly pluginId: string
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly assertLiveOwner: () => void
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly assertSyncFenceArmed: () => Promise<void>
}

export interface V4MobilePluginWalWriter {
  readonly journalRoot: string
  readonly adapter: V4LocalIndexAdapter
  readonly assertBestEffortCheckpoint: () => Promise<"best-effort-double-read-only">
  readonly release: () => void
  readonly cooperativeOsLeaseProven: false
  readonly atomicSlotWritesProven: false
  readonly powerLossDurabilityProven: false
  readonly resumeSyncAuthorized: false
  readonly cutoverAuthorized: false
}

function manual(): never {
  throw Error("Mobile Re-encryption WAL evidence is uncertain; keep all files for Manual Recovery.")
}

/**
 * Create one new run-local WAL through Obsidian's Mobile adapter.
 * This is intentionally weaker than the Desktop Node OS-exclusive writer:
 * mkdir/stat/list/readback do NOT prove exclusive cross-process creation,
 * durable writes, or an atomic replacement. Any ambiguity poisons this
 * writer permanently; it never deletes/retries or grants publication.
 */
export async function openV4NewMobilePluginWalWriter(
  input: V4MobilePluginWalWriterInput,
): Promise<V4MobilePluginWalWriter> {
  const { adapter, fenceAdapter, configDir, pluginId, runId, sourceRepoId,
    destinationRepoId, assertLiveOwner, assertExclusiveInitiatorLease,
    assertSyncFenceArmed } = input
  if (!adapter || typeof adapter.stat !== "function" || typeof adapter.list !== "function"
    || typeof adapter.read !== "function" || typeof adapter.write !== "function"
    || typeof adapter.mkdir !== "function" || typeof assertLiveOwner !== "function"
    || typeof assertExclusiveInitiatorLease !== "function"
    || typeof assertSyncFenceArmed !== "function") manual()

  if (activeAdapters.has(adapter)) manual()
  activeAdapters.add(adapter)
  try {
    const methods = {
      stat: adapter.stat, list: adapter.list, read: adapter.read,
      write: adapter.write, mkdir: adapter.mkdir,
    }
    const persistedFence = createV4PersistedWalFenceAssertion({
      adapter: fenceAdapter, runId, sourceRepoId, destinationRepoId, assertLiveOwner,
    })
    const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
    const directory = layout.vaultLogicalWalRoot
    const parent = layout.pluginStorageRoot + "/reencryption-wal"
    const allowedDirs = new Set([parent, directory])
    const slots = [
      directory + "/slot-0.json",
      directory + "/slot-1.json",
    ] as const
    const expected = new Map<string, string>()
    let poisoned = false
    let released = false
    let mutationActive = false
    let activeReaders = 0

    const owner = () => {
      assertLiveOwner()
      if (released || poisoned || input.adapter !== adapter
        || input.fenceAdapter !== fenceAdapter || input.configDir !== configDir
        || input.pluginId !== pluginId || input.runId !== runId
        || input.sourceRepoId !== sourceRepoId || input.destinationRepoId !== destinationRepoId
        || input.assertLiveOwner !== assertLiveOwner
        || input.assertExclusiveInitiatorLease !== assertExclusiveInitiatorLease
        || input.assertSyncFenceArmed !== assertSyncFenceArmed
        || adapter.stat !== methods.stat || adapter.list !== methods.list
        || adapter.read !== methods.read || adapter.write !== methods.write
        || adapter.mkdir !== methods.mkdir) manual()
    }
    const ready = async () => {
      owner()
      await assertExclusiveInitiatorLease()
      owner()
      await assertSyncFenceArmed()
      owner()
      await persistedFence()
      owner()
    }
    const stat = async (name: string) => {
      owner()
      const result = await methods.stat.call(adapter, name)
      owner()
      return result
    }
    const dir = async (name: string) => {
      const info = await stat(name)
      if (info?.type !== "folder") manual()
    }
    const list = async () => {
      owner()
      const result = await methods.list.call(adapter, directory)
      owner()
      if (!result || !Array.isArray(result.files) || !Array.isArray(result.folders)
        || result.folders.length || result.files.length !== expected.size
        || result.files.some((name: string) => !expected.has(name))
        || new Set(result.files).size !== expected.size) manual()
    }
    const readExact = async (name: string, expectedText: string): Promise<string> => {
      const before = await stat(name)
      if (!before || before.type !== "file"
        || !Number.isSafeInteger(before.size) || before.size < 0
        || before.size > MAX_SLOT_BYTES || !Number.isFinite(before.mtime)) manual()
      owner()
      const first = await methods.read.call(adapter, name)
      owner()
      if (typeof first !== "string" || first !== expectedText
        || utf8ToBytes(first).length !== before.size) manual()
      const second = await methods.read.call(adapter, name)
      owner()
      const after = await stat(name)
      if (second !== first || after?.type !== "file"
        || after.size !== before.size || after.mtime !== before.mtime) manual()
      return first
    }
    const inventory = async () => {
      await dir(directory)
      await list()
      for (const [name, data] of expected) await readExact(name, data)
      await list()
    }
    const checked = async <T>(work: () => Promise<T>, mutates: boolean): Promise<T> => {
      // The encrypted Journal reads both WAL slots concurrently. Readers may
      // overlap each other, but never a write or directory mutation.
      if (released || poisoned || mutationActive || (mutates && activeReaders > 0)) manual()
      if (mutates) mutationActive = true
      else activeReaders++
      try {
        await ready()
        await inventory()
        const result = await work()
        await inventory()
        await ready()
        return result
      } catch (error) {
        // A partial or acknowledged-but-uncertain overwrite can destroy
        // a generation. Keep it exactly as-is and never attempt again.
        poisoned = true
        throw error
      } finally {
        if (mutates) mutationActive = false
        else activeReaders--
      }
    }

    await ready()
    const components = layout.pluginStorageRoot.split("/")
    for (let i = 1; i <= components.length; i++) {
      await dir(components.slice(0, i).join("/"))
    }
    if (await stat(directory) !== null) manual()
    const parentInfo = await stat(parent)
    if (parentInfo === null) {
      await ready()
      await methods.mkdir.call(adapter, parent)
      await ready()
    }
    await dir(parent)
    // This is NOT an atomic create-if-absent across independent processes.
    // The initiating-device lease must rule out other cooperating writers.
    await ready()
    if (await stat(directory) !== null) manual()
    await methods.mkdir.call(adapter, directory)
    await ready()
    await dir(directory)
    await list()
    return Object.freeze({
      journalRoot: layout.journalRoot,
      adapter: Object.freeze({
        read: (name: string) => checked(async () => {
          const full = layout.pluginStorageRoot + "/" + name
          if (!slots.includes(full as typeof slots[number])) manual()
          const data = expected.get(full)
          if (data === undefined) manual()
          return readExact(full, data)
        }, false),
        exists: (name: string) => checked(async () => {
          const full = layout.pluginStorageRoot + "/" + name
          if (!slots.includes(full as typeof slots[number])) manual()
          return expected.has(full)
        }, false),
        mkdir: (name: string) => checked(async () => {
          const full = layout.pluginStorageRoot + "/" + name
          if (!allowedDirs.has(full)) manual()
          await dir(full)
        }, true),
        write: (name: string, data: string) => checked(async () => {
          const full = layout.pluginStorageRoot + "/" + name
          if (!slots.includes(full as typeof slots[number])
            || typeof data !== "string" || utf8ToBytes(data).length > MAX_SLOT_BYTES) manual()
          await methods.write.call(adapter, full, data)
          // Recheck the new ciphertext *before* recording the post-image.
          await readExact(full, data)
          expected.set(full, data)
        }, true),
      }),
      assertBestEffortCheckpoint: () => checked(
        async () => "best-effort-double-read-only" as const, false),
      release: () => {
        if (mutationActive) manual()
        if (!released) {
          released = true
          activeAdapters.delete(adapter)
        }
      },
      cooperativeOsLeaseProven: false as const,
      atomicSlotWritesProven: false as const,
      powerLossDurabilityProven: false as const,
      resumeSyncAuthorized: false as const,
      cutoverAuthorized: false as const,
    })
  } catch (error) {
    activeAdapters.delete(adapter)
    throw error
  }
}
