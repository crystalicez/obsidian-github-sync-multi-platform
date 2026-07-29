import type { V4ContentSource } from "./content-source"
import { createV4IncrementalSha256 } from "./incremental-hash"
import type { V4FileRecord } from "./protocol-types"

export class V4SourceChangedError extends Error {
  readonly path?: string
  readonly replanRequired = true

  constructor(path?: string, detail = "source changed while it was being read") {
    super(`V4 source changed${path ? `: ${path}` : ""} (${detail}). Replan is required.`)
    this.name = "V4SourceChangedError"
    this.path = path
  }
}

export interface V4StreamObject {
  path: string
  bytes: Uint8Array
  release?: () => void
}

export interface V4PreparedObjectStream {
  readonly objectCount: number
  readonly objectPaths: readonly string[]
  objects(signal?: AbortSignal): AsyncIterable<V4StreamObject>
  finalize(): Promise<V4FileRecord>
}

export interface V4StableHashOptions {
  chunkBytes: number
  checkStable?: () => Promise<void>
  signal?: AbortSignal
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`)
}

export async function hashV4StableContentSource(source: V4ContentSource, options: V4StableHashOptions): Promise<string> {
  assertPositiveSafeInteger(options.chunkBytes, "chunkBytes")
  await options.checkStable?.()
  const hash = createV4IncrementalSha256()
  let total = 0
  for await (const chunk of source.chunks(options.chunkBytes, options.signal)) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("V4 source hashing aborted.")
    if (total + chunk.byteLength > source.size) throw new V4SourceChangedError(undefined, "source produced more bytes than declared")
    hash.update(chunk)
    total += chunk.byteLength
    await options.checkStable?.()
  }
  if (total !== source.size) throw new V4SourceChangedError(undefined, `source produced ${total} bytes; expected ${source.size}`)
  await options.checkStable?.()
  return hash.digestHex()
}

export async function* streamV4SourceParts(
  source: V4ContentSource,
  partBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  assertPositiveSafeInteger(partBytes, "partBytes")
  const iterator = source.chunks(partBytes, signal)[Symbol.asyncIterator]()
  let carry: Uint8Array | undefined
  let total = 0

  while (total < source.size) {
    if (signal?.aborted) throw signal.reason ?? new Error("V4 source streaming aborted.")
    const wanted = Math.min(partBytes, source.size - total)

    if (!carry) {
      const next = await iterator.next()
      if (next.done) throw new V4SourceChangedError(undefined, `source ended after ${total} bytes; expected ${source.size}`)
      if (next.value.byteLength === 0) continue
      if (next.value.byteLength === wanted) {
        total += wanted
        yield next.value
        continue
      }
      if (next.value.byteLength > wanted) {
        const part = next.value.subarray(0, wanted)
        carry = next.value.subarray(wanted)
        total += wanted
        yield part
        continue
      }
      carry = next.value
    }

    const part = new Uint8Array(wanted)
    let filled = 0
    while (filled < wanted) {
      if (carry && carry.byteLength > 0) {
        const take = Math.min(carry.byteLength, wanted - filled)
        part.set(carry.subarray(0, take), filled)
        filled += take
        carry = take === carry.byteLength ? undefined : carry.subarray(take)
        continue
      }
      const next = await iterator.next()
      if (next.done) throw new V4SourceChangedError(undefined, `source ended after ${total + filled} bytes; expected ${source.size}`)
      carry = next.value
    }
    total += wanted
    yield part
  }

  if (carry?.byteLength) throw new V4SourceChangedError(undefined, "source produced more bytes than declared")
  const extra = await iterator.next()
  if (!extra.done && extra.value.byteLength > 0) throw new V4SourceChangedError(undefined, "source produced more bytes than declared")
}
