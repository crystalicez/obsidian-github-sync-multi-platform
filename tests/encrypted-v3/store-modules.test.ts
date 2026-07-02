import assert from "node:assert/strict";
import test from "node:test";

import { decryptV3BinaryPayload } from "../../src/lib/encrypted-v3/binary-format";
import { createEmptyV3LocalIndex } from "../../src/lib/encrypted-v3/local-index";
import { encryptedV3ObjectPath, encryptV3LooseObject } from "../../src/lib/encrypted-v3/object-store";
import { ENCRYPTED_V3_HEAD_PATH, ENCRYPTED_V3_ROOT } from "../../src/lib/encrypted-v3/protocol-types";
import { encryptV3LocalShard, encryptV3Path } from "../../src/lib/encrypted-v3/shard-store";

test("v3 object store encrypts loose objects under opaque non-plaintext paths", async () => {
  const keyMaterial = new TextEncoder().encode("key");
  const object = await encryptV3LooseObject({
    keyMaterial,
    repoId: "repo",
    objectId: "abcdef123456",
    plaintext: new TextEncoder().encode("private bytes"),
  });

  assert.equal(object.path, encryptedV3ObjectPath("abcdef123456"));
  assert.equal(object.path.includes("private"), false);
  assert.deepEqual(await decryptV3BinaryPayload(keyMaterial, object.bytes, "repo:abcdef123456"), new TextEncoder().encode("private bytes"));
});

test("v3 protocol constants use the dedicated v3 root", () => {
  assert.equal(ENCRYPTED_V3_ROOT, ".obsidian-github-sync-v3");
  assert.equal(ENCRYPTED_V3_HEAD_PATH, ".obsidian-github-sync-v3/head.enc");
});

test("v3 shard store encrypts records without plaintext paths in remote bytes", async () => {
  const keyMaterial = new TextEncoder().encode("key");
  const encryptedPath = await encryptV3Path({ keyMaterial, repoId: "repo", pathId: "ab".padEnd(64, "0"), path: "Secret/a.md" });
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.shards.ab = {
    hash: "",
    records: {
      ["ab".padEnd(64, "0")]: {
        path: "Secret/a.md",
        pathId: "ab".padEnd(64, "0"),
        fileId: "abcdef123456",
        plaintextSha256: "sha",
        size: 1,
        mtime: 1,
        remoteVersion: "v1",
      },
    },
  };

  const shard = await encryptV3LocalShard({ keyMaterial, repoId: "repo", deviceId: "device", bucket: "ab", shard: index.shards.ab });

  assert.equal(encryptedPath.includes("Secret"), false);
  assert.equal(new TextDecoder().decode(shard.bytes).includes("Secret/a.md"), false);
  assert.equal(shard.path, ".obsidian-github-sync-v3/shards/ab.enc");
  assert.match(shard.hash, /^[0-9a-f]{64}$/u);
});
