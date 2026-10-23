import assert from "node:assert/strict";
import test from "node:test";

import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
import { sha256Hex } from "../../src/lib/bytes";

const bytes = (value: string) => new TextEncoder().encode(value);

test("content AES-GCM encryption and plaintext SHA-256 emit independent real work timings", async () => {
  const keys = await deriveV4Keyring({ passphrase: "observed", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const encrypt: number[] = [];
  const hash: number[] = [];
  const codec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys,
    onEncryptionMeasured: ms => encrypt.push(ms),
    onHashingMeasured: ms => hash.push(ms),
  });
  const payload = bytes("content encryption and hashing measurement");
  const prepared = await codec.prepare("Secret/observed.md", payload, "v1", 1, "file-observed");
  assert.equal(encrypt.length, 1, "only real content AES-GCM encrypt is measured, not key or path derivation");
  assert.equal(hash.length, 1, "plaintext SHA-256 runs once while preparing a single object");
  assert.ok(encrypt.every(ms => Number.isFinite(ms) && ms >= 0));
  assert.ok(hash.every(ms => Number.isFinite(ms) && ms >= 0));
  assert.deepEqual(await codec.read(prepared.record, async () => prepared.files[0]!.bytes), payload);
  assert.equal(encrypt.length, 1, "reading encrypted content must not count as encrypting");
  assert.equal(hash.length, 2, "read-side plaintext SHA-256 verification is also real hashing");
  const observerFailure = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys,
    onEncryptionMeasured: () => { throw new Error("observer failed"); },
    onHashingMeasured: () => { throw new Error("observer failed"); },
  });
  const safe = await observerFailure.prepare("Secret/safe.md", payload, "v2", 2, "file-safe");
  assert.deepEqual(await observerFailure.read(safe.record, async () => safe.files[0]!.bytes), payload);
});

test("plaintext content hashes are measured without synthetic encryption samples", async () => {
  const encrypt: number[] = [];
  const hash: number[] = [];
  const codec = new V4StorageCodec({
    mode: "plaintext", pathLayout: "plaintext-v1",
    onEncryptionMeasured: ms => encrypt.push(ms), onHashingMeasured: ms => hash.push(ms),
  });
  const file = await codec.prepare("Notes/plain.md", bytes("public"), "v1", 1);
  assert.deepEqual(await codec.read(file.record, async () => file.files[0]!.bytes), bytes("public"));
  assert.equal(encrypt.length, 0);
  assert.equal(hash.length, 2);
});

test("encrypted codec measures actual decryption work, including failed authentication, without changing bytes", async () => {
  const keys = await deriveV4Keyring({ passphrase: "timing-only", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const samples: number[] = [];
  const codec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys,
    onDecryptionMeasured: milliseconds => samples.push(milliseconds),
  });
  const prepared = await codec.prepare("Notes/measured.md", bytes("unchanged secret"), "v1", 1, "measured-file");
  const restored = await codec.read(prepared.record, async () => prepared.files[0]!.bytes);
  assert.deepEqual(restored, bytes("unchanged secret"));
  assert.equal(samples.length, 1);
  assert.ok(Number.isFinite(samples[0]) && samples[0]! >= 0);
  const corrupted = new Uint8Array(prepared.files[0]!.bytes);
  corrupted[corrupted.byteLength - 1] ^= 1;
  await assert.rejects(() => codec.read(prepared.record, async () => corrupted));
  assert.equal(samples.length, 2, "failed authentication must not hide attempted decryption work");
  assert.ok(samples.every(value => Number.isFinite(value) && value >= 0));
  const observerFailure = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys,
    onDecryptionMeasured: () => { throw new Error("telemetry callback unavailable"); },
  });
  assert.deepEqual(await observerFailure.read(prepared.record, async () => prepared.files[0]!.bytes), bytes("unchanged secret"));
});

