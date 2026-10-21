import assert from "node:assert/strict"
import test from "node:test"
import { V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } from "../../src/lib/v4/crypto"
import { assertV4MetadataBytes, V4_METADATA_MAX_BYTES } from "../../src/lib/v4/metadata-bounds"
import { decodeV4RemoteConfig, encodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard } from "../../src/lib/v4/remote-index"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"

const encoder = new TextEncoder()
const repoId = "owner/repo#main"
const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId, pathLayout: "plaintext-v1" }
function padded(value: unknown, size: number): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value))
  assert.ok(bytes.length < size)
  const result = new Uint8Array(size).fill(0x20)
  result.set(bytes)
  return result
}

test("metadata bounds accept their byte limit and reject one extra byte", () => {
  for (const [kind, limit] of Object.entries(V4_METADATA_MAX_BYTES) as Array<[keyof typeof V4_METADATA_MAX_BYTES, number]>) {
    assert.doesNotThrow(() => assertV4MetadataBytes(new Uint8Array(limit), kind))
    assert.throws(() => assertV4MetadataBytes(new Uint8Array(limit + 1), kind), /metadata exceeds/)
  }
})

test("encrypted metadata bounds include the fixed authenticated framing once", () => {
  const cap = V4_METADATA_MAX_BYTES.head + V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES
  assert.doesNotThrow(() => assertV4MetadataBytes(new Uint8Array(cap), "head", true))
  assert.throws(() => assertV4MetadataBytes(new Uint8Array(cap + 1), "head", true), /metadata exceeds/)
})

test("remote config encode and decode reject oversized JSON before parsing", () => {
  assert.deepEqual(decodeV4RemoteConfig(encodeV4RemoteConfig(config)), config)
  assert.throws(() => encodeV4RemoteConfig({ ...config, repoId: "x".repeat(V4_METADATA_MAX_BYTES.config) }), /V4 config metadata exceeds/)
  assert.throws(() => decodeV4RemoteConfig(padded(config, V4_METADATA_MAX_BYTES.config + 1)), /V4 config metadata exceeds/)
})

test("remote head reader rejects oversized metadata before JSON parsing", async () => {
  const head = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 1, journalId: "j1",
    shardHashes: {}, updatedAt: 1, deviceId: "device" }
  assert.equal((await decodeV4RemoteHead(encoder.encode(JSON.stringify(head)), config)).journalId, "j1")
  await assert.rejects(() => decodeV4RemoteHead(padded(head, V4_METADATA_MAX_BYTES.head + 1), config), /V4 head metadata exceeds/)
})

test("remote shard reader rejects oversized metadata before record parsing", async () => {
  const shard = { bucket: "ab", records: {} }
  assert.deepEqual((await decodeV4RemoteShard(encoder.encode(JSON.stringify(shard)), "ab", config)).records, {})
  await assert.rejects(() => decodeV4RemoteShard(padded(shard, V4_METADATA_MAX_BYTES.shard + 1), "ab", config), /V4 shard metadata exceeds/)
})
