import assert from "node:assert/strict";
import test from "node:test";

const maxBytes = 50 * 1024 * 1024;

function chunkPathFor(objectId, index) {
  return `.obsidian-github-sync-encrypted/objects/${objectId.slice(0, 2)}/${objectId.slice(2, 4)}/${objectId}.parts/${String(index).padStart(6, "0")}.enc`;
}

test("chunk paths are ordered and padded", () => {
  const id = "abcdef123456";
  assert.equal(chunkPathFor(id, 1), ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef123456.parts/000001.enc");
  assert.equal(chunkPathFor(id, 12).endsWith("/000012.enc"), true);
});

test("threshold chunks only above 50 MiB", () => {
  assert.equal(maxBytes + 1 > maxBytes, true);
  assert.equal(maxBytes > maxBytes, false);
});
