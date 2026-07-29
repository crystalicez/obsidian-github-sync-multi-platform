import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { collectV4ContentSource, type V4ContentSource } from "./content-source"
import { decryptV4Payload, encryptV4Payload, type V4Keyring } from "./crypto"
import { throwIfV4Aborted } from "./cancellation"
import {
  buildV4PartPaths,
  joinAndVerifyV4Parts,
  shouldUseV4Parts,
  splitV4Parts,
  V4_LARGE_FILE_THRESHOLD_BYTES,
} from "./large-files"
import { createV4IncrementalSha256 } from "./incremental-hash"
import { streamV4SourceParts, type V4PreparedObjectStream, V4SourceChangedError } from "./object-stream"
import { normalizeV4VaultPath, objectIdForV4File, opaqueV4ObjectPath, opaqueV4PackPath, pathIdForV4Path } from "./paths"
import { type V4FileRecord, type V4PathLayout, type V4StorageMode } from "./protocol-types"
import type { V4ResourceController } from "./resource-controller"
import type { V4StagedSink } from "./staging-store"

export interface V4PreparedFile {
  path: string
  bytes: Uint8Array
}

export interface V4PreparedRemoteWrite {
  record: V4FileRecord
  files: V4PreparedFile[]
}

export interface V4PreparedPack {
  records: V4FileRecord[]
  file: V4PreparedFile
}

export type V4RemoteBytesReader = (path: string) => Promise<Uint8Array>

export interface V4PackSourceEntry {
  logicalPath: string
  fileId: string
  source: V4ContentSource
  expectedHash: string
  expectedSize?: number
  version: string
  mtime: number
  checkSourceStable?: () => Promise<void>
}

export class V4StorageCodec {
  constructor(private readonly options: {
    mode: V4StorageMode
    pathLayout: V4PathLayout
    keyring?: V4Keyring
    resources?: Pick<V4ResourceController, "withCrypto"> & Partial<Pick<V4ResourceController, "reserveResidentBytes">>
    signal?: AbortSignal
  }) {
    if (options.mode === "encrypted" && !options.keyring) {
      throw new Error("Encrypted V4 storage requires a keyring.")
    }
  }

  private async crypto<T>(task: () => Promise<T>): Promise<T> {
    throwIfV4Aborted(this.options.signal)
    const value = this.options.resources ? await this.options.resources.withCrypto(task, this.options.signal) : await task()
    throwIfV4Aborted(this.options.signal)
    return value
  }

  private contentAad(record: { fileId: string; pathId: string; remoteVersion: string }): string {
    return this.options.pathLayout === "opaque-stable-v1"
      ? `${record.fileId}:${record.remoteVersion}`
      : `${record.pathId}:${record.remoteVersion}`
  }

  private async pathId(path: string): Promise<string> {
    if (this.options.mode === "encrypted") {
      return this.crypto(() => pathIdForV4Path(this.options.keyring!.pathKey, path))
    }
    return this.crypto(() => sha256Hex(new TextEncoder().encode(`path:${path}`)))
  }

