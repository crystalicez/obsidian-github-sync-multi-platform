import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { computeV4GitBlobSha1, assertV4GitBlobIdentity } from "../../src/lib/v4/git-blob-identity";

function oracle(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

test("D71 Git blob identity matches independent Node crypto SHA-1 across block boundaries", () => {
  for (const size of [0, 1, 8, 55, 56, 63, 64, 65, 119, 120, 121, 4096, 64 * 1024 + 1, 8 * 1024 * 1024 + 1]) {
    const bytes = randomBytes(size);
    assert.equal(computeV4GitBlobSha1(bytes), oracle(bytes), `size=${size}`);
    assert.doesNotThrow(() => assertV4GitBlobIdentity(bytes, oracle(bytes)));
  }
});

test("D71 Git identity refuses wrong/missing SHA even when payload bytes are well-formed", () => {
  const bytes = new TextEncoder().encode('{"formatVersion":4,"mode":"encrypted"}');
  const expected = oracle(bytes);
  for (const invalid of ["", "HEAD", "main", "A".repeat(40), "0".repeat(40), "deadbeef", expected.slice(0, -1)]) {
    assert.throws(() => assertV4GitBlobIdentity(bytes, invalid), /blob (identity|SHA)|Git blob/i);
  }
  const mutated = bytes.slice();
  mutated[0] ^= 1;
  assert.throws(() => assertV4GitBlobIdentity(mutated, expected), /blob (identity|SHA)|Git blob/i);
});

test("D71 Git SHA calculation never mutates the caller's ciphertext bytes", () => {
  const source = randomBytes(1025);
  const original = source.slice();
  computeV4GitBlobSha1(source);
  assert.deepEqual(source, original);
});
