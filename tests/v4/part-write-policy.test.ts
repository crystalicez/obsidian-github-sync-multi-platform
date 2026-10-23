import assert from "node:assert/strict"
import test from "node:test"

import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { estimateV4GitBlobTransportBytes } from "../../src/lib/v4/resource-controller"
import {
  V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION,
  selectV4WriterPartBytes,
} from "../../src/lib/v4/part-write-policy"

const MiB = 1024 * 1024

test("new 100 MB REST writer is bounded at the empirically verified 8 MiB ceiling", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: 100_000_000,
    maxTransportTransientBytes: 256 * MiB,
  })
  assert.equal(V4_PART_BYTES, 48 * MiB, "historical 48 MiB read compatibility is unchanged")
  assert.equal(selected, 8 * MiB)
  assert.equal(Math.ceil(100_000_000 / selected), 12)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 256 * MiB)
  assert.ok(Math.ceil(100_000_000 / selected) <= V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION)
})

test("writer chooses the largest MiB-aligned part allowed by measured transport memory", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: 100_000_000,
    maxTransportTransientBytes: 128 * MiB,
  })
  assert.equal(selected, 8 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 128 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected + MiB) <= 128 * MiB, "REST compatibility, not RAM, must cap the writer")
})

test("writer rejects a transport budget that would violate safe mutation headroom", () => {
  assert.throws(() => selectV4WriterPartBytes({
    logicalBytes: 100_000_000,
    maxTransportTransientBytes: 256 * MiB,
    maxContentMutations: 10,
  }), /no safe V4 writer part size/iu)
})
