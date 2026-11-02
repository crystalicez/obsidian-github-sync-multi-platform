import { resolveV4DesktopPluginWalOwner, type V4DesktopPluginWalOwner } from "./reencryption-desktop-plugin-wal-owner"
import { openV4ExistingDesktopWalForRecovery, type V4DesktopExistingWalRecoveryReader } from "./reencryption-desktop-wal-recovery"

export type { V4DesktopPluginWalOwner } from "./reencryption-desktop-plugin-wal-owner"

/** Open the pre-existing WAL on the same owner-vault physical root, with no data writes. */
export async function openV4DesktopPluginWalForRecovery(
  input: V4DesktopPluginWalOwner,
): Promise<V4DesktopExistingWalRecoveryReader> {
  const resolved = await resolveV4DesktopPluginWalOwner(input)
  const { checkOwner } = resolved
  const opened = await openV4ExistingDesktopWalForRecovery({
    rootAbsolute: resolved.rootAbsolute, journalRoot: resolved.journalRoot,
  })
  try {
    checkOwner()
    return Object.freeze({
      adapter: Object.freeze({
        read: async (file: string) => {
          checkOwner()
          const result = await opened.adapter.read(file)
          checkOwner()
          return result
        },
        exists: async (file: string) => {
          checkOwner()
          const result = await opened.adapter.exists(file)
          checkOwner()
          return result
        },
      }),
      lockPath: opened.lockPath,
      assertExclusiveStageLease: async () => {
        checkOwner()
        await opened.assertExclusiveStageLease()
        checkOwner()
      },
      assertBestEffortCheckpoint: async () => {
        checkOwner()
        const result = await opened.assertBestEffortCheckpoint()
        checkOwner()
        return result
      },
      release: () => opened.release(),
    })
  } catch (error) {
    await opened.release()
    throw error
  }
}
