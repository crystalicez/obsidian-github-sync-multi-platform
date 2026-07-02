import assert from "node:assert/strict";
import test from "node:test";

import { decryptV3BinaryPayload, encryptV3BinaryPayload } from "../../src/lib/encrypted-v3/binary-format";
import { coalesceV3Changes, type EncryptedV3QueuedChange } from "../../src/lib/encrypted-v3/change-batcher";
import { deriveEncryptedV3Keyring, fingerprintEncryptedV3Keyring } from "../../src/lib/encrypted-v3/keyring";
import { createEmptyV3LocalIndex, loadV3LocalIndex, saveV3LocalIndexShard } from "../../src/lib/encrypted-v3/local-index";
import { bucketForV3PathId, createV3PathId, normalizeV3VaultPath } from "../../src/lib/encrypted-v3/paths";

test("v3 path ids hide plaintext path and map to a stable shard bucket", async () => {
  const key = new TextEncoder().encode("path-key-for-test");
  const path = normalizeV3VaultPath("\\Secret Folder\\Note.md");

  const first = await createV3PathId(key, path);
  const second = await createV3PathId(key, "Secret Folder/Note.md");

  assert.equal(path, "Secret Folder/Note.md");
  assert.equal(first, second);
  assert.equal(first.includes("Secret"), false);
  assert.match(bucketForV3PathId(first), /^[0-9a-f]{2}$/u);
});

test("v3 keyring derives stable isolated subkeys per repo", async () => {
  const salt = new TextEncoder().encode("salt");
  const first = await deriveEncryptedV3Keyring({ passphrase: "secret", repoId: "repo-a", salt });
  const second = await deriveEncryptedV3Keyring({ passphrase: "secret", repoId: "repo-a", salt });
  const otherRepo = await deriveEncryptedV3Keyring({ passphrase: "secret", repoId: "repo-b", salt });

  assert.equal(await fingerprintEncryptedV3Keyring(first), await fingerprintEncryptedV3Keyring(second));
  assert.notDeepEqual(first.pathKey, first.contentKey);
  assert.notDeepEqual(first.pathKey, otherRepo.pathKey);
});

test("v3 binary payload round trips bytes and rejects the wrong key", async () => {
  const plaintext = new TextEncoder().encode("hello encrypted v3");
  const key = new TextEncoder().encode("content-key");
  const wrongKey = new TextEncoder().encode("wrong-key");

  const encrypted = await encryptV3BinaryPayload(key, plaintext, {
    aad: "repo:file:1",
    kind: "object",
  });
  const decrypted = await decryptV3BinaryPayload(key, encrypted, "repo:file:1");

  assert.deepEqual(decrypted, plaintext);
  assert.equal(new TextDecoder().decode(encrypted).includes("hello"), false);
  await assert.rejects(() => decryptV3BinaryPayload(wrongKey, encrypted, "repo:file:1"));
});

test("v3 local index persists only the changed shard", async () => {
  const writes = new Map<string, string>();
  const adapter = {
    async read(path: string) {
      const value = writes.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async write(path: string, data: string) {
      writes.set(path, data);
    },
    async exists(path: string) {
      return writes.has(path);
    },
    async mkdir(_path: string) {},
  };
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.shards["ab"] = {
    hash: "hash-ab",
    records: {
      pathid: {
        path: "Notes/a.md",
        pathId: "ab1234",
        fileId: "file-a",
        plaintextSha256: "sha",
        size: 1,
        mtime: 2,
        remoteVersion: "v1",
      },
    },
  };

  await saveV3LocalIndexShard(adapter, ".v3-index", index, "ab");
  const loaded = await loadV3LocalIndex(adapter, ".v3-index");

  assert.deepEqual([...writes.keys()].sort(), [".v3-index/index.json", ".v3-index/shards/ab.json"]);
  assert.equal(loaded.shards["ab"].records.pathid.path, "Notes/a.md");
});

test("v3 change batcher collapses typing, rename chains, and delete after modify", () => {
  const changes: EncryptedV3QueuedChange[] = [
    { type: "modify", path: "Notes/live.md", mtime: 1 },
    { type: "modify", path: "Notes/live.md", mtime: 2 },
    { type: "rename", oldPath: "Notes/a.md", path: "Notes/b.md", mtime: 3 },
    { type: "rename", oldPath: "Notes/b.md", path: "Notes/c.md", mtime: 4 },
    { type: "modify", path: "Notes/delete.md", mtime: 5 },
    { type: "delete", path: "Notes/delete.md", mtime: 6 },
  ];

  assert.deepEqual(coalesceV3Changes(changes), [
    { type: "modify", path: "Notes/live.md", mtime: 2 },
    { type: "rename", oldPath: "Notes/a.md", path: "Notes/c.md", mtime: 4 },
    { type: "delete", path: "Notes/delete.md", mtime: 6 },
  ]);
});
