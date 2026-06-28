import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { compileIgnorePathRegex, isIgnoredPath } from "../../src/lib/encrypted/ignore";
import { toBase64Url, toHex } from "../../src/lib/encrypted/bytes";
import { chunkPathForId } from "../../src/lib/encrypted/large-objects";

test("benchmark: ignore regex matching remains comfortably fast", () => {
  const rules = compileIgnorePathRegex(Array.from({ length: 500 }, (_, index) => `^Folder${index}/`).join("\n"));
  const start = performance.now();
  for (let i = 0; i < 5000; i++) isIgnoredPath(`Folder${i % 500}/note.md`, rules);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `ignore regex benchmark took ${elapsed}ms`);
});

test("benchmark: chunk path generation remains comfortably fast", () => {
  const start = performance.now();
  for (let i = 0; i < 10000; i++) chunkPathForId("abcdef1234567890", i + 1);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `chunk path benchmark took ${elapsed}ms`);
});

test("benchmark: byte encoding remains fast for 1 MiB payloads", () => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i & 0xff;

  const base64Start = performance.now();
  const encoded = toBase64Url(bytes);
  const base64Elapsed = performance.now() - base64Start;
  assert.equal(encoded.length, 1398102);
  assert.ok(base64Elapsed < 35, `base64url encoding benchmark took ${base64Elapsed}ms`);

  const hexStart = performance.now();
  const hex = toHex(bytes);
  const hexElapsed = performance.now() - hexStart;
  assert.equal(hex.length, 2 * bytes.byteLength);
  assert.ok(hexElapsed < 45, `hex encoding benchmark took ${hexElapsed}ms`);
});
