import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index";

function addShard(index: ReturnType<typeof createEmptyV4LocalIndex>, bucket: string, version: string) {
  const pathId = `${bucket}${"0".repeat(62)}`;
  const shard = {
    hash: `hash-${version}-${bucket}`,
    records: {
      [pathId]: {
        path: `Notes/${bucket}.md`, pathId, fileId: `file-${bucket}`, plaintextSha256: `sha-${version}`, size: 1, mtime: 2,
        remoteVersion: version, remotePath: `.obsidian-github-sync-v4/data/${bucket}/${pathId}.enc`, storage: "single" as const,
      },
    },
  };
  index.shards[bucket] = shard;
  index.shardHashes[bucket] = shard.hash;
}

test("v4 local index writes all changed shards before one final header", async () => {
  const stored = new Map<string, string>();
  const writeOrder: string[] = [];
  const adapter = {
    async read(path: string) {
      const value = stored.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: string) { writeOrder.push(path); stored.set(path, value); },
    async exists(path: string) { return stored.has(path); },
    async mkdir(_path: string) {},
  };
  const index = createEmptyV4LocalIndex({ repoId: "owner/repo#main", deviceId: "device-a", mode: "encrypted" });
  index.remoteCommitSha = "final-commit";
  index.generation = 2;
  addShard(index, "ab", "v2");
  addShard(index, "cd", "v2");

  await saveV4LocalIndex(adapter, ".v4-index", index);
  const loaded = await loadV4LocalIndex(adapter, ".v4-index");

  assert.deepEqual(writeOrder, [".v4-index/shards/ab.json", ".v4-index/shards/cd.json", ".v4-index/index.json"]);
  assert.equal(writeOrder.filter(path => path.endsWith("/index.json")).length, 1);
  assert.equal(loaded.remoteCommitSha, "final-commit");
  assert.equal(loaded.shards.ab.hash, "hash-v2-ab");
  assert.equal(loaded.shards.cd.hash, "hash-v2-cd");
});

test("v4 local index shard failure preserves the previous header and reload state", async () => {
  const stored = new Map<string, string>();
  const writeOrder: string[] = [];
  let failPath: string | undefined;
  const adapter = {
    async read(path: string) {
      const value = stored.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: string) {
      writeOrder.push(path);
      if (path === failPath) throw new Error("second shard write failed");
      stored.set(path, value);
    },
    async exists(path: string) { return stored.has(path); },
    async mkdir(_path: string) {},
  };
  const previous = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  previous.remoteCommitSha = "previous-commit";
  previous.epoch = 1;
  previous.generation = 1;
  addShard(previous, "ab", "v1");
  addShard(previous, "cd", "v1");
  await saveV4LocalIndex(adapter, "index", previous);
  const previousHeader = stored.get("index/index.json")!;

  const final = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  final.remoteCommitSha = "published-commit";
  final.epoch = 1;
  final.generation = 2;
  addShard(final, "ab", "v2");
  addShard(final, "cd", "v2");
  writeOrder.length = 0;
  failPath = "index/shards/cd.json";

  await assert.rejects(() => saveV4LocalIndex(adapter, "index", final, previous.shardHashes), /second shard write failed/iu);

  assert.deepEqual(writeOrder, ["index/shards/ab.json", "index/shards/cd.json"]);
  assert.equal(stored.get("index/index.json"), previousHeader);
  const reloaded = await loadV4LocalIndex(adapter, "index");
  assert.equal(reloaded.remoteCommitSha, "previous-commit");
  assert.equal(reloaded.generation, 1);
  assert.deepEqual(reloaded.shardHashes, previous.shardHashes);
  assert.notEqual(reloaded.remoteCommitSha, final.remoteCommitSha);
});

test("v4 local index writes changed header metadata once when no shards changed", async () => {
  const writeOrder: string[] = [];
  const stored = new Map<string, string>();
  const adapter = {
    async read(path: string) { return stored.get(path)!; },
    async write(path: string, value: string) { writeOrder.push(path); stored.set(path, value); },
    async exists(path: string) { return stored.has(path); },
    async mkdir(_path: string) {},
  };
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext", pathLayout: "plaintext-v1" });
  index.remoteCommitSha = "metadata-only";
  index.generation = 3;

  await saveV4LocalIndex(adapter, "index", index, {});

  assert.deepEqual(writeOrder, ["index/index.json"]);
  assert.equal((await loadV4LocalIndex(adapter, "index")).remoteCommitSha, "metadata-only");
});

test("v4 local index persists the selected path layout", async () => {
  const writes = new Map<string, string>();
  const adapter = {
    async read(path: string) {
      const value = writes.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async write(path: string, value: string) { writes.set(path, value); },
    async exists(path: string) { return writes.has(path); },
    async mkdir(_path: string) {},
  };
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });

  await saveV4LocalIndex(adapter, "index", index);

  assert.equal((await loadV4LocalIndex(adapter, "index")).pathLayout, "opaque-stable-v1");
});
