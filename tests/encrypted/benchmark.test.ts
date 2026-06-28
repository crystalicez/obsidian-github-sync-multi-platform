import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { compileIgnorePathRegex, isIgnoredPath } from "../../src/lib/encrypted/ignore";
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
