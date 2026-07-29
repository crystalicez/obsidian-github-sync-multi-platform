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
  delete(path: string): Promise<void>
}

export type V4LocalIo = V4SessionVault

export function createV4LocalIo(vault: V4SessionVault): V4LocalIo {
  const localIo: V4LocalIo = {
    listFiles: () => vault.listFiles(),
    read: path => vault.read(path),
    write: (path, bytes, mtime) => vault.write(path, bytes, mtime),
    delete: path => vault.delete(path),
  }
  if (vault.stat) localIo.stat = path => vault.stat!(path)
  return localIo
}
