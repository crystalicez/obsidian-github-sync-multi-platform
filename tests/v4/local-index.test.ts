import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndexShard } from "../../src/lib/v4/local-index";

test("v4 local index persists only the header and changed shard", async () => {
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
  const index = createEmptyV4LocalIndex({ repoId: "owner/repo#main", deviceId: "device-a", mode: "encrypted" });
  index.shards.ab = {
    hash: "hash-ab",
    records: {
      pathid: {
        path: "Notes/a.md",
        pathId: "ab".padEnd(64, "0"),
        fileId: "file-a",
        plaintextSha256: "sha",
        size: 1,
        mtime: 2,
        remoteVersion: "v1",
        remotePath: ".obsidian-github-sync-v4/data/Notes/token.enc",
        storage: "single",
      },
    },
  };

  await saveV4LocalIndexShard(adapter, ".v4-index", index, "ab");
  const loaded = await loadV4LocalIndex(adapter, ".v4-index");

  assert.deepEqual([...writes.keys()].sort(), [".v4-index/index.json", ".v4-index/shards/ab.json"]);
  assert.equal(loaded.mode, "encrypted");
  assert.equal(loaded.shards.ab.records.pathid.path, "Notes/a.md");
});
