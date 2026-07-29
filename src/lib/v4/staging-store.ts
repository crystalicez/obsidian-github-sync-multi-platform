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

export interface V4StagingStore {
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

  return {
    pathFor,
    async stageSource(source, stageOptions) {
      const stageId = randomId()
      const path = pathFor(stageId)
      const large = source.size > ceiling
      if (large && !options.backend.boundedAppend) throw new Error("V4 bounded append is unavailable for large staging.")
      if (large) {
        const estimate = estimateV4StagingSpace({
          stageBytes: source.size,
          existingTargetBytes: stageOptions.existingTargetBytes,
          atomicReplace: stageOptions.atomicReplace,
        })
        const available = await options.backend.freeBytes(path)
        if (available === undefined) throw new V4UnknownStagingSpaceError(estimate.additionalFreeBytesRequired)
        if (available < estimate.additionalFreeBytesRequired) throw new V4InsufficientStagingSpaceError(estimate.additionalFreeBytesRequired, available)
      }

      try {
        if (!options.backend.boundedAppend) {
          const bytes = await collectV4ContentSource(source, ceiling, stageOptions.signal)
          const hash = createV4IncrementalSha256()
          hash.update(bytes)
          await options.backend.write(path, bytes)
          return { stageId, hash: hash.digestHex(), size: bytes.byteLength, mtime: stageOptions.mtime }
        }

        const hash = createV4IncrementalSha256()
        let total = 0
        let first = true
        for await (const chunk of source.chunks(Math.min(4 * 1024 * 1024, Math.max(1, ceiling)), stageOptions.signal)) {
          if (stageOptions.signal?.aborted) throw stageOptions.signal.reason ?? new Error("V4 staging aborted.")
          if (total + chunk.byteLength > source.size) throw new Error("V4 staging source produced more bytes than declared.")
          hash.update(chunk)
          if (first) { await options.backend.write(path, chunk); first = false }
          else await options.backend.append(path, chunk)
          total += chunk.byteLength
        }
        if (first) await options.backend.write(path, new Uint8Array())
        if (total !== source.size) throw new Error(`V4 staging source produced ${total} bytes; expected ${source.size}.`)
        return { stageId, hash: hash.digestHex(), size: total, mtime: stageOptions.mtime }
      } catch (error) {
        try { await options.backend.remove(path) } catch {}
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
