import type { V4ContentHandle, V4ContentSource } from "./content-source"
import type { V4StagingStore } from "./staging-store"

export interface V4SessionVaultFile {
  path: string
  size: number
  mtime: number
}

export interface V4SessionVault {
  listFiles(): Promise<V4SessionVaultFile[]>
  stat?(path: string): Promise<V4SessionVaultFile | null>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array, mtime?: number): Promise<void>
  trash(path: string): Promise<void>
  openContentSource?(handle: V4ContentHandle): Promise<V4ContentSource>
  staging?: V4StagingStore
}

export type V4LocalIo = V4SessionVault

export function createV4LocalIo(vault: V4SessionVault): V4LocalIo {
  const localIo: V4LocalIo = {
    listFiles: () => vault.listFiles(),
    read: path => vault.read(path),
    write: (path, bytes, mtime) => vault.write(path, bytes, mtime),
    trash: path => vault.trash(path),
  }
  if (vault.stat) localIo.stat = path => vault.stat!(path)
  if (vault.openContentSource) localIo.openContentSource = handle => vault.openContentSource!(handle)
  if (vault.staging) localIo.staging = vault.staging
  return localIo
}
