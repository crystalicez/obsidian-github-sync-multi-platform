import { V4BoundedIoUnavailableError } from "./platform-io"
import { throwIfV4Aborted } from "./cancellation"

export const DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES = 32 * 1024 * 1024

export type V4ContentHandle =
  | { kind: "vault"; path: string; expectedHash: string; expectedSize: number; expectedMtime: number }
  | { kind: "stage"; stageId: string; expectedHash: string; expectedSize: number }

export interface V4ContentSource {
  readonly size: number
  chunks(chunkBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

export interface V4ContentSourceResolver {
  wholeBufferCeilingBytes?: number
  readVaultWhole(path: string): Promise<Uint8Array>
  openVaultBounded?: (path: string, expectedSize: number) => Promise<V4ContentSource>
  openStage: (stageId: string, expectedSize: number) => Promise<V4ContentSource>
}

function assertSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`)
}

export function createV4WholeBufferContentSource(bytes: Uint8Array): V4ContentSource {
  return {
    size: bytes.byteLength,
    async *chunks(chunkBytes: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("chunkBytes must be a positive safe integer.")
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        if (signal?.aborted) throw signal.reason ?? new Error("V4 content read aborted.")
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes))
      }
    },
  }
}

function assertSourceSize(source: V4ContentSource, expectedSize: number): V4ContentSource {
  if (source.size !== expectedSize) throw new Error(`V4 content source size changed: expected ${expectedSize}, got ${source.size}.`)
  return source
}

export async function createV4ContentSource(handle: V4ContentHandle, resolver: V4ContentSourceResolver, signal?: AbortSignal): Promise<V4ContentSource> {
  throwIfV4Aborted(signal)
  assertSize(handle.expectedSize, "expectedSize")
  const ceiling = resolver.wholeBufferCeilingBytes ?? DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new TypeError("wholeBufferCeilingBytes must be a positive safe integer.")
  if (handle.kind === "stage") { const source = await resolver.openStage(handle.stageId, handle.expectedSize); throwIfV4Aborted(signal); return assertSourceSize(source, handle.expectedSize) }
  if (handle.expectedSize <= ceiling) {
    const bytes = await resolver.readVaultWhole(handle.path)
    throwIfV4Aborted(signal)
    if (bytes.byteLength !== handle.expectedSize) throw new Error(`V4 vault content size changed: expected ${handle.expectedSize}, got ${bytes.byteLength}.`)
    return createV4WholeBufferContentSource(bytes)
  }
  if (!resolver.openVaultBounded) throw new V4BoundedIoUnavailableError("bounded-read", handle.path)
  const source = await resolver.openVaultBounded(handle.path, handle.expectedSize)
  throwIfV4Aborted(signal)
  return assertSourceSize(source, handle.expectedSize)
}

export async function collectV4ContentSource(source: V4ContentSource, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError("maximumBytes must be a non-negative safe integer.")
  if (source.size > maximumBytes) throw new RangeError(`V4 content source ${source.size} exceeds collection limit ${maximumBytes}.`)
  const output = new Uint8Array(source.size)
  let offset = 0
  const chunkBytes = Math.max(1, Math.min(1024 * 1024, source.size || 1))
  for await (const chunk of source.chunks(chunkBytes, signal)) {
    if (offset + chunk.byteLength > output.byteLength) throw new Error("V4 content source produced more bytes than declared.")
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== output.byteLength) throw new Error(`V4 content source produced ${offset} bytes; expected ${output.byteLength}.`)
  return output
}
