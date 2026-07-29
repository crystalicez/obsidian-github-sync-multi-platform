import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { createV4IncrementalSha256 } from "../../src/lib/v4/incremental-hash"
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files"
import { createV4WholeBufferContentSource, type V4ContentSource } from "../../src/lib/v4/content-source"
import { uploadV4ObjectStream } from "../../src/lib/v4/git-tree-writer"
import {
  hashV4StableContentSource,
  V4SourceChangedError,
} from "../../src/lib/v4/object-stream"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"

const bytes = (value: string) => new TextEncoder().encode(value)

test("snapshot hashing rejects a file whose mtime changes during the read", async () => {
  const data = bytes("abcdefgh")
  let checks = 0
  const source: V4ContentSource = {
    size: data.byteLength,
    async *chunks() {
      yield data.subarray(0, 4)
      yield data.subarray(4)
    },
  }
  await assert.rejects(
    hashV4StableContentSource(source, {
      chunkBytes: 4,
      checkStable: async () => {
        checks++
        if (checks >= 3) throw new V4SourceChangedError("note.md", "mtime changed")
      },
    }),
    error => error instanceof V4SourceChangedError,
  )
  assert.ok(checks >= 3)
})

test("mutating streamed bytes after part N cannot create a candidate or publish a ref", async () => {
  const partBytes = 4 * 1024 * 1024
  const logicalBytes = V4_LARGE_FILE_THRESHOLD_BYTES + 1
  const expected = createV4IncrementalSha256()
  for (let offset = 0; offset < logicalBytes; offset += partBytes) {
    expected.update(new Uint8Array(Math.min(partBytes, logicalBytes - offset)))
  }
  const expectedHash = expected.digestHex()
  let part = 0
  const source: V4ContentSource = {
    size: logicalBytes,
    async *chunks(chunkBytes) {
      assert.equal(chunkBytes, partBytes)
      for (let offset = 0; offset < logicalBytes; offset += partBytes) {
        const chunk = new Uint8Array(Math.min(partBytes, logicalBytes - offset))
        if (part++ === 2) chunk[0] = 1
        yield chunk
      }
    },
  }
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "large.bin",
    source,
    expectedHash,
    version: "run-1",
    mtime: 1,
    fileId: "file-1",
    partBytes,
  })
  const events: string[] = []
  const github = {
    async getGitRefOrNull() { return null },
    async getGitCommit() { throw new Error("not used") },
    async createGitBlob() { events.push("blob"); return `blob-${events.length}` },
    async createGitTree() { events.push("tree"); return "tree-1" },
    async createGitCommit() { events.push("commit"); return "commit-1" },
    async createGitRef() { events.push("ref") },
    async updateGitRef() { events.push("ref") },
  }

  await uploadV4ObjectStream(github, { objects: prepared.objects() })
  assert.ok(part > 2)
  await assert.rejects(prepared.finalize(), error => error instanceof V4SourceChangedError)
  assert.equal(events.some(event => event === "tree" || event === "commit" || event === "ref"), false)
})

test("stable streamed bytes finalize to the planner hash", async () => {
  const data = bytes("AAAABBBBCCCC")
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "large.bin",
    source: createV4WholeBufferContentSource(data),
    expectedHash: await sha256Hex(data),
    version: "run-2",
    mtime: 2,
    fileId: "file-2",
    partBytes: 4,
  })
  const paths: string[] = []
  for await (const object of prepared.objects()) { paths.push(object.path); object.release?.() }
  const record = await prepared.finalize()
  assert.equal(record.plaintextSha256, await sha256Hex(data))
  assert.equal(record.storage, "single")
  assert.deepEqual(paths, [record.remotePath])
})

test("periodic source checks stop a long stream before all parts are uploaded", async () => {
  const partBytes = 4 * 1024 * 1024
  const logicalBytes = V4_LARGE_FILE_THRESHOLD_BYTES + 1
  const expected = createV4IncrementalSha256()
  for (let offset = 0; offset < logicalBytes; offset += partBytes) expected.update(new Uint8Array(Math.min(partBytes, logicalBytes - offset)))
  const source: V4ContentSource = {
    size: logicalBytes,
    async *chunks() {
      for (let offset = 0; offset < logicalBytes; offset += partBytes) yield new Uint8Array(Math.min(partBytes, logicalBytes - offset))
    },
  }
  let checks = 0
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "changing.bin",
    source,
    expectedHash: expected.digestHex(),
    version: "run-check",
    mtime: 1,
    fileId: "changing-file",
    partBytes,
    checkSourceStable: async () => {
      checks++
      if (checks === 5) throw new V4SourceChangedError("changing.bin", "mtime changed")
    },
  })
  let blobs = 0
  const github = {
    async getGitRefOrNull() { return null },
    async getGitCommit() { throw new Error("not used") },
    async createGitBlob() { blobs++; return `blob-${blobs}` },
    async createGitTree() { throw new Error("not used") },
    async createGitCommit() { throw new Error("not used") },
    async createGitRef() {},
    async updateGitRef() {},
  }
  await assert.rejects(uploadV4ObjectStream(github, { objects: prepared.objects() }), error => error instanceof V4SourceChangedError)
  assert.ok(blobs > 0)
  assert.ok(blobs < prepared.objectCount)
})
