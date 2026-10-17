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
  commitStage?(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void>
  rollbackStage?(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void>
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
  if (vault.commitStage) localIo.commitStage = input => vault.commitStage!(input)
  if (vault.rollbackStage) localIo.rollbackStage = input => vault.rollbackStage!(input)
  return localIo
}

export interface V4LocalTargetPrecondition {
  path: string
  exists: boolean
  size?: number
  mtime?: number
  /** Optional SHA-256 of the reviewed source, checked even if stat is unchanged. */
  hash?: string
}

export class V4LocalTargetChangedError extends Error {
  constructor(public readonly path: string) {
    super(`V4 local target changed while remote content was in flight: ${path}`)
    this.name = "V4LocalTargetChangedError"
  }
}

export async function assertV4LocalTargetPrecondition(io: Pick<V4LocalIo, "stat" | "read" | "openContentSource">, expected: V4LocalTargetPrecondition): Promise<void> {
  // A stat-less adapter cannot establish target absence or preserve the
  // reviewed source mtime. Never treat unavailable safety evidence as a pass.
  if (!io.stat) throw new V4LocalTargetChangedError(expected.path)
  if (io.stat) {
    const current = await io.stat(expected.path)
    if (!expected.exists) {
      if (current) throw new V4LocalTargetChangedError(expected.path)
      return
    }
    if (!current || current.size !== expected.size || current.mtime !== expected.mtime) {
      throw new V4LocalTargetChangedError(expected.path)
    }
  }
  if (expected.hash) {
    // Stat-only checks miss edits that preserve size and mtime. For large
    // originals, verify using a bounded content stream; never buffer a whole
    // multi-GiB note just because the user selected "Use remote".
    const assertStable = async () => {
      if (!io.stat) return
      const current = await io.stat(expected.path)
      if (!current || current.size !== expected.size || current.mtime !== expected.mtime) {
        throw new V4LocalTargetChangedError(expected.path)
      }
    }
    let currentHash: string
    try {
      if ((expected.size ?? 0) > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        if (!io.openContentSource) throw new V4LocalTargetChangedError(expected.path)
        const source = await io.openContentSource({
          kind: "vault", path: expected.path, expectedHash: expected.hash,
          expectedSize: expected.size!, expectedMtime: expected.mtime!,
        })
        currentHash = await hashV4StableContentSource(source, {
          chunkBytes: 4 * 1024 * 1024, checkStable: assertStable,
        })
      } else {
        const bytes = await io.read(expected.path)
        if (bytes.byteLength !== expected.size) throw new V4LocalTargetChangedError(expected.path)
        currentHash = await sha256Hex(bytes)
        await assertStable()
      }
    } catch (error) {
      if (error instanceof V4LocalTargetChangedError) throw error
      throw new V4LocalTargetChangedError(expected.path)
    }
    if (currentHash !== expected.hash) throw new V4LocalTargetChangedError(expected.path)
  }
}
