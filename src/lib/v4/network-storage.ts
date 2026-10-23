export const V4_NETWORK_VAULT_WARNING =
  "Network, mapped-drive and cloud-mounted Desktop vaults run best-effort. Slow filesystem operations may pause Obsidian and crash durability is not guaranteed. GitHub Sync still stops if integrity checks fail; keep an independent backup."

export function isV4UncVaultPath(rootPath: string | undefined): boolean {
  if (!rootPath) return false
  const path = rootPath.replace(/\//gu, "\\")
  const unc = path.startsWith("\\\\?\\UNC\\") ? "\\\\" + path.slice(8) : path
  return /^\\\\[^\\?.][^\\]*\\[^\\]+(?:\\|$)/u.test(unc)
}
