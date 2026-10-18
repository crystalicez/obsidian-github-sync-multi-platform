import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index";

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
