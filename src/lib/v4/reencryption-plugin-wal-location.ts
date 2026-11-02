import { sha256Hex, utf8ToBytes } from "../bytes"

const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const PLUGIN_ID = /^[A-Za-z0-9_.-]{1,64}$/u
const CONFIG_SEGMENT = /^[^\u0000-\u001f\u007f<>:"/\\|?*]{1,64}$/u
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function safeSegment(segment: string, pattern: RegExp): boolean {
  return pattern.test(segment) && segment === segment.normalize("NFC")
    && segment !== "." && segment !== ".." && !/[. ]$/u.test(segment)
    && !WINDOWS_DEVICE.test(segment)
}

export interface V4PluginWalLocation {
  /** Relative to Obsidian Vault, not the filesystem root. */
  readonly pluginStorageRoot: string
  /** Relative to pluginStorageRoot for both Desktop and Mobile. */
  readonly journalRoot: string
  /** Relative to Obsidian Vault for Mobile's vault.adapter. */
  readonly vaultLogicalWalRoot: string
}

/**
 * One deterministic, cross-platform, plugin-private location per migration.
 * This is a path plan only: it does not create a WAL, prove provenance or
 * choose an active Index. The existing writer is not installed in Runtime.
 */
export async function planV4PluginPrivateWalLocation(input: {
  readonly configDir: string
  readonly pluginId: string
  readonly runId: string
}): Promise<V4PluginWalLocation> {
  const { configDir, pluginId, runId } = input
  if (typeof configDir !== "string" || typeof pluginId !== "string"
    || typeof runId !== "string" || !RUN.test(runId)
    || !safeSegment(pluginId, PLUGIN_ID)) {
    throw Error("Invalid plugin-private Re-encryption WAL identity.")
  }
  const configSegments = configDir.split("/")
  if (configSegments.length < 1 || configSegments.length > 5
    || configSegments.some(segment => !safeSegment(segment, CONFIG_SEGMENT))) {
    throw Error("Unsafe Obsidian config directory for Re-encryption WAL.")
  }
  const pluginStorageRoot = [...configSegments, "plugins", pluginId].join("/")
  const journalRoot = "reencryption-wal/" + await sha256Hex(utf8ToBytes(runId))
  return Object.freeze({
    pluginStorageRoot,
    journalRoot,
    vaultLogicalWalRoot: pluginStorageRoot + "/" + journalRoot,
  })
}
