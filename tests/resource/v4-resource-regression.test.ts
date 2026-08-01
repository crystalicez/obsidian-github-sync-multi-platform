import assert from "node:assert/strict"
import test from "node:test"

import type { V4ContentSource } from "../../src/lib/v4/content-source"
import { V4_LARGE_FILE_THRESHOLD_BYTES, V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { selectV4WriterPartBytes } from "../../src/lib/v4/part-write-policy"
import { DEFAULT_V4_RESOURCE_LIMITS, estimateV4GitBlobTransportBytes } from "../../src/lib/v4/resource-controller"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"

const MiB = 1024 * 1024

function unopened(size: number, onOpen: () => void): V4ContentSource {
  return { size, async *chunks() { onOpen(); throw new Error("qualification source must remain lazy") } }
}

test("resource regression keeps threshold-1 threshold threshold+1 and 512 MiB preparation lazy", async () => {
  const cases = [
    { size: V4_LARGE_FILE_THRESHOLD_BYTES - 1, expected: 1 },
    { size: V4_LARGE_FILE_THRESHOLD_BYTES, expected: 1 },
    { size: V4_LARGE_FILE_THRESHOLD_BYTES + 1, expected: 2 },
    { size: 512 * MiB, expected: Math.ceil((512 * MiB) / V4_PART_BYTES) },
  ]
  for (const input of cases) {
    let opened = 0
    const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
    const prepared = await codec.prepareFromSource({
      logicalPath: `virtual-${input.size}.bin`,
      source: unopened(input.size, () => { opened++ }),
      expectedHash: "0".repeat(64),
      version: "qualification",
      mtime: 1,
      fileId: `f-${input.size}`,
      partBytes: V4_PART_BYTES,
    })
    assert.equal(opened, 0)
    assert.equal(prepared.objectCount, input.expected)
  }
})

test("resource regression bounds writer object memory independently of 512 MiB logical size", () => {
  const selected = selectV4WriterPartBytes({ logicalBytes: 512 * MiB, maxTransportTransientBytes: DEFAULT_V4_RESOURCE_LIMITS.maxTransportTransientBytes })
  assert.equal(selected, V4_PART_BYTES)
  const transient = estimateV4GitBlobTransportBytes(selected + 33)
  assert.ok(transient <= DEFAULT_V4_RESOURCE_LIMITS.maxTransportTransientBytes)
  assert.ok(selected <= DEFAULT_V4_RESOURCE_LIMITS.maxResidentBytes)
})

test("resource regression refuses a writer part policy that cannot fit transport and mutation budgets", () => {
  assert.throws(() => selectV4WriterPartBytes({ logicalBytes: 512 * MiB, maxTransportTransientBytes: 4 * MiB, maxContentMutations: 20 }), /no safe V4 writer part size/iu)
})

test("incremental SHA does not create one Uint8Array view per 64-byte compression block", async () => {
  const { createV4IncrementalSha256 } = await import("../../src/lib/v4/incremental-hash")
  let subarrayCalls = 0
  class CountingBytes extends Uint8Array {
    override subarray(begin?: number, end?: number): Uint8Array {
      subarrayCalls++
      return super.subarray(begin, end)
    }
  }
  const bytes = new CountingBytes(4 * MiB)
  const hash = createV4IncrementalSha256()
  hash.update(bytes)
  hash.digestHex()
  assert.ok(subarrayCalls <= 4, `created ${subarrayCalls} subarray views for one 4 MiB update`)
})
