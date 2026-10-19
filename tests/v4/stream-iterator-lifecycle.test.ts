import assert from "node:assert/strict"
import test from "node:test"

import type { V4ContentSource } from "../../src/lib/v4/content-source"
import { streamV4SourceParts, V4SourceChangedError } from "../../src/lib/v4/object-stream"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "../../src/lib/v4/large-files"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { uploadV4ObjectStream } from "../../src/lib/v4/git-tree-writer"

test("bounded part stream rejects excess bytes hidden behind empty source chunks", async () => {
  let closed = false
  const source: V4ContentSource = {
    size: 3,
    async *chunks() {
      try {
        yield new Uint8Array([1, 2, 3])
        yield new Uint8Array(0)
        yield new Uint8Array([4])
      } finally {
        closed = true
      }
    },
  }
  const seen: number[][] = []
  await assert.rejects(async () => {
    for await (const part of streamV4SourceParts(source, 3)) seen.push([...part])
  }, error => error instanceof V4SourceChangedError)
  assert.deepEqual(seen, [[1, 2, 3]])
  assert.equal(closed, true)
})

test("trailing empty chunks still respect cancellation", async () => {
  const controller = new AbortController()
  const source: V4ContentSource = {
    size: 3,
    async *chunks() {
      yield new Uint8Array([1, 2, 3])
      controller.abort(new Error("source read cancelled"))
      yield new Uint8Array(0)
      yield new Uint8Array([4])
    },
  }
  await assert.rejects(async () => {
    for await (const _part of streamV4SourceParts(source, 3, controller.signal)) { }
  }, /source read cancelled/)
})

test("stopping a bounded part stream closes its underlying file source", async () => {
  let closed = false
  const source: V4ContentSource = {
    size: 4,
    async *chunks() {
      try {
        yield new Uint8Array([1, 2])
        yield new Uint8Array([3, 4])
      } finally {
        closed = true
      }
    },
  }
  for await (const part of streamV4SourceParts(source, 2)) {
    assert.deepEqual([...part], [1, 2])
    break
  }
  assert.equal(closed, true)
})

test("stopping a prepared multipart upload closes the active source iterator", async () => {
  let closed = false
  const partBytes = 4 * 1024 * 1024
  const source: V4ContentSource = {
    size: V4_GITHUB_REST_SAFE_WRITER_BYTES + 1,
    async *chunks() {
      try {
        yield new Uint8Array(partBytes).fill(7)
        yield new Uint8Array(1)
      } finally {
        closed = true
      }
    },
  }
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "large.bin", source, expectedHash: "0".repeat(64),
    version: "stream-test", mtime: 1, fileId: "test-file", partBytes,
  })
  for await (const object of prepared.objects()) {
    assert.equal(object.bytes.byteLength, partBytes)
    assert.equal(object.bytes[0], 7)
    object.release?.()
    break
  }
  assert.equal(closed, true)
  await assert.rejects(prepared.finalize(), /must finish/)
})

test("a failed Git blob upload closes the active multipart file source", async () => {
  let closed = false
  const partBytes = 4 * 1024 * 1024
  const source: V4ContentSource = {
    size: V4_GITHUB_REST_SAFE_WRITER_BYTES + 1,
    async *chunks() {
      try {
        yield new Uint8Array(partBytes)
        yield new Uint8Array(partBytes)
        yield new Uint8Array(1)
      } finally {
        closed = true
      }
    },
  }
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "failing.bin", source, expectedHash: "0".repeat(64),
    version: "stream-test", mtime: 1, fileId: "test-file", partBytes,
  })
  const github = {
    async getGitRefOrNull() { return null },
    async getGitCommit() { throw new Error("not used") },
    async createGitBlob() { throw new Error("upload failed") },
    async createGitTree() { throw new Error("not used") },
    async createGitCommit() { throw new Error("not used") },
    async createGitRef() { throw new Error("not used") },
    async updateGitRef() { throw new Error("not used") },
  }
  await assert.rejects(
    uploadV4ObjectStream(github, { objects: prepared.objects(), maxConcurrentUploads: 1 }),
    /upload failed/,
  )
  assert.equal(closed, true)
  await assert.rejects(prepared.finalize(), /must finish/)
})
