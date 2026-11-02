import { utf8ToBytes } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"
import { planV4PluginPrivateWalLocation } from "./reencryption-plugin-wal-location"

const MAX_SLOT_BYTES = 2 * 1024 * 1024

interface MobileWalStat {
  readonly type: "file" | "folder"
  readonly size: number
  readonly mtime: number
}

interface MobileWalListing {
  readonly files: readonly string[]
  readonly folders: readonly string[]
}

export interface V4MobilePluginWalOwner {
  /** The current Obsidian vault.adapter, not a separate plugin-private adapter. */
  readonly adapter: {
    stat(path: string): Promise<MobileWalStat | null>
    list(path: string): Promise<MobileWalListing>
    read(path: string): Promise<string>
  }
  readonly configDir: string
  readonly pluginId: string
  readonly runId: string
  readonly assertLiveOwner: () => void
}

export interface V4MobileWalRecoveryReader {
  /** Relative to the plugin storage root, so D237 can use the same root. */
  readonly journalRoot: string
  readonly adapter: Readonly<Pick<V4LocalIndexAdapter, "read" | "exists">>
  readonly cooperativeOsLeaseProven: false
  readonly powerLossDurabilityProven: false
  readonly resumeSyncAuthorized: false
  readonly localCutoverAuthorized: false
}

function validStat(stat: MobileWalStat | null, kind: MobileWalStat["type"]): stat is MobileWalStat {
  return stat !== null && stat.type === kind
    && Number.isSafeInteger(stat.size) && stat.size >= 0
    && Number.isFinite(stat.mtime) && stat.mtime >= 0
    && (kind === "folder" || stat.size <= MAX_SLOT_BYTES)
}

function unchangedStat(first: MobileWalStat, second: MobileWalStat | null): boolean {
  return validStat(second, "file") && first.size === second.size && first.mtime === second.mtime
}

/**
 * Mobile Obsidian-Adapter read-only checkpoint preflight.
 * No Node APIs, OS lock, symlink proof, writer, automatic cutover or rollback.
 * The caller must still establish a cooperating owner/lease separately.
 */
export async function openV4MobilePluginWalForRecovery(
  input: V4MobilePluginWalOwner,
): Promise<V4MobileWalRecoveryReader> {
  const { adapter, configDir, pluginId, runId, assertLiveOwner } = input
  if (!adapter || typeof adapter.stat !== "function"
    || typeof adapter.list !== "function" || typeof adapter.read !== "function"
    || typeof assertLiveOwner !== "function") {
    throw Error("Re-encryption Mobile WAL requires the live Obsidian adapter.")
  }
  const methods = { stat: adapter.stat, list: adapter.list, read: adapter.read }
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const directory = layout.vaultLogicalWalRoot
  const slots = [
    directory + "/slot-0.json",
    directory + "/slot-1.json",
  ]
  const checkOwner = () => {
    assertLiveOwner()
    if (input.adapter !== adapter || input.configDir !== configDir
      || input.pluginId !== pluginId || input.runId !== runId
      || input.assertLiveOwner !== assertLiveOwner
      || adapter.stat !== methods.stat || adapter.list !== methods.list
      || adapter.read !== methods.read) {
      throw Error("Re-encryption Mobile WAL owner or reader changed.")
    }
  }
  const readStat = async (location: string) => {
    checkOwner()
    const result = await methods.stat.call(adapter, location)
    checkOwner()
    return result
  }
  const assertContents = async () => {
    checkOwner()
    const result = await methods.list.call(adapter, directory)
    checkOwner()
    if (!result || !Array.isArray(result.files) || !Array.isArray(result.folders)
      || result.folders.length !== 0 || result.files.length !== 2
      || result.files.slice().sort().join("|") !== slots.slice().sort().join("|")) {
      throw Error("Re-encryption Mobile WAL is missing a slot or has foreign artifacts.")
    }
  }
  const pathParts = directory.split("/")
  for (let i = 1; i <= pathParts.length; i++) {
    const part = pathParts.slice(0, i).join("/")
    if (!validStat(await readStat(part), "folder")) {
      throw Error("Re-encryption Mobile WAL is not an existing plugin-private directory.")
    }
  }
  await assertContents()
  const firstStats: MobileWalStat[] = []
  for (const slot of slots) {
    const info = await readStat(slot)
    if (!validStat(info, "file")) {
      throw Error("Re-encryption Mobile WAL slot missing or too large.")
    }
    firstStats.push(Object.freeze({ ...info }))
  }

  const verifyRead = async (logical: string): Promise<string> => {
    const index = [layout.journalRoot + "/slot-0.json",
      layout.journalRoot + "/slot-1.json"].indexOf(logical)
    if (index < 0) throw Error("Re-encryption Mobile WAL read outside its two slots.")
    await assertContents()
    const full = slots[index]!
    const before = await readStat(full)
    if (!unchangedStat(firstStats[index]!, before)) throw Error("Re-encryption Mobile WAL slot changed.")
    checkOwner()
    const first = await methods.read.call(adapter, full)
    checkOwner()
    if (typeof first !== "string" || utf8ToBytes(first).length > MAX_SLOT_BYTES) {
      throw Error("Re-encryption Mobile WAL returned invalid or oversized data.")
    }
    const second = await methods.read.call(adapter, full)
    checkOwner()
    if (second !== first || !unchangedStat(firstStats[index]!, await readStat(full))) {
      throw Error("Re-encryption Mobile WAL slot changed during readback.")
    }
    await assertContents()
    return first
  }
  await verifyRead(layout.journalRoot + "/slot-0.json")
  await verifyRead(layout.journalRoot + "/slot-1.json")
  return Object.freeze({
    journalRoot: layout.journalRoot,
    adapter: Object.freeze({
      read: verifyRead,
      exists: async (logical: string) => {
        await verifyRead(logical)
        return true
      },
    }),
    cooperativeOsLeaseProven: false as const,
    powerLossDurabilityProven: false as const,
    resumeSyncAuthorized: false as const,
    localCutoverAuthorized: false as const,
  })
}