  async prepare(
    logicalPath: string,
    plaintext: Uint8Array,
    version: string,
    mtime: number,
    fileId?: string,
  ): Promise<V4PreparedRemoteWrite> {
    const path = normalizeV4VaultPath(logicalPath)
    const pathId = await this.pathId(path)
    const stableFileId = fileId ?? pathId
    const plaintextSha256 = await this.crypto(() => sha256Hex(plaintext))
    const predictedBytes = plaintext.byteLength + (this.options.mode === "encrypted" ? 33 : 0)
    if (shouldUseV4Parts(plaintext.byteLength, predictedBytes)) {
      return this.prepareParts(path, pathId, stableFileId, plaintext, plaintextSha256, version, mtime)
    }

    const remotePath = this.options.mode === "plaintext"
      ? path
      : await this.crypto(() => opaqueV4ObjectPath(this.options.keyring!.pathKey, stableFileId))
    const bytes = this.options.mode === "plaintext"
      ? plaintext
      : await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, plaintext, {
        kind: "content",
        aad: this.contentAad({ fileId: stableFileId, pathId, remoteVersion: version }),
      }))
    return {
      record: {
        pathId,
        fileId: stableFileId,
        plaintextSha256,
        size: plaintext.byteLength,
        mtime,
        remoteVersion: version,
        remotePath,
        encryptedPath: this.options.mode === "encrypted" ? remotePath : undefined,
        storage: "single",
      },
      files: [{ path: remotePath, bytes }],
    }
  }


  async prepareFromSource(input: {
    logicalPath: string
    source: V4ContentSource
    expectedHash: string
    version: string
    mtime: number
    fileId: string
    partBytes: number
    checkSourceStable?: () => Promise<void>
  }): Promise<V4PreparedObjectStream> {
    if (!Number.isSafeInteger(input.partBytes) || input.partBytes < 1) throw new TypeError("V4 part size must be a positive safe integer.")
    if (!/^[0-9a-f]{64}$/u.test(input.expectedHash)) throw new Error("V4 streamed source requires an expected SHA-256 hash.")
    const path = normalizeV4VaultPath(input.logicalPath)
    const pathId = await this.pathId(path)
    const fileId = input.fileId
    const predictedBytes = input.source.size + (this.options.mode === "encrypted" ? 33 : 0)
    const chunked = shouldUseV4Parts(input.source.size, predictedBytes)
    const opaqueId = chunked && this.options.mode === "encrypted"
      ? await this.crypto(() => objectIdForV4File(this.options.keyring!.pathKey, fileId))
      : undefined
    const partCount = chunked ? Math.max(1, Math.ceil(input.source.size / input.partBytes)) : 1
    const objectPaths = chunked
      ? buildV4PartPaths({ mode: this.options.mode, logicalPath: path, version: input.version, partCount, opaqueId })
      : [this.options.mode === "plaintext"
        ? path
        : await this.crypto(() => opaqueV4ObjectPath(this.options.keyring!.pathKey, fileId))]
    const contentAad = this.contentAad({ fileId, pathId, remoteVersion: input.version })
    const mode = this.options.mode
    const hash = createV4IncrementalSha256()
    let consumed = false
    let completed = false
    let total = 0

    const reserve = async (plainBytes: number): Promise<() => void> => {
      const reserveResidentBytes = this.options.resources?.reserveResidentBytes
      if (!reserveResidentBytes) return () => {}
      const multiplier = this.options.mode === "encrypted" ? 3 : 2
      const estimated = plainBytes * multiplier + (this.options.mode === "encrypted" ? 64 : 0)
      return reserveResidentBytes(estimated, this.options.signal)
    }

    const objects = async function* (this: V4StorageCodec, signal?: AbortSignal) {
      if (consumed) throw new Error("V4 prepared object stream can be consumed only once.")
      consumed = true
      await input.checkSourceStable?.()
      if (!chunked) {
        const release = await reserve(input.source.size)
        try {
          const plaintext = await collectV4ContentSource(input.source, V4_LARGE_FILE_THRESHOLD_BYTES, signal)
          hash.update(plaintext)
          total = plaintext.byteLength
          await input.checkSourceStable?.()
          if (hash.digestHex() !== input.expectedHash) { completed = true; return }
          const bytes = this.options.mode === "plaintext"
            ? plaintext
            : await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, plaintext, { kind: "content", aad: contentAad }))
          completed = true
          yield { path: objectPaths[0], bytes, release }
          return
        } catch (error) {
          release()
          throw error
        }
      }

      const iterator = streamV4SourceParts(input.source, input.partBytes, signal)[Symbol.asyncIterator]()
      for (let index = 0; index < partCount; index++) {
        if (signal?.aborted) throw signal.reason ?? new Error("V4 object stream aborted.")
        await input.checkSourceStable?.()
        const expectedPartBytes = Math.min(input.partBytes, input.source.size - total)
        const release = await reserve(expectedPartBytes)
        let next: IteratorResult<Uint8Array>
        try {
          next = await iterator.next()
          if (next.done) throw new V4SourceChangedError(path, `source ended after ${total} bytes; expected ${input.source.size}`)
          hash.update(next.value)
          total += next.value.byteLength
          await input.checkSourceStable?.()
          const bytes = this.options.mode === "plaintext"
            ? next.value
            : await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, next.value, {
              kind: "part",
              aad: `${contentAad}:${index}`,
            }))
          yield { path: objectPaths[index], bytes, release }
        } catch (error) {
          release()
          throw error
        }
      }
      const tail = await iterator.next()
      if (!tail.done) throw new V4SourceChangedError(path, "source produced more parts than declared")
      await input.checkSourceStable?.()
      completed = true
    }.bind(this)

    return {
      objectCount: objectPaths.length,
      objectPaths,
      objects,
      async finalize() {
        if (!consumed || !completed) throw new Error("V4 object stream must finish before its record can be finalized.")
        if (total !== input.source.size) throw new V4SourceChangedError(path, `streamed ${total} bytes; expected ${input.source.size}`)
        const actualHash = hash.digestHex()
        if (actualHash !== input.expectedHash) throw new V4SourceChangedError(path, "streamed SHA-256 differs from the planner snapshot")
        return {
          pathId,
          fileId,
          plaintextSha256: actualHash,
          size: input.source.size,
          mtime: input.mtime,
          remoteVersion: input.version,
          remotePath: objectPaths[0],
          encryptedPath: mode === "encrypted" && !chunked ? objectPaths[0] : undefined,
          storage: chunked ? "chunked" : "single",
          partPaths: chunked ? [...objectPaths] : undefined,
        } satisfies V4FileRecord
      },
    }
  }


  async preparePackEntryRecord(
    logicalPath: string,
    plaintextSha256: string,
    size: number,
    version: string,
    mtime: number,
    fileId: string,
  ): Promise<V4FileRecord> {
    if (this.options.mode !== "encrypted") throw new Error("V4 pack entries are available only in encrypted mode.")
    const path = normalizeV4VaultPath(logicalPath)
    const pathId = await this.pathId(path)
    const remotePath = await this.crypto(() => opaqueV4ObjectPath(this.options.keyring!.pathKey, fileId))
    return {
      pathId,
      fileId,
      plaintextSha256,
      size,
      mtime,
      remoteVersion: version,
      remotePath,
      encryptedPath: remotePath,
      storage: "single",
    }
  }

  async relocate(record: V4FileRecord, logicalPath: string): Promise<V4FileRecord> {
    return {
      ...record,
      pathId: await this.pathId(normalizeV4VaultPath(logicalPath)),
    }
  }

  async preparePackFromSources(
    packId: string,
    entries: readonly V4PackSourceEntry[],
    signal?: AbortSignal,
  ): Promise<V4PreparedPack> {
    signal ??= this.options.signal
    if (this.options.mode !== "encrypted") throw new Error("V4 packs are available only in encrypted mode.")
    if (entries.length === 0) throw new Error("Cannot create an empty V4 pack.")
    if (!/^[A-Za-z0-9_-]+$/u.test(packId)) throw new Error("Unsafe V4 pack id.")

    const prefix = utf8ToBytes('{"version":1,"entries":{')
    const suffix = utf8ToBytes('}}')
    const layouts = entries.map((entry, index) => {
      const expectedSize = entry.expectedSize ?? entry.source.size
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new TypeError("V4 pack entry size must be a non-negative safe integer.")
      if (entry.source.size !== expectedSize) throw new V4SourceChangedError(entry.logicalPath, `source size ${entry.source.size} differs from expected ${expectedSize}`)
      const key = utf8ToBytes(JSON.stringify(entry.fileId))
      const encodedBytes = 4 * Math.ceil(expectedSize / 3)
      return { entry, index, expectedSize, key, encodedBytes }
    })
    const archiveBytes = layouts.reduce((sum, layout) => sum + (layout.index > 0 ? 1 : 0) + layout.key.byteLength + 2 + layout.encodedBytes + 1, prefix.byteLength + suffix.byteLength)
    if (!Number.isSafeInteger(archiveBytes)) throw new RangeError("V4 pack archive is too large.")
    const archive = new Uint8Array(archiveBytes)
    let archiveOffset = 0
    const writeBytes = (bytes: Uint8Array): void => { archive.set(bytes, archiveOffset); archiveOffset += bytes.byteLength }
    const writeAscii = (value: string): void => {
      for (let index = 0; index < value.length; index++) archive[archiveOffset++] = value.charCodeAt(index)
    }
    writeBytes(prefix)

    const records: V4FileRecord[] = []
    for (const layout of layouts) {
      if (signal?.aborted) throw signal.reason ?? new Error("V4 pack preparation aborted.")
      await layout.entry.checkSourceStable?.()
      const plaintext = new Uint8Array(layout.expectedSize)
      const hasher = createV4IncrementalSha256()
      let offset = 0
      const chunkBytes = Math.max(1, Math.min(1024 * 1024, layout.expectedSize || 1))
      for await (const chunk of layout.entry.source.chunks(chunkBytes, signal)) {
        if (offset + chunk.byteLength > plaintext.byteLength) throw new V4SourceChangedError(layout.entry.logicalPath, "source produced more bytes than expected")
        plaintext.set(chunk, offset)
        hasher.update(chunk)
        offset += chunk.byteLength
        await layout.entry.checkSourceStable?.()
      }
      if (offset !== plaintext.byteLength) throw new V4SourceChangedError(layout.entry.logicalPath, `source produced ${offset} bytes; expected ${plaintext.byteLength}`)
      await layout.entry.checkSourceStable?.()
      const actualHash = hasher.digestHex()
      if (actualHash !== layout.entry.expectedHash) throw new V4SourceChangedError(layout.entry.logicalPath, "content hash differs from planned snapshot")
      const record = await this.preparePackEntryRecord(
        layout.entry.logicalPath,
        actualHash,
        plaintext.byteLength,
        layout.entry.version,
        layout.entry.mtime,
        layout.entry.fileId,
      )
      records.push(record)
      if (layout.index > 0) writeAscii(",")
      writeBytes(layout.key)
      writeAscii(':"')
      const encoded = toBase64(plaintext)
      if (encoded.length !== layout.encodedBytes) throw new Error("Unexpected V4 pack base64 length.")
      writeAscii(encoded)
      writeAscii('"')
    }
    writeBytes(suffix)
    if (archiveOffset !== archive.byteLength) throw new Error("V4 pack archive length mismatch.")

    const remotePath = await this.crypto(() => opaqueV4PackPath(this.options.keyring!.pathKey, packId))
    const bytes = await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, archive, { kind: "pack", aad: packId }))
    return {
      records: records.map(record => ({ ...record, storage: "pack", remotePath, encryptedPath: remotePath, packId, partPaths: undefined })),
      file: { path: remotePath, bytes },
    }
  }

  async preparePack(
    packId: string,
    entries: Array<{ record: V4FileRecord; plaintext: Uint8Array }>,
  ): Promise<V4PreparedPack> {
    if (this.options.mode !== "encrypted") throw new Error("V4 packs are available only in encrypted mode.")
    if (entries.length === 0) throw new Error("Cannot create an empty V4 pack.")
    if (!/^[A-Za-z0-9_-]+$/u.test(packId)) throw new Error("Unsafe V4 pack id.")
    const remotePath = await this.crypto(() => opaqueV4PackPath(this.options.keyring!.pathKey, packId))
    const archive = utf8ToBytes(JSON.stringify({
      version: 1,
      entries: Object.fromEntries(entries.map(entry => [entry.record.fileId, toBase64(entry.plaintext)])),
    }))
    const bytes = await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, archive, { kind: "pack", aad: packId }))
    return {
      records: entries.map(entry => ({ ...entry.record, storage: "pack", remotePath, encryptedPath: remotePath, packId, partPaths: undefined })),
      file: { path: remotePath, bytes },
    }
  }

  private async prepareParts(
    path: string,
    pathId: string,
    fileId: string,
    plaintext: Uint8Array,
    plaintextSha256: string,
    version: string,
    mtime: number,
  ): Promise<V4PreparedRemoteWrite> {
    const parts = splitV4Parts(plaintext)
    const opaqueId = this.options.mode === "encrypted"
      ? await this.crypto(() => objectIdForV4File(this.options.keyring!.pathKey, fileId))
      : undefined
    const partPaths = buildV4PartPaths({
      mode: this.options.mode,
      logicalPath: path,
      version,
      partCount: parts.length,
      opaqueId,
    })
    const files = await Promise.all(parts.map(async (part, index) => ({
      path: partPaths[index],
      bytes: this.options.mode === "plaintext"
        ? part
        : await this.crypto(() => encryptV4Payload(this.options.keyring!.contentKey, part, {
          kind: "part",
          aad: `${this.contentAad({ fileId, pathId, remoteVersion: version })}:${index}`,
        })),
    })))
    return {
      record: {
        pathId,
        fileId,
        plaintextSha256,
        size: plaintext.byteLength,
        mtime,
        remoteVersion: version,
        remotePath: partPaths[0],
        storage: "chunked",
        partPaths,
      },
      files,
    }
  }

  async readToSink(input: {
    record: V4FileRecord
    reader: V4RemoteBytesReader
    sink: V4StagedSink
    signal?: AbortSignal
  }): Promise<{ plaintextSha256: string; size: number }> {
    const { record, reader, sink } = input
    const signal = input.signal ?? this.options.signal
    const hash = createV4IncrementalSha256()
    let total = 0
    const append = async (plaintext: Uint8Array) => {
      if (signal?.aborted) throw signal.reason ?? new Error("V4 remote read aborted.")
      if (total + plaintext.byteLength > record.size) throw new Error(`V4 content size mismatch: ${record.remotePath}`)
      hash.update(plaintext)
      total += plaintext.byteLength
      await sink.append(plaintext)
    }

    if (record.storage === "chunked") {
      const partPaths = record.partPaths ?? []
      if (partPaths.length === 0) throw new Error("V4 chunked record has no parts.")
      for (let index = 0; index < partPaths.length; index++) {
        if (signal?.aborted) throw signal.reason ?? new Error("V4 remote read aborted.")
        const bytes = await reader(partPaths[index])
        const plaintext = this.options.mode === "plaintext"
          ? bytes
          : await this.crypto(() => decryptV4Payload(this.options.keyring!.contentKey, bytes, {
            kind: "part",
            aad: `${this.contentAad(record)}:${index}`,
          }))
        await append(plaintext)
      }
    } else {
      await append(await this.read(record, reader))
    }

    const plaintextSha256 = hash.digestHex()
    if (total !== record.size) throw new Error(`V4 content size mismatch: expected ${record.size}, got ${total}.`)
    if (record.plaintextSha256 && plaintextSha256 !== record.plaintextSha256) throw new Error(`V4 content hash mismatch: ${record.remotePath}`)
    return { plaintextSha256, size: total }
  }

  async read(record: V4FileRecord, reader: V4RemoteBytesReader, signal: AbortSignal | undefined = this.options.signal): Promise<Uint8Array> {
    throwIfV4Aborted(signal)
    if (record.storage === "pack") {
      if (this.options.mode !== "encrypted" || !record.packId) throw new Error("Invalid V4 pack record.")
      const payload = await reader(record.remotePath)
      throwIfV4Aborted(signal)
      const archive = await this.crypto(() => decryptV4Payload(this.options.keyring!.contentKey, payload, { kind: "pack", aad: record.packId! }))
      const parsed = JSON.parse(bytesToUtf8(archive)) as { version?: number; entries?: Record<string, string> }
      const encoded = parsed.version === 1 ? parsed.entries?.[record.fileId] : undefined
      if (!encoded) throw new Error(`V4 pack entry is missing: ${record.fileId}`)
      const plaintext = fromBase64(encoded)
      if (record.plaintextSha256 && await this.crypto(() => sha256Hex(plaintext)) !== record.plaintextSha256) throw new Error("V4 packed content hash mismatch.")
      return plaintext
    }
    if (record.storage === "single") {
      const bytes = await reader(record.remotePath)
      throwIfV4Aborted(signal)
      const plaintext = this.options.mode === "plaintext"
        ? bytes
        : await this.crypto(() => decryptV4Payload(this.options.keyring!.contentKey, bytes, {
          kind: "content",
          aad: this.contentAad(record),
        }))
      if (record.plaintextSha256 && await this.crypto(() => sha256Hex(plaintext)) !== record.plaintextSha256) {
        throw new Error(`V4 content hash mismatch: ${record.remotePath}`)
      }
      return plaintext
    }
    const partPaths = record.partPaths ?? []
    if (partPaths.length === 0) throw new Error("V4 chunked record has no parts.")
    const parts = await Promise.all(partPaths.map(async (path, index) => {
      throwIfV4Aborted(signal)
      const bytes = await reader(path)
      throwIfV4Aborted(signal)
      return this.options.mode === "plaintext"
        ? bytes
        : this.crypto(() => decryptV4Payload(this.options.keyring!.contentKey, bytes, {
          kind: "part",
          aad: `${this.contentAad(record)}:${index}`,
        }))
    }))
    return joinAndVerifyV4Parts(parts, record.plaintextSha256)
  }
}
