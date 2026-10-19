import assert from "node:assert/strict"
import test from "node:test"

import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { estimateV4GitBlobTransportBytes } from "../../src/lib/v4/resource-controller"
import {
  V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION,
  selectV4WriterPartBytes,
} from "../../src/lib/v4/part-write-policy"

const MiB = 1024 * 1024
const TEST_BYTES = 100_000_000

test("100 MB writer caps new GitHub REST blobs to 8 MiB", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: TEST_BYTES,
    maxTransportTransientBytes: 256 * MiB,
  })
  assert.equal(selected, 8 * MiB)
  assert.equal(V4_PART_BYTES, 48 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 256 * MiB)
  assert.ok(Math.ceil(TEST_BYTES / selected) <= V4_GITHUB_SAFE_CONTENT_MUTATIONS_PER_REVISION)
})

test("100 MB writer respects the REST cap even when transport memory permits larger objects", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: TEST_BYTES,
    maxTransportTransientBytes: 128 * MiB,
  })
  assert.equal(selected, 8 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 128 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected + MiB) <= 128 * MiB)
})

test("100 MB writer still shrinks parts below 8 MiB when transport memory is limited", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: TEST_BYTES,
    maxTransportTransientBytes: 20 * MiB,
  })
  assert.equal(selected, 4 * MiB)
  assert.ok(estimateV4GitBlobTransportBytes(selected) <= 20 * MiB)
})

test("100 MB writer rejects an impossible combined transport/mutation budget", () => {
  assert.throws(() => selectV4WriterPartBytes({
    logicalBytes: TEST_BYTES,
    maxTransportTransientBytes: 32 * MiB,
    maxContentMutations: 3,
  }), /no safe V4 writer part size/iu)
})
