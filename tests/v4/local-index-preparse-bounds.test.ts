import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createEmptyV4LocalIndex, fitsV4LocalJsonSizeLimit, loadV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index";

function adapter() {
  const values = new Map<string, string>();
  return {
    values,
    async read(path: string) { const value = values.get(path); if (value === undefined) throw Error(path); return value; },
    async write(path: string, value: string) { values.set(path, value); },
    async exists(path: string) { return values.has(path); },
    async mkdir() {},
  };
}

test("local JSON byte limiter matches UTF-8 for ASCII, BMP, astral and lone surrogate characters", () => {
  for (const value of ["ASCII", "中", "🙂", "A中🙂", String.fromCharCode(0xd800)]) {
    const encodedBytes = new TextEncoder().encode(value).byteLength;
    assert.equal(fitsV4LocalJsonSizeLimit(value, encodedBytes), true, value);
    assert.equal(fitsV4LocalJsonSizeLimit(value, encodedBytes - 1), false, value);
  }
});

test("overlong valid local index header cannot authorize a cached remote commit", async () => {
  const io = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  cache.remoteCommitSha = "untrusted-remote-commit";
  await saveV4LocalIndex(io, "index", cache);
  const original = JSON.parse(io.values.get("index/index.json")!);
  io.values.set("index/index.json", JSON.stringify({ ...original, extra: "x".repeat(66 * 1024) }));
  const loaded = await loadV4LocalIndex(io, "index");
  assert.equal(loaded.remoteCommitSha, undefined);
  assert.equal(loaded.generation, 0);
});

test("oversized cache header cannot be persisted in an unreadable form", async () => {
  const io = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "x".repeat(66 * 1024), deviceId: "d", mode: "plaintext" });
  await assert.rejects(() => saveV4LocalIndex(io, "index", cache), /cache limit/);
  assert.equal(io.values.has("index/index.json"), false);
});

test("UTF-8 local header write budget matches the adapter byte-size preflight", async () => {
  const io = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "中".repeat(24 * 1024), deviceId: "d", mode: "plaintext" });
  await assert.rejects(() => saveV4LocalIndex(io, "index", cache), /cache limit/);
  assert.equal(io.values.has("index/index.json"), false);
});

test("stale byte-size hint cannot authorize an oversized UTF-8 cache header", async () => {
  const backing = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  await saveV4LocalIndex(backing, "index", cache);
  const header = JSON.parse(backing.values.get("index/index.json")!);
  backing.values.set("index/index.json", JSON.stringify({ ...header, repoId: "中".repeat(23 * 1024) }));
  const io = {
    ...backing,
    async stat() { return { size: 1024 }; },
  };
  const loaded = await loadV4LocalIndex(io, "index");
  assert.equal(loaded.repoId, "");
  assert.equal(loaded.generation, 0);
});

test("non-ASCII shard exceeding the byte cap is rejected even without stat", async () => {
  const io = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  cache.remoteCommitSha = "untrusted-remote-commit";
  const hash = createHash("sha256").update(JSON.stringify([])).digest("hex");
  cache.shardHashes.ab = hash;
  cache.shards.ab = { bucket: "ab", hash, records: {} };
  await saveV4LocalIndex(io, "index", cache);
  io.values.set("index/shards/ab.json", JSON.stringify({ ...cache.shards.ab, extra: "中".repeat(11 * 1024 * 1024) }));
  const loaded = await loadV4LocalIndex(io, "index");
  assert.equal(loaded.remoteCommitSha, undefined);
  assert.deepEqual(loaded.shards, {});
});

test("cache header size from Obsidian stat prevents an oversized adapter read", async () => {
  const backing = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  cache.remoteCommitSha = "stale-head";
  await saveV4LocalIndex(backing, "index", cache);
  let reads = 0;
  const io = {
    ...backing,
    async stat(path: string) { return path === "index/index.json" ? { size: 67 * 1024 } : null; },
    async read(path: string) { reads++; return backing.read(path); },
  };
  const loaded = await loadV4LocalIndex(io, "index");
  assert.equal(loaded.remoteCommitSha, undefined);
  assert.equal(reads, 0);
});

test("overlong valid cached shard is rebuilt rather than trusted", async () => {
  const io = adapter();
  const cache = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  cache.remoteCommitSha = "untrusted-remote-commit";
  const hash = createHash("sha256").update(JSON.stringify([])).digest("hex");
  cache.shardHashes.ab = hash;
  cache.shards.ab = { bucket: "ab", hash, records: {} };
  await saveV4LocalIndex(io, "index", cache);
  io.values.set("index/shards/ab.json", JSON.stringify({ ...cache.shards.ab, extra: "x".repeat(33 * 1024 * 1024) }));
  const loaded = await loadV4LocalIndex(io, "index");
  assert.equal(loaded.remoteCommitSha, undefined);
  assert.deepEqual(loaded.shards, {});
});
