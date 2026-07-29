import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { createV4IncrementalSha256, sha256V4ChunksHex } from "../../src/lib/v4/incremental-hash";

function deterministicBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = 0x12345678;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

async function verify(bytes: Uint8Array, boundaries: number[]): Promise<void> {
  const hasher = createV4IncrementalSha256();
  let offset = 0;
  for (const width of boundaries) {
    if (offset >= bytes.byteLength) break;
    const end = Math.min(bytes.byteLength, offset + width);
    hasher.update(bytes.subarray(offset, end));
    offset = end;
  }
  if (offset < bytes.byteLength) hasher.update(bytes.subarray(offset));
  assert.equal(hasher.digestHex(), await sha256Hex(bytes));
}

test("incremental SHA-256 matches the current whole-buffer hash", async () => {
  await verify(new Uint8Array(), [1]);
  await verify(new Uint8Array([0xab]), [1]);
  await verify(deterministicBytes(1024 * 1024), [1, 3, 7, 64, 1021, 8192, 65537]);
  await verify(deterministicBytes(50 * 1024 * 1024 + 1), [31, 4096, 65536, 1024 * 1024, 3 * 1024 * 1024]);
});

test("incremental SHA helper hashes async chunk streams without concatenating", async () => {
  const bytes = deterministicBytes(2 * 1024 * 1024 + 17);
  async function* chunks() {
    for (let offset = 0; offset < bytes.byteLength; offset += 131071) {
      yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 131071));
    }
  }
  assert.equal(await sha256V4ChunksHex(chunks()), await sha256Hex(bytes));
});
