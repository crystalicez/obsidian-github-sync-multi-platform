import assert from "node:assert/strict";
import test from "node:test";

import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";

const bytes = (value: string) => new TextEncoder().encode(value);

test("v4 plaintext codec stores a small file at its unchanged vault path", async () => {
  const codec = new V4StorageCodec({ mode: "plaintext" });
  const prepared = await codec.prepare("Notes/สวัสดี.md", bytes("hello"), "v1", 10);
  assert.equal(prepared.record.remotePath, "Notes/สวัสดี.md");
  assert.equal(prepared.record.storage, "single");
  assert.deepEqual(prepared.files, [{ path: "Notes/สวัสดี.md", bytes: bytes("hello") }]);
  assert.equal(new TextDecoder().decode(await codec.read(prepared.record, async path => prepared.files.find(file => file.path === path)!.bytes)), "hello");
});

test("v4 encrypted codec preserves folders while hiding basename and content", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", keyring: keys });
  const prepared = await codec.prepare("Notes/secret-name.md", bytes("secret body"), "v2", 20);
  assert.match(prepared.record.remotePath, /^\.obsidian-github-sync-v4\/data\/Notes\//u);
  assert.doesNotMatch(prepared.record.remotePath, /secret-name/u);
  assert.equal(new TextDecoder().decode(prepared.files[0].bytes).includes("secret body"), false);
  assert.equal(new TextDecoder().decode(await codec.read(prepared.record, async () => prepared.files[0].bytes)), "secret body");
});

test("v4 codec parts files above 50 MiB and verifies reassembly", async () => {
  const content = new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1);
  content[0] = 7;
  content[content.length - 1] = 9;
  const codec = new V4StorageCodec({ mode: "plaintext" });
  const prepared = await codec.prepare("large.bin", content, "v3", 30);
  assert.equal(prepared.record.storage, "chunked");
  assert.ok((prepared.record.partPaths?.length ?? 0) > 1);
  const restored = await codec.read(prepared.record, async path => prepared.files.find(file => file.path === path)!.bytes);
  assert.deepEqual(restored, content);
});

test("v4 encrypted codec packs many small files without leaking their names or content", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", keyring: keys });
  const prepared = await Promise.all([
    codec.prepare("Folder/private-a.md", bytes("alpha secret"), "v4", 1, "a"),
    codec.prepare("Folder/private-b.md", bytes("beta secret"), "v4", 1, "b"),
  ]);
  const packed = await codec.preparePack("Folder", "pack-1", prepared.map((item, index) => ({ record: item.record, plaintext: bytes(index ? "beta secret" : "alpha secret") })));
  assert.equal(packed.records.every(record => record.storage === "pack"), true);
  assert.equal(new TextDecoder().decode(packed.file.bytes).includes("secret"), false);
  assert.equal(new TextDecoder().decode(await codec.read(packed.records[1], async () => packed.file.bytes)), "beta secret");
});
