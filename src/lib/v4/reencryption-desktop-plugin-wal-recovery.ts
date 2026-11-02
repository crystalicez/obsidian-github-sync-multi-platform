import { planV4PluginPrivateWalLocation } from "./reencryption-plugin-wal-location"
import { openV4ExistingDesktopWalForRecovery, type V4DesktopExistingWalRecoveryReader } from "./reencryption-desktop-wal-recovery"

export interface V4DesktopPluginWalOwner {
  /** Exact live Obsidian vault.adapter, not a caller-provided absolute path. */
  readonly adapter: { getFullPath(path: string): string }
  readonly configDir: string
  readonly pluginId: string
  readonly runId: string
  readonly assertLiveOwner: () => void
}

/**
 * Opens an existing Desktop WAL only when Obsidian's physical path resolves
 * to this same vault's original plugin-private location. The adapter and
 * owner remain pinned throughout all read-only recovery operations.
 */
export async function openV4DesktopPluginWalForRecovery(
  input: V4DesktopPluginWalOwner,
): Promise<V4DesktopExistingWalRecoveryReader> {
  const { adapter, configDir, pluginId, runId, assertLiveOwner } = input
  if (!adapter || typeof adapter.getFullPath !== "function"
    || typeof assertLiveOwner !== "function") {
    throw Error("Missing Obsidian Desktop owner or path resolver.")
  }
  const resolveFull = adapter.getFullPath
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const [fs, path] = await Promise.all([
    import("node:fs/promises"), import("node:path"),
  ])
  const vaultRoot = resolveFull.call(adapter, "")
  const pluginRoot = resolveFull.call(adapter, layout.pluginStorageRoot)
  if (typeof vaultRoot !== "string" || typeof pluginRoot !== "string"
    || !path.isAbsolute(vaultRoot) || path.resolve(vaultRoot) !== vaultRoot) {
    throw Error("Obsidian Desktop vault path is not a canonical absolute root.")
  }
  const segments = layout.pluginStorageRoot.split("/")
  const expected = path.join(vaultRoot, ...segments)
  const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  if (!path.isAbsolute(pluginRoot) || !samePath(pluginRoot, expected)) {
    throw Error("Obsidian adapter redirected the plugin-private WAL location.")
  }
  const checkOwner = () => {
    assertLiveOwner()
    if (input.adapter !== adapter || input.configDir !== configDir
      || input.pluginId !== pluginId || input.runId !== runId
      || input.assertLiveOwner !== assertLiveOwner
      || adapter.getFullPath !== resolveFull
      || resolveFull.call(adapter, "") !== vaultRoot
      || resolveFull.call(adapter, layout.pluginStorageRoot) !== pluginRoot) {
      throw Error("Re-encryption Desktop WAL owner or path changed.")
    }
  }
  checkOwner()
  for (let i = 0; i <= segments.length; i++) {
    const location = path.join(vaultRoot, ...segments.slice(0, i))
    const info = await fs.lstat(location)
    if (!info.isDirectory() || info.isSymbolicLink()
      || !samePath(await fs.realpath(location), location)) {
      throw Error("Re-encryption Desktop WAL path is not a real plugin-private directory.")
    }
    checkOwner()
  }
  const opened = await openV4ExistingDesktopWalForRecovery({
    rootAbsolute: pluginRoot, journalRoot: layout.journalRoot,
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
