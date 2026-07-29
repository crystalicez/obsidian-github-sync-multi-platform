import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import type { V4StagedSink } from "../../src/lib/v4/staging-store"

const GiB = 1024 * 1024 * 1024

test("virtual 5 GiB-shaped pull processes 107 remote parts sequentially without joining the logical file", async () => {
  const partCount = Math.ceil((5 * GiB) / V4_PART_BYTES)
  assert.equal(partCount, 107)
  const plaintext = Uint8Array.from({ length: partCount }, (_, index) => index & 0xff)
  const paths = Array.from({ length: partCount }, (_, index) => `virtual/${String(index + 1).padStart(6, "0")}.part`)
  let activeReads = 0
  let maxActiveReads = 0
  let appended = 0
  const sink: V4StagedSink = {
    async append(chunk) { appended += chunk.byteLength },
  }
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const result = await codec.readToSink({
    record: {
      path: "virtual-5g.bin",
      pathId: "p",
      fileId: "f",
      plaintextSha256: await sha256Hex(plaintext),
      size: plaintext.byteLength,
      mtime: 1,
      remoteVersion: "v1",
      remotePath: paths[0],
      storage: "chunked",
      partPaths: paths,
    },
    reader: async path => {
      activeReads++
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        const index = paths.indexOf(path)
        assert.notEqual(index, -1)
        return plaintext.subarray(index, index + 1)
      } finally {
        activeReads--
      }
    },
    sink,
  })
  assert.equal(maxActiveReads, 1)
  assert.equal(appended, plaintext.byteLength)
  assert.deepEqual(result, { plaintextSha256: await sha256Hex(plaintext), size: plaintext.byteLength })
})

test("chunked pull rejects corrupt content before a staged sink can be committed", async () => {
  const expected = new Uint8Array([1, 2, 3])
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const writes: number[] = []
  await assert.rejects(codec.readToSink({
    record: {
      path: "asset.bin",
      pathId: "p",
      fileId: "f",
      plaintextSha256: await sha256Hex(expected),
      size: 3,
      mtime: 1,
      remoteVersion: "v1",
      remotePath: "a.part",
      storage: "chunked",
      partPaths: ["a.part", "b.part", "c.part"],
    },
    reader: async path => new Uint8Array([path === "b.part" ? 9 : path === "a.part" ? 1 : 3]),
    sink: { async append(chunk) { writes.push(chunk[0]) } },
  }), /hash mismatch/iu)
  assert.deepEqual(writes, [1, 9, 3])
})
