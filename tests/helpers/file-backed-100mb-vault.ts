import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"

import type { V4ContentHandle, V4ContentSource } from "../../src/lib/v4/content-source"
import { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } from "../../src/lib/v4/content-source"
import { assertV4LocalTargetPrecondition, type V4LocalTargetPrecondition, type V4SessionVault } from "../../src/lib/v4/local-io"
import { createV4StagingStore, type V4StageRef } from "../../src/lib/v4/staging-store"

export const TEST_100MB_BYTES = 100_000_000
const CHUNK_BYTES = 8 * 1024 * 1024

async function* fileChunks(fullPath: string, size: number, chunkBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= TEST_100MB_BYTES)
  const before = await stat(fullPath)
  assert.equal(before.size, size, "File changed before bounded read")
  let total = 0
  for await (const data of createReadStream(fullPath, { highWaterMark: Math.min(chunkBytes, CHUNK_BYTES), signal })) {
    const bytes = new Uint8Array(data)
    total += bytes.byteLength
    if (total > size) throw new Error("Bounded source exceeded declared size")
    yield bytes
  }
  assert.equal(total, size, "Bounded source ended before declared size")
}

export async function generateTest100MBFile(fullPath: string): Promise<string> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  for (let index = 0; index < buffer.byteLength; index++) buffer[index] = (index * 31 + 17) & 255
  const file = await open(fullPath, "wx")
  try {
    let written = 0
    while (written < TEST_100MB_BYTES) {
      const desired = Math.min(buffer.byteLength, TEST_100MB_BYTES - written)
      const result = await file.write(buffer, 0, desired, written)
      assert.ok(result.bytesWritten > 0)
      written += result.bytesWritten
    }
  } finally {
    await file.close()
  }
  assert.equal((await stat(fullPath)).size, TEST_100MB_BYTES)
  return hashFile100MB(fullPath)
}

export async function hashFile100MB(fullPath: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const bytes of fileChunks(fullPath, TEST_100MB_BYTES, CHUNK_BYTES)) hash.update(bytes)
  return hash.digest("hex")
}

// Only supports a single explicit payload path and private stage files in a fresh synthetic vault.
export class TestDisk100MBVault implements V4SessionVault {
  readonly payloadName = "payload.bin"
  readonly root: string
  wholeReads = 0
  boundedReads = 0
  stagedCommits = 0
  stagedWrites = 0
  failAppendAt: number | null = null

  constructor(root: string) {
    this.root = root
  }

  payloadPath(): string { return path.join(this.root, this.payloadName) }

  private stagePath(value: string): string {
    if (!/^stage\/[A-Za-z0-9_-]+\.bin$/u.test(value)) throw new Error("Invalid test stage path")
    return path.join(this.root, ...value.split("/"))
  }

  private async safeStat() {
    try { return await stat(this.payloadPath()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async listFiles() {
    const file = await this.safeStat()
    return file ? [{ path: this.payloadName, size: file.size, mtime: file.mtimeMs }] : []
  }

  async stat(name: string) {
    if (name !== this.payloadName) throw new Error("Unexpected file path for synthetic vault")
    const file = await this.safeStat()
    return file ? { path: name, size: file.size, mtime: file.mtimeMs } : null
  }

  async read(name: string): Promise<Uint8Array> {
    if (name !== this.payloadName) throw new Error("Unexpected file path for synthetic vault")
    this.wholeReads++
    const file = await this.safeStat()
    if (!file || file.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
      throw new Error("Whole-file read of 100MB payload forbidden")
    }
    return new Uint8Array(await readFile(this.payloadPath()))
  }

  private fileSource(fullPath: string, size: number): V4ContentSource {
    const vault = this
    return {
      size,
      async *chunks(chunkBytes, signal) {
        vault.boundedReads++
        yield* fileChunks(fullPath, size, chunkBytes, signal)
      },
    }
  }

  async openContentSource(handle: V4ContentHandle): Promise<V4ContentSource> {
    if (handle.kind === "stage") return this.staging.open({ stageId: handle.stageId, size: handle.expectedSize })
    const file = await this.stat(handle.path)
    if (!file || file.size !== handle.expectedSize || file.mtime !== handle.expectedMtime) {
      throw new Error("Source file changed after scan")
    }
    return this.fileSource(this.payloadPath(), file.size)
  }

  async write(): Promise<void> { throw new Error("100MB pull must use bounded stage commit") }
  async trash(): Promise<void> { throw new Error("Unexpected trash in 100MB test") }

  staging = createV4StagingStore({
    root: "stage",
    wholeBufferCeilingBytes: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES,
    backend: {
      boundedAppend: true,
      write: async (name, bytes) => {
        await mkdir(path.join(this.root, "stage"), { recursive: true })
        await writeFile(this.stagePath(name), bytes, { flag: "wx" })
        this.stagedWrites++
      },
      append: async (name, bytes) => {
        if (this.failAppendAt === this.stagedWrites + 1) {
          this.failAppendAt = null
          throw new Error("Synthetic bounded stage append interruption")
        }
        await appendFile(this.stagePath(name), bytes)
        this.stagedWrites++
      },
      remove: async name => { await rm(this.stagePath(name), { force: true }) },
      openSource: async (name, size) => this.fileSource(this.stagePath(name), size),
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
    },
  })

  async commitStage(input: { stage: V4StageRef; path: string; precondition: V4LocalTargetPrecondition }): Promise<void> {
    if (input.path !== this.payloadName) throw new Error("Unexpected final target path")
    await assertV4LocalTargetPrecondition(this, input.precondition)
    const staged = this.stagePath(this.staging.pathFor(input.stage.stageId))
    assert.equal((await stat(staged)).size, input.stage.size)
    await rename(staged, this.payloadPath())
    await utimes(this.payloadPath(), input.stage.mtime / 1000, input.stage.mtime / 1000)
    this.stagedCommits++
  }
}