test("new encrypted packs exceeding the previously verified REST-safe payload cap fail before upload", async () => {
  const keyring = await deriveV4Keyring({ passphrase: "pack-cap", repoId: "o/r#main", salt: bytes("pack-salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const sample = await codec.prepare("Notes/record.md", bytes("small"), "v1", 1, "file-pack-cap");
  const large = new Uint8Array(7 * 1024 * 1024);
  await assert.rejects(() => codec.preparePack("pack-cap", [{ record: sample.record, plaintext: large }]), /REST-safe 8 MiB/iu);
  let opened = false;
  await assert.rejects(() => codec.preparePackFromSources("pack-cap", [{
    logicalPath: "Notes/record.md", fileId: "file-pack-cap",
    source: { size: large.byteLength, async *chunks() { opened = true; yield large; } },
    expectedHash: "0".repeat(64), expectedSize: large.byteLength,
    version: "v1", mtime: 1,
  }]), /REST-safe 8 MiB/iu);
  assert.equal(opened, false, "oversized pack should fail before opening sources");
});

test("plaintext codec emits no decryption timing", async () => {
  let measured = 0;
  const codec = new V4StorageCodec({
    mode: "plaintext", pathLayout: "plaintext-v1", onDecryptionMeasured: () => { measured++; },
  });
  const prepared = await codec.prepare("Notes/plain.md", bytes("public"), "v1", 1);
  assert.deepEqual(await codec.read(prepared.record, async () => prepared.files[0]!.bytes), bytes("public"));
  assert.equal(measured, 0);
});

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

test("v4 rejects duplicate encrypted-pack file IDs before producing an ambiguous archive", async () => {
  const { createV4WholeBufferContentSource } = await import("../../src/lib/v4/content-source");
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const first = await codec.prepare("Folder/a.md", bytes("first"), "v1", 1, "repeated-id");
  const second = await codec.prepare("Folder/b.md", bytes("second"), "v1", 1, "repeated-id");

  await assert.rejects(
    () => codec.preparePack("duplicate-in-memory", [
      { record: first.record, plaintext: bytes("first") },
      { record: second.record, plaintext: bytes("second") },
    ]),
    /duplicate.*file.?id/i,
  );
  await assert.rejects(
    async () => codec.preparePackFromSources("duplicate-streamed", [
      { logicalPath: "Folder/a.md", fileId: "repeated-id", source: createV4WholeBufferContentSource(bytes("first")),
        expectedHash: await sha256Hex(bytes("first")), version: "v1", mtime: 1 },
      { logicalPath: "Folder/b.md", fileId: "repeated-id", source: createV4WholeBufferContentSource(bytes("second")),
        expectedHash: await sha256Hex(bytes("second")), version: "v1", mtime: 1 },
    ]),
    /duplicate.*file.?id/i,
  );
});

test("v4 source-built pack preserves version-1 archive and existing read compatibility", async () => {
  const { decryptV4Payload } = await import("../../src/lib/v4/crypto");
  const { bytesToUtf8, fromBase64, sha256Hex } = await import("../../src/lib/bytes");
  const { createV4WholeBufferContentSource } = await import("../../src/lib/v4/content-source");
  const plaintext = bytes("source-pack-secret");
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const packed = await codec.preparePackFromSources("source-pack", [{
    logicalPath: "Folder/source.md",
    fileId: "source-pack-file",
    source: createV4WholeBufferContentSource(plaintext),
    expectedHash: await sha256Hex(plaintext),
    version: "source-pack-v1",
    mtime: 3,
  }]);

  const archiveBytes = await decryptV4Payload(keys.contentKey, packed.file.bytes, { kind: "pack", aad: "source-pack" });
  const archive = JSON.parse(bytesToUtf8(archiveBytes));
  assert.equal(archive.version, 1);
  assert.deepEqual(fromBase64(archive.entries["source-pack-file"]), plaintext);
  assert.deepEqual(await codec.read(packed.records[0], async () => packed.file.bytes), plaintext);
});


test("v4 streamed sink size mismatch identifies the remote object without requiring a logical path", async () => {
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });
  const record = {
    pathId: "pid",
    fileId: "fid",
    plaintextSha256: "",
    size: 1,
    mtime: 1,
    remoteVersion: "v1",
    remotePath: ".obsidian-github-sync-v4/objects/opaque.bin",
    storage: "single" as const,
  };
  const sink = { append: async () => {}, finish: async () => { throw new Error("unexpected finish") }, abort: async () => {} };
  await assert.rejects(
    () => codec.readToSink({ record, reader: async () => new Uint8Array([1, 2]), sink }),
    /V4 content size mismatch: \.obsidian-github-sync-v4\/objects\/opaque\.bin/u,
  );
});
