import { randomBytes, toBase64Url } from "../bytes"
import { collectV4ContentSource, type V4ContentSource } from "./content-source"
import { createV4IncrementalSha256 } from "./incremental-hash"

export interface V4StageRef {
  stageId: string
  hash: string
  size: number
  mtime: number
}

export interface V4StagingBackend {
  boundedAppend: boolean
  write(path: string, bytes: Uint8Array): Promise<void>
  append(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  openSource(path: string, size: number): Promise<V4ContentSource>
  freeBytes(path: string): Promise<number | undefined>
}

export interface V4StagingSpaceEstimate {
  existingTargetBytes: number
  stageBytes: number
  backupBytes: number
  peakFootprintBytes: number
  additionalFreeBytesRequired: number
}

export class V4UnknownStagingSpaceError extends Error {
  readonly requiredBytes: number

  constructor(requiredBytes: number) {
    super(`V4 staging requires ${requiredBytes} free bytes, but available space is unknown.`)
    this.name = "V4UnknownStagingSpaceError"
    this.requiredBytes = requiredBytes
  }
}

export class V4InsufficientStagingSpaceError extends Error {
  readonly requiredBytes: number
  readonly availableBytes: number

  constructor(requiredBytes: number, availableBytes: number) {
    super(`V4 staging requires ${requiredBytes} free bytes; only ${availableBytes} are available.`)
    this.name = "V4InsufficientStagingSpaceError"
    this.requiredBytes = requiredBytes
    this.availableBytes = availableBytes
  }
}

export interface V4StagedSink {
  append(bytes: Uint8Array): Promise<void>
  finish(result: { plaintextSha256: string; size: number }): Promise<V4StageRef>
  abort(): Promise<void>
}

export interface V4StagingStore {
  beginStage(options: { expectedSize: number; mtime: number; existingTargetBytes: number; atomicReplace: boolean; signal?: AbortSignal }): Promise<V4StagedSink>
  stageSource(source: V4ContentSource, options: { mtime: number; existingTargetBytes: number; atomicReplace: boolean; signal?: AbortSignal }): Promise<V4StageRef>
  open(ref: Pick<V4StageRef, "stageId" | "size">): Promise<V4ContentSource>
  remove(ref: Pick<V4StageRef, "stageId">): Promise<void>
  pathFor(stageId: string): string
}

export function estimateV4StagingSpace(input: { stageBytes: number; existingTargetBytes: number; atomicReplace: boolean }): V4StagingSpaceEstimate {
  for (const [label, value] of Object.entries({ stageBytes: input.stageBytes, existingTargetBytes: input.existingTargetBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`)
  }
  const backupBytes = input.atomicReplace ? 0 : input.existingTargetBytes
  return {
    existingTargetBytes: input.existingTargetBytes,
    stageBytes: input.stageBytes,
    backupBytes,
    peakFootprintBytes: input.existingTargetBytes + input.stageBytes + backupBytes,
    additionalFreeBytesRequired: input.stageBytes + backupBytes,
  }
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")
}

function validateStageId(stageId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(stageId)) throw new Error("Invalid opaque V4 stage id.")
}

export function createV4StagingStore(options: {
  root: string
  backend: V4StagingBackend
  wholeBufferCeilingBytes: number
  randomId?: () => string
}): V4StagingStore {
  const root = normalizeRoot(options.root)
  if (!root) throw new Error("V4 staging root is required.")
  const ceiling = options.wholeBufferCeilingBytes
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new TypeError("wholeBufferCeilingBytes must be a positive safe integer.")
  const randomId = options.randomId ?? (() => toBase64Url(randomBytes(18)))
  const pathFor = (stageId: string): string => {
    validateStageId(stageId)
    return `${root}/${stageId}.bin`
  }

  const beginStage = async (stageOptions: { expectedSize: number; mtime: number; existingTargetBytes: number; atomicReplace: boolean; signal?: AbortSignal }): Promise<V4StagedSink> => {
    const stageId = randomId()
    const path = pathFor(stageId)
    const large = stageOptions.expectedSize > ceiling
    if (large && !options.backend.boundedAppend) throw new Error("V4 bounded append is unavailable for large staging.")
    if (large) {
      const estimate = estimateV4StagingSpace({
        stageBytes: stageOptions.expectedSize,
        existingTargetBytes: stageOptions.existingTargetBytes,
        atomicReplace: stageOptions.atomicReplace,
      })
      const available = await options.backend.freeBytes(path)
      if (available === undefined) throw new V4UnknownStagingSpaceError(estimate.additionalFreeBytesRequired)
      if (available < estimate.additionalFreeBytesRequired) throw new V4InsufficientStagingSpaceError(estimate.additionalFreeBytesRequired, available)
    }

    let total = 0
    let first = true
    let closed = false
    const removePartial = async () => { try { await options.backend.remove(path) } catch {} }
    return {
      async append(bytes) {
        if (closed) throw new Error("V4 staged sink is already closed.")
        if (stageOptions.signal?.aborted) throw stageOptions.signal.reason ?? new Error("V4 staging aborted.")
        if (total + bytes.byteLength > stageOptions.expectedSize) throw new Error("V4 staged sink received more bytes than declared.")
        try {
          if (first) { await options.backend.write(path, bytes); first = false }
          else await options.backend.append(path, bytes)
          total += bytes.byteLength
        } catch (error) {
          closed = true
          await removePartial()
          throw error
        }
      },
      async finish(result) {
        if (closed) throw new Error("V4 staged sink is already closed.")
        if (!/^[0-9a-f]{64}$/u.test(result.plaintextSha256)) throw new Error("V4 staged sink requires a SHA-256 hash.")
        if (result.size !== total || total !== stageOptions.expectedSize) {
          closed = true
          await removePartial()
          throw new Error(`V4 staged sink received ${total} bytes; expected ${stageOptions.expectedSize}.`)
        }
        if (first) { await options.backend.write(path, new Uint8Array()); first = false }
        closed = true
        return { stageId, hash: result.plaintextSha256, size: total, mtime: stageOptions.mtime }
      },
      async abort() {
        if (closed) return
        closed = true
        await removePartial()
      },
    }
  }

  return {
    pathFor,
    beginStage,
    async stageSource(source, stageOptions) {
      const sink = await beginStage({ expectedSize: source.size, ...stageOptions })
      const hash = createV4IncrementalSha256()
      let total = 0
      try {
        if (!options.backend.boundedAppend && source.size > ceiling) throw new Error("V4 bounded append is unavailable for large staging.")
        if (!options.backend.boundedAppend) {
          const bytes = await collectV4ContentSource(source, ceiling, stageOptions.signal)
          hash.update(bytes)
          await sink.append(bytes)
          total = bytes.byteLength
        } else {
          for await (const chunk of source.chunks(Math.min(4 * 1024 * 1024, Math.max(1, ceiling)), stageOptions.signal)) {
            hash.update(chunk)
            await sink.append(chunk)
            total += chunk.byteLength
          }
        }
        return await sink.finish({ plaintextSha256: hash.digestHex(), size: total })
      } catch (error) {
        await sink.abort()
        throw error
      }
    },
    async open(ref) {
      validateStageId(ref.stageId)
      return options.backend.openSource(pathFor(ref.stageId), ref.size)
    },
    async remove(ref) {
      await options.backend.remove(pathFor(ref.stageId))
    },
  }
}
