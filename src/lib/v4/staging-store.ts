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

/** The temporary stage still may exist; do not attest a successful abort. */
export class V4StagingCleanupError extends Error {
  constructor(
    readonly partialPath: string,
    readonly cleanupFailure: unknown,
    readonly stageFailure?: unknown,
  ) {
    super("V4 staging partial-file cleanup failed; manual recovery may be required.", { cause: cleanupFailure })
    this.name = "V4StagingCleanupError"
  }
}

export interface V4StagedSink {
  append(bytes: Uint8Array): Promise<void>
  finish(result: { plaintextSha256: string; size: number }): Promise<V4StageRef>
  abort(): Promise<void>
}

/**
 * Called by streaming owners after a staging error. A second abort failure
 * must not hide the original I/O / remote-read fault. If abort can remove a
 * previously unresolved partial stage, report only the original fault.
 */
export async function abortV4StageAfterFailure(sink: V4StagedSink, failure: unknown): Promise<never> {
  const originalFailure = failure instanceof V4StagingCleanupError && failure.stageFailure !== undefined
    ? failure.stageFailure : failure
  try {
    await sink.abort()
  } catch (cleanupFailure) {
    if (cleanupFailure instanceof V4StagingCleanupError) {
      throw new V4StagingCleanupError(cleanupFailure.partialPath, cleanupFailure.cleanupFailure, originalFailure)
    }
    throw new AggregateError([originalFailure, cleanupFailure],
      "V4 staging failed and partial-file cleanup also failed; manual recovery may be required.")
  }
  throw originalFailure
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
  const additionalFreeBytesRequired = input.stageBytes + backupBytes
  const peakFootprintBytes = input.existingTargetBytes + additionalFreeBytesRequired
  if (!Number.isSafeInteger(additionalFreeBytesRequired) || !Number.isSafeInteger(peakFootprintBytes)) throw new RangeError("V4 staging space estimate exceeds safe integer range.")
  return {
    existingTargetBytes: input.existingTargetBytes,
    stageBytes: input.stageBytes,
    backupBytes,
    peakFootprintBytes,
    additionalFreeBytesRequired,
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
    const estimate = estimateV4StagingSpace({
      stageBytes: stageOptions.expectedSize,
      existingTargetBytes: stageOptions.existingTargetBytes,
      atomicReplace: stageOptions.atomicReplace,
    })
    const stageId = randomId()
    const path = pathFor(stageId)
    const large = stageOptions.expectedSize > ceiling
    if (large && !options.backend.boundedAppend) throw new Error("V4 bounded append is unavailable for large staging.")
    if (large) {
      const available = await options.backend.freeBytes(path)
      if (available === undefined) throw new V4UnknownStagingSpaceError(estimate.additionalFreeBytesRequired)
      if (available < estimate.additionalFreeBytesRequired) throw new V4InsufficientStagingSpaceError(estimate.additionalFreeBytesRequired, available)
    }

    let total = 0
    let first = true
    let state: "open" | "finishing" | "finished" | "aborting" | "aborted" | "failed" = "open"
    let failed = false
    let firstFailure: unknown
    let abortInFlight: Promise<void> | undefined
    // Serialize backend mutations so finish cannot attest unflushed append
    // operations, and abort cannot remove before a pending write recreates it.
    let pending: Promise<void> = Promise.resolve()
    const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
      const operation = pending.then(action)
      pending = operation.then(() => undefined, () => undefined)
      return operation
    }
    const removePartial = async () => {
      try { await options.backend.remove(path) }
      catch (error) {
        // A never-created or already-removed partial stage is clean. Do not
        // hide permission, I/O or unknown errors as a successful abort.
        if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error
      }
    }
    const poison = async (error: unknown): Promise<never> => {
      if (!failed) { failed = true; firstFailure = error }
      state = "failed"
      try { await removePartial() }
      catch (cleanupFailure) {
        firstFailure = new V4StagingCleanupError(path, cleanupFailure, firstFailure)
        throw firstFailure
      }
      throw error
    }
    const closedError = () => new Error("V4 staged sink is already closed.")
    return {
      append(bytes) {
        if (state !== "open") return Promise.reject(closedError())
        if (stageOptions.signal?.aborted) return Promise.reject(stageOptions.signal.reason ?? new Error("V4 staging aborted."))
        // The writer can be queued behind an earlier asynchronous append.
        // Retain an owned copy now: a stream may reuse its source buffer before
        // the backend receives these bytes, otherwise the stage can be corrupt.
        const ownedBytes = new Uint8Array(bytes)
        return enqueue(async () => {
          if (failed) throw firstFailure
          if (state === "aborting" || state === "aborted") throw closedError()
          if (stageOptions.signal?.aborted) throw stageOptions.signal.reason ?? new Error("V4 staging aborted.")
          if (total + ownedBytes.byteLength > stageOptions.expectedSize)
            return poison(new Error("V4 staged sink received more bytes than declared."))
          try {
            if (first) { await options.backend.write(path, ownedBytes); first = false }
            else await options.backend.append(path, ownedBytes)
            total += ownedBytes.byteLength
          } catch (error) {
            return poison(error)
          }
        })
      },
      finish(result) {
        if (state !== "open") return Promise.reject(closedError())
        state = "finishing"
        return enqueue(async () => {
          if (failed) throw firstFailure
          if (state !== "finishing") throw closedError()
          if (stageOptions.signal?.aborted)
            return poison(stageOptions.signal.reason ?? new Error("V4 staging aborted."))
          if (!/^[0-9a-f]{64}$/u.test(result.plaintextSha256))
            return poison(new Error("V4 staged sink requires a SHA-256 hash."))
          if (result.size !== total || total !== stageOptions.expectedSize)
            return poison(new Error(`V4 staged sink received ${total} bytes; expected ${stageOptions.expectedSize}.`))
          try {
            if (first) { await options.backend.write(path, new Uint8Array()); first = false }
          } catch (error) {
            return poison(error)
          }
          // An abort requested while an empty-file write was pending wins.
          if (state !== "finishing") throw closedError()
          state = "finished"
          return { stageId, hash: result.plaintextSha256, size: total, mtime: stageOptions.mtime }
        })
      },
      abort() {
        if (state === "finished" || state === "aborted") return Promise.resolve()
        if (abortInFlight) return abortInFlight
        state = "aborting"
        const operation = enqueue(async () => {
          try { await removePartial() }
          catch (cleanupFailure) {
            state = "failed"
            throw new V4StagingCleanupError(path, cleanupFailure, failed ? firstFailure : undefined)
          }
          state = "aborted"
        })
        // Concurrent callers receive the same rejection, not the queue's
        // deliberately swallowed result. Failed cleanup remains retryable.
        abortInFlight = operation.finally(() => { abortInFlight = undefined })
        return abortInFlight
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
        return abortV4StageAfterFailure(sink, error)
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
