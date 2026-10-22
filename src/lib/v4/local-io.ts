import { sha256Hex } from "../bytes"
import { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, type V4ContentHandle, type V4ContentSource } from "./content-source"
import { hashV4StableContentSource } from "./object-stream"
import type { V4StageRef, V4StagingStore } from "./staging-store"

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
  openContentSource?(handle: V4ContentHandle, signal?: AbortSignal): Promise<V4ContentSource>
  staging?: V4StagingStore
  /** Desktop: small WAL writes must use a crash-recoverable staged commit. */
  preferStagedCommit?: boolean
  commitStage?(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void>
  rollbackStage?(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void>
  finalizeStage?(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void>
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
  if (vault.openContentSource) localIo.openContentSource = (handle, signal) => vault.openContentSource!(handle, signal)
  if (vault.staging) localIo.staging = vault.staging
  if (vault.preferStagedCommit) localIo.preferStagedCommit = true
  if (vault.commitStage) localIo.commitStage = input => vault.commitStage!(input)
  if (vault.rollbackStage) localIo.rollbackStage = input => vault.rollbackStage!(input)
  if (vault.finalizeStage) localIo.finalizeStage = input => vault.finalizeStage!(input)
  return localIo
}

export interface V4LocalTargetPrecondition {
  path: string
  exists: boolean
  size?: number
  mtime?: number
  /** Original local content hash for safe crash rollback. Older WALs may omit it. */
  hash?: string
}

export class V4LocalTargetChangedError extends Error {
  constructor(public readonly path: string) {
    super(`V4 local target changed while remote content was in flight: ${path}`)
    this.name = "V4LocalTargetChangedError"
  }
}

export async function assertV4LocalTargetPrecondition(io: Pick<V4LocalIo, "stat" | "read" | "openContentSource">, expected: V4LocalTargetPrecondition): Promise<void> {
  // Without stat there is no evidence that a local user file remains unchanged.
  // Fail closed rather than permitting a recovered write or trash to proceed.
  if (!io.stat) throw new V4LocalTargetChangedError(expected.path)
  const current = await io.stat(expected.path)
  if (!expected.exists) {
    if (current) throw new V4LocalTargetChangedError(expected.path)
    return
  }
  if (!current || current.size !== expected.size || current.mtime !== expected.mtime) {
    throw new V4LocalTargetChangedError(expected.path)
  }
  if (!expected.hash) return
  try {
    let found: string
    if (current.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
      if (!io.openContentSource) throw new V4LocalTargetChangedError(expected.path)
      const source = await io.openContentSource({
        kind: "vault", path: expected.path, expectedHash: expected.hash,
        expectedSize: current.size, expectedMtime: current.mtime,
      })
      found = await hashV4StableContentSource(source, { chunkBytes: 4 * 1024 * 1024 })
    } else {
      if (!io.read) throw new V4LocalTargetChangedError(expected.path)
      const bytes = await io.read(expected.path)
      if (bytes.byteLength !== current.size) throw new V4LocalTargetChangedError(expected.path)
      found = await sha256Hex(bytes)
    }
    const after = await io.stat(expected.path)
    if (!after || after.size !== current.size || after.mtime !== current.mtime || found !== expected.hash) {
      throw new V4LocalTargetChangedError(expected.path)
    }
  } catch {
    throw new V4LocalTargetChangedError(expected.path)
  }
}
