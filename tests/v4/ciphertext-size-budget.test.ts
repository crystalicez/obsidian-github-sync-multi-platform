import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes";
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source";
import { deriveV4Keyring, V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } from "../../src/lib/v4/crypto";
import { V4_GITHUB_REST_SAFE_WRITER_BYTES, shouldWriteV4Parts } from "../../src/lib/v4/large-files";
import { selectV4WriterPartBytes } from "../../src/lib/v4/part-write-policy";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const max = V4_GITHUB_REST_SAFE_WRITER_BYTES;
const maxPlaintextEncrypted = max - V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
async function codec() {
  const keyring = await deriveV4Keyring({
    passphrase: "d77-budget", repoId: "owner/repo#branch", salt: utf8ToBytes("d77-salt"), iterations: 10,
  });
  return new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
}

test("D77 uses ciphertext-aware threshold while leaving plaintext legacy behavior unchanged", () => {
  assert.equal(V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES, 33);
  for (const size of [0, maxPlaintextEncrypted - 1, maxPlaintextEncrypted, maxPlaintextEncrypted + 1, max, max + 1]) {
    assert.equal(shouldWriteV4Parts(size), size > max, "legacy plaintext callers retain their behavior");
    assert.equal(shouldWriteV4Parts(size, "plaintext"), size > max);
    assert.equal(shouldWriteV4Parts(size, "encrypted"), size > maxPlaintextEncrypted);
  }
});

test("D77 whole-buffer encrypted prepare never emits blobs above 8 MiB at either side of boundary", async () => {
  const c = await codec();
  for (const size of [maxPlaintextEncrypted - 1, maxPlaintextEncrypted, maxPlaintextEncrypted + 1, max, max + 1]) {
    const source = new Uint8Array(size);
    source[0] = 5; source[size - 1] = 9;
    const prepared = await c.prepare("boundary.bin", source, "v1", size, "file-boundary");
    const expectedChunked = size > maxPlaintextEncrypted;
    assert.equal(prepared.record.storage, expectedChunked ? "chunked" : "single", String(size));
    assert.ok(prepared.files.length >= (expectedChunked ? 2 : 1));
    assert.ok(prepared.files.every(file => file.bytes.byteLength <= max), String(size));
    const restored = await c.read(prepared.record, async path => prepared.files.find(file => file.path === path)!.bytes);
    assert.deepEqual(restored, source);
  }
});

test("D77 streamed prepare clips requested part bytes and validates complete data before finalize", async () => {
  const c = await codec();
  for (const size of [maxPlaintextEncrypted, maxPlaintextEncrypted + 1, max, max + 1]) {
    const source = new Uint8Array(size).fill(0x42);
    const prepared = await c.prepareFromSource({
      logicalPath: "streamed.bin",
      source: createV4WholeBufferContentSource(source),
      expectedHash: await sha256Hex(source), version: "v2", mtime: 2, fileId: "stream-boundary",
      partBytes: max, // Existing callers may request the historical 8 MiB raw budget.
    });
    const output = new Map<string, Uint8Array>();
    for await (const object of prepared.objects()) {
      assert.ok(object.bytes.length <= max, `size=${size}, remote=${object.bytes.length}`);
      output.set(object.path, object.bytes);
      object.release?.();
    }
    const record = await prepared.finalize();
    assert.equal(record.storage, size > maxPlaintextEncrypted ? "chunked" : "single");
    assert.deepEqual(await c.read(record, async path => output.get(path)!), source);
  }
});

test("D77 encrypted transport part selection stays within ciphertext and mutation caps", () => {
  const selected = selectV4WriterPartBytes({
    logicalBytes: 100_000_000, maxTransportTransientBytes: 256 * 1024 * 1024,
    mode: "encrypted",
  });
  assert.ok(selected > 1024 * 1024);
  assert.ok(selected + V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES <= max);
  assert.equal(Math.ceil(100_000_000 / selected) <= 400, true);
  assert.equal(selectV4WriterPartBytes({
    logicalBytes: 100_000_000, maxTransportTransientBytes: 256 * 1024 * 1024,
    mode: "plaintext",
  }), max);
});
