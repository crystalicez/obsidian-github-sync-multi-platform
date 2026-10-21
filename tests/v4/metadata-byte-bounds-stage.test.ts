import assert from "node:assert/strict"
import test from "node:test"
import { assertV4MetadataBytes, V4_METADATA_MAX_BYTES } from "../../src/lib/v4/metadata-bounds"
import { V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } from "../../src/lib/v4/crypto"

test("remote metadata limits accept exact boundary and reject one excess byte", () => {
  for (const [kind, limit] of Object.entries(V4_METADATA_MAX_BYTES) as Array<[keyof typeof V4_METADATA_MAX_BYTES, number]>) {
    assert.doesNotThrow(() => assertV4MetadataBytes(new Uint8Array(limit), kind))
    assert.throws(() => assertV4MetadataBytes(new Uint8Array(limit + 1), kind), /metadata exceeds.*byte limit/)
  }
})

test("encrypted metadata wire limits count fixed authenticated framing exactly once", () => {
  const kind = "head"
  const permitted = V4_METADATA_MAX_BYTES[kind] + V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES
  assert.doesNotThrow(() => assertV4MetadataBytes(new Uint8Array(permitted), kind, true))
  assert.throws(() => assertV4MetadataBytes(new Uint8Array(permitted + 1), kind, true), /metadata exceeds/)
  assert.throws(() => assertV4MetadataBytes(new Uint8Array(permitted), kind, false), /metadata exceeds/)
})
