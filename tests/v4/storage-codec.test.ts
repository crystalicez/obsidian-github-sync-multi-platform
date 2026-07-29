import assert from "node:assert/strict";
import test from "node:test";

import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
import { sha256Hex } from "../../src/lib/bytes";

const bytes = (value: string) => new TextEncoder().encode(value);

test("v4 plaintext codec stores a small file at its unchanged vault path", async () => {
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });
  const prepared = await codec.prepare("Notes/สวัสดี.md", bytes("hello"), "v1", 10);
  assert.equal(prepared.record.remotePath, "Notes/สวัสดี.md");
  assert.equal(prepared.record.storage, "single");
  assert.deepEqual(prepared.files, [{ path: "Notes/สวัสดี.md", bytes: bytes("hello") }]);
  assert.equal(new TextDecoder().decode(await codec.read(prepared.record, async path => prepared.files.find(file => file.path === path)!.bytes)), "hello");
});

test("v4 encrypted codec hides the complete path and keeps one object path across rename", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const before = await codec.prepare("Projects/Secret/note.md", bytes("body"), "v1", 1, "stable-file");
  const after = await codec.prepare("Archive/renamed.txt", bytes("body 2"), "v2", 2, "stable-file");
  assert.equal(before.record.remotePath, after.record.remotePath);
  for (const segment of ["Projects", "Secret", "note", "md", "Archive", "renamed", "txt"]) {
    assert.equal(before.record.remotePath.includes(segment), false);
    assert.equal(after.record.remotePath.includes(segment), false);
  }
  assert.equal(new TextDecoder().decode(await codec.read(after.record, async () => after.files[0].bytes)), "body 2");
});

test("v4 codec parts files above 50 MiB and verifies reassembly", async () => {
  const content = new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1);
  content[0] = 7;
  content[content.length - 1] = 9;
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });
  const prepared = await codec.prepare("large.bin", content, "v3", 30);
  assert.equal(prepared.record.storage, "chunked");
  assert.ok((prepared.record.partPaths?.length ?? 0) > 1);
  const restored = await codec.read(prepared.record, async path => prepared.files.find(file => file.path === path)!.bytes);
  assert.deepEqual(restored, content);
});

test("v4 encrypted part and pack paths contain only protocol coordinates", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const chunked = await codec.prepare("Private/large-secret.md", new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1), "v-large", 1, "large-file");
  const packedInput = await codec.prepare("Folder/secret.md", bytes("secret"), "v-pack", 1, "packed-file");
  const packed = await codec.preparePack("pack-1", [{ record: packedInput.record, plaintext: bytes("secret") }]);
  assert.match(chunked.record.partPaths![0], /^\.obsidian-github-sync-v4\/parts\/[0-9a-f]{2}\/[0-9a-f]{64}\/v-large\/000001\.enc$/u);
  assert.match(packed.file.path, /^\.obsidian-github-sync-v4\/packs\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.doesNotMatch([...chunked.record.partPaths!, packed.file.path].join("\n"), /Private|Folder|secret|\.md/u);
});

test("v4 streamed encrypted parts preserve existing part paths AAD and read compatibility", async () => {
  const partBytes = 4 * 1024 * 1024;
  const logicalBytes = V4_LARGE_FILE_THRESHOLD_BYTES + 1;
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const hash = (await import("../../src/lib/v4/incremental-hash")).createV4IncrementalSha256();
  for (let offset = 0; offset < logicalBytes; offset += partBytes) hash.update(new Uint8Array(Math.min(partBytes, logicalBytes - offset)));
  const source = {
    size: logicalBytes,
    async *chunks() {
      for (let offset = 0; offset < logicalBytes; offset += partBytes) yield new Uint8Array(Math.min(partBytes, logicalBytes - offset));
    },
  };
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const prepared = await codec.prepareFromSource({
    logicalPath: "Private/stream.bin",
    source,
    expectedHash: hash.digestHex(),
    version: "stream-v1",
    mtime: 10,
    fileId: "stream-file",
    partBytes,
  });
  const objects = new Map<string, Uint8Array>();
  for await (const object of prepared.objects()) { objects.set(object.path, new Uint8Array(object.bytes)); object.release?.(); }
  const record = await prepared.finalize();
  assert.equal(record.storage, "chunked");
  assert.deepEqual(record.partPaths, prepared.objectPaths);
  const restored = await codec.read(record, async path => objects.get(path)!);
  assert.equal(restored.byteLength, logicalBytes);
  assert.equal(await sha256Hex(restored), record.plaintextSha256);
});
