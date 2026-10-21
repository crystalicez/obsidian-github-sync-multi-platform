import assert from "node:assert/strict"
import test from "node:test"

import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto"
import { assertV4MetadataBytes, V4_METADATA_MAX_BYTES } from "../../src/lib/v4/metadata-bounds"
import { decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, encodeV4RemoteConfig } from "../../src/lib/v4/remote-index"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"

const enc = new TextEncoder()
const repoId = "owner/repo#non-default"
const plain: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId, pathLayout: "plaintext-v1" }

function padded(value: unknown, byteLength: number): Uint8Array {
  const bytes = enc.encode(JSON.stringify(value))
  assert.ok(bytes.length < byteLength)
  const result = new Uint8Array(byteLength).fill(0x20)
  result.set(bytes)
  return result
}

test("remote config size rejects oversized valid JSON during encode and before parse", () => {
  assert.deepEqual(decodeV4RemoteConfig(encodeV4RemoteConfig(plain)), plain)
  assert.throws(() => encodeV4RemoteConfig({ ...plain, repoId: "x".repeat(64 * 1024) }), /V4 config metadata exceeds/)
  assert.throws(() => decodeV4RemoteConfig(padded(plain, 64 * 1024 + 1)), /V4 config metadata exceeds/)
})

test("remote head is byte bounded before parsing, with existing layout unchanged", async () => {
  const head = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 1, journalId: "j1", shardHashes: {}, updatedAt: 1, deviceId: "d1" }
  assert.equal((await decodeV4RemoteHead(enc.encode(JSON.stringify(head)), plain)).journalId, "j1")
  await assert.rejects(() => decodeV4RemoteHead(padded(head, 256 * 1024 + 1), plain), /V4 head metadata exceeds/)
})

test("remote shard is rejected before parsing oversized valid JSON", async () => {
  const shard = { bucket: "ab", records: {} }
  assert.deepEqual((await decodeV4RemoteShard(enc.encode(JSON.stringify(shard)), "ab", plain)).records, {})
  await assert.rejects(() => decodeV4RemoteShard(padded(shard, 16 * 1024 * 1024 + 1), "ab", plain), /V4 shard metadata exceeds/)
})

test("encrypted metadata checks wire framing overhead before AEAD and still accepts authenticated bytes", async () => {
  const salt = enc.encode("salt")
  const keys = await deriveV4Keyring({ passphrase: "test", repoId, salt, iterations: 10 })
  const config: V4RemoteConfig = { ...plain, mode: "encrypted", pathLayout: "opaque-stable-v1" }
  const head = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "j1", shardHashes: {}, updatedAt: 1, deviceId: "d1" }
  const bytes = await encryptV4Payload(keys.indexKey, enc.encode(JSON.stringify(head)), { kind: "head", aad: repoId })
  assert.equal((await decodeV4RemoteHead(bytes, config, keys)).journalId, "j1")
  const oversize = new Uint8Array(V4_METADATA_MAX_BYTES.head + 34)
  assert.throws(() => assertV4MetadataBytes(oversize, "head", true), /V4 head metadata exceeds/)
  await assert.rejects(() => decodeV4RemoteHead(oversize, config, keys), /V4 head metadata exceeds/)
})
