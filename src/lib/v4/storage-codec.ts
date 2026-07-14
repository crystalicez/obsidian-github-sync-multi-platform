import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload, type V4Keyring } from "./crypto"
import {
  buildV4PartPaths,
  joinAndVerifyV4Parts,
  shouldUseV4Parts,
  splitV4Parts,
} from "./large-files"
import { normalizeV4VaultPath, objectIdForV4File, opaqueV4ObjectPath, opaqueV4PackPath, pathIdForV4Path } from "./paths"
import { type V4FileRecord, type V4PathLayout, type V4StorageMode } from "./protocol-types"

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

export class V4StorageCodec {
  constructor(private readonly options: { mode: V4StorageMode; pathLayout: V4PathLayout; keyring?: V4Keyring }) {
    if (options.mode === "encrypted" && !options.keyring) {
      throw new Error("Encrypted V4 storage requires a keyring.")
    }
  }

  private contentAad(record: { fileId: string; pathId: string; remoteVersion: string }): string {
    return this.options.pathLayout === "opaque-stable-v1"
      ? `${record.fileId}:${record.remoteVersion}`
      : `${record.pathId}:${record.remoteVersion}`
  }

  private async pathId(path: string): Promise<string> {
    if (this.options.mode === "encrypted") {
      return pathIdForV4Path(this.options.keyring!.pathKey, path)
    }
    return sha256Hex(new TextEncoder().encode(`path:${path}`))
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
    const plaintextSha256 = await sha256Hex(plaintext)
    const predictedBytes = plaintext.byteLength + (this.options.mode === "encrypted" ? 33 : 0)
    if (shouldUseV4Parts(plaintext.byteLength, predictedBytes)) {
      return this.prepareParts(path, pathId, stableFileId, plaintext, plaintextSha256, version, mtime)
    }

    const remotePath = this.options.mode === "plaintext"
      ? path
      : await opaqueV4ObjectPath(this.options.keyring!.pathKey, stableFileId)
    const bytes = this.options.mode === "plaintext"
      ? plaintext
      : await encryptV4Payload(this.options.keyring!.contentKey, plaintext, {
        kind: "content",
        aad: this.contentAad({ fileId: stableFileId, pathId, remoteVersion: version }),
      })
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

  async preparePack(
    packId: string,
    entries: Array<{ record: V4FileRecord; plaintext: Uint8Array }>,
  ): Promise<V4PreparedPack> {
    if (this.options.mode !== "encrypted") throw new Error("V4 packs are available only in encrypted mode.")
    if (entries.length === 0) throw new Error("Cannot create an empty V4 pack.")
    if (!/^[A-Za-z0-9_-]+$/u.test(packId)) throw new Error("Unsafe V4 pack id.")
    const remotePath = await opaqueV4PackPath(this.options.keyring!.pathKey, packId)
    const archive = utf8ToBytes(JSON.stringify({
      version: 1,
      entries: Object.fromEntries(entries.map(entry => [entry.record.fileId, toBase64(entry.plaintext)])),
    }))
    const bytes = await encryptV4Payload(this.options.keyring!.contentKey, archive, { kind: "pack", aad: packId })
    return {
      records: entries.map(entry => ({ ...entry.record, storage: "pack", remotePath, packId, partPaths: undefined })),
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
      ? await objectIdForV4File(this.options.keyring!.pathKey, fileId)
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
        : await encryptV4Payload(this.options.keyring!.contentKey, part, {
          kind: "part",
          aad: `${this.contentAad({ fileId, pathId, remoteVersion: version })}:${index}`,
        }),
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

  async read(record: V4FileRecord, reader: V4RemoteBytesReader): Promise<Uint8Array> {
    if (record.storage === "pack") {
      if (this.options.mode !== "encrypted" || !record.packId) throw new Error("Invalid V4 pack record.")
      const payload = await reader(record.remotePath)
      const archive = await decryptV4Payload(this.options.keyring!.contentKey, payload, { kind: "pack", aad: record.packId })
      const parsed = JSON.parse(bytesToUtf8(archive)) as { version?: number; entries?: Record<string, string> }
      const encoded = parsed.version === 1 ? parsed.entries?.[record.fileId] : undefined
      if (!encoded) throw new Error(`V4 pack entry is missing: ${record.fileId}`)
      const plaintext = fromBase64(encoded)
      if (record.plaintextSha256 && await sha256Hex(plaintext) !== record.plaintextSha256) throw new Error("V4 packed content hash mismatch.")
      return plaintext
    }
    if (record.storage === "single") {
      const bytes = await reader(record.remotePath)
      const plaintext = this.options.mode === "plaintext"
        ? bytes
        : await decryptV4Payload(this.options.keyring!.contentKey, bytes, {
          kind: "content",
          aad: this.contentAad(record),
        })
      if (record.plaintextSha256 && await sha256Hex(plaintext) !== record.plaintextSha256) {
        throw new Error(`V4 content hash mismatch: ${record.remotePath}`)
      }
      return plaintext
    }
    const partPaths = record.partPaths ?? []
    if (partPaths.length === 0) throw new Error("V4 chunked record has no parts.")
    const parts = await Promise.all(partPaths.map(async (path, index) => {
      const bytes = await reader(path)
      return this.options.mode === "plaintext"
        ? bytes
        : decryptV4Payload(this.options.keyring!.contentKey, bytes, {
          kind: "part",
          aad: `${this.contentAad(record)}:${index}`,
        })
    }))
    return joinAndVerifyV4Parts(parts, record.plaintextSha256)
  }
}
