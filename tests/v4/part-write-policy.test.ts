import assert from "node:assert/strict"
import test from "node:test"

import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { estimateV4GitBlobTransportBytes } from "../../src/lib/v4/resource-controller"
import {
  V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION,
  selectV4WriterPartBytes,
} from "../../src/lib/v4/part-write-policy"

const MiB = 1024 * 1024
const GiB = 1024 * MiB

test("writer keeps the historical 48 MiB part when transport and mutation constraints both fit", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: 5 * GiB,
    maxTransportTransientBytes: 256 * MiB,
  })
  assert.equal(selected, V4_PART_BYTES)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 256 * MiB)
  assert.ok(Math.ceil((5 * GiB) / selected) <= V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION)
})

test("writer chooses the largest MiB-aligned part allowed by measured transport memory", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: 5 * GiB,
    maxTransportTransientBytes: 128 * MiB,
  })
  assert.equal(selected, 27 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 128 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected + MiB) > 128 * MiB)
})

test("writer rejects a transport budget that would violate safe mutation headroom", () => {
  assert.throws(() => selectV4WriterPartBytes({
    logicalBytes: 5 * GiB,
    maxTransportTransientBytes: 32 * MiB,
  }), /no safe V4 writer part size/iu)
})
