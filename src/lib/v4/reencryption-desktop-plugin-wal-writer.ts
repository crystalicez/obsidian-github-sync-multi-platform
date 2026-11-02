import type { V4LocalIndexAdapter } from "./local-index"
import { acquireV4DesktopRekeyWalStorage, type V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import { resolveV4DesktopPluginWalOwner, type V4DesktopPluginWalOwner } from "./reencryption-desktop-plugin-wal-owner"

export interface V4DesktopPluginWalWriter
  extends Pick<V4DesktopRekeyWalStorage,
    "lockPath" | "assertExclusiveStageLease" | "assertBestEffortCheckpoint" | "release"> {
  readonly journalRoot: string
  readonly adapter: V4LocalIndexAdapter
  readonly crashDurabilityProven: false
  readonly resumeSyncAuthorized: false
  readonly cutoverAuthorized: false
}

/**
 * Isolated Desktop authoring boundary; NOT wired to the installed Wizard.
 * Both callbacks must observe the CURRENT initiating plugin, not a saved
 * assertion. An armed Sync Fence is required even for the first WAL write.
 */
export interface V4DesktopPluginWalWriterInput extends V4DesktopPluginWalOwner {
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly assertSyncFenceArmed: () => Promise<void>
}

/**
 * Create one new encrypted WAL directory, never reuse an interrupted run.
 * The D164 filesystem factory atomically mkdirs the WAL leaf and obtains its
 * OS-exclusive cooperative lock. A lost owner/fence leaves the WAL evidence
 * for Manual Recovery; this function has no automatic rollback or cleanup.
 */
export async function openV4NewDesktopPluginWalWriter(
  input: V4DesktopPluginWalWriterInput,
): Promise<V4DesktopPluginWalWriter> {
  const lease = input.assertExclusiveInitiatorLease
  const fence = input.assertSyncFenceArmed
  if (typeof lease !== "function" || typeof fence !== "function") {
    throw Error("Desktop WAL authoring requires a live migration lease and persisted Sync Fence.")
  }
  const owner = await resolveV4DesktopPluginWalOwner(input)
  const assertReady = async () => {
    owner.checkOwner()
    if (input.assertExclusiveInitiatorLease !== lease || input.assertSyncFenceArmed !== fence) {
      throw Error("Re-encryption WAL initiating lease or Sync Fence callback changed.")
    }
    await lease()
    owner.checkOwner()
    await fence()
    owner.checkOwner()
    await owner.assertPhysicalOwner()
    if (input.assertExclusiveInitiatorLease !== lease || input.assertSyncFenceArmed !== fence) {
      throw Error("Re-encryption WAL initiating lease or Sync Fence callback changed.")
    }
  }
  await assertReady()
  const opened = await acquireV4DesktopRekeyWalStorage({
    rootAbsolute: owner.rootAbsolute,
    journalRoot: owner.journalRoot,
    requireNewJournalRoot: true,
  })
  try {
    await assertReady()
    const wrap = async <T>(operation: () => Promise<T>): Promise<T> => {
      await assertReady()
      const result = await operation()
      await assertReady()
      return result
    }
    return Object.freeze({
      journalRoot: owner.journalRoot,
      adapter: Object.freeze({
        read: (name: string) => wrap(() => opened.adapter.read(name)),
        exists: (name: string) => wrap(() => opened.adapter.exists(name)),
        mkdir: (name: string) => wrap(() => opened.adapter.mkdir(name)),
        write: (name: string, data: string) => wrap(() => opened.adapter.write(name, data)),
      }),
      lockPath: opened.lockPath,
      assertExclusiveStageLease: () => wrap(() => opened.assertExclusiveStageLease()),
      assertBestEffortCheckpoint: () => wrap(() => opened.assertBestEffortCheckpoint()),
      release: () => opened.release(),
      crashDurabilityProven: false as const,
      resumeSyncAuthorized: false as const,
      cutoverAuthorized: false as const,
    })
  } catch (error) {
    // Releasing our own lock is permitted; NEVER remove the new WAL directory,
    // as its existence may be the only evidence of an interrupted attempt.
    await opened.release()
    throw error
  }
}
