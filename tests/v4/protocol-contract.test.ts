import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { shouldUseV4Parts, shouldWriteV4Parts, splitV4Parts, V4_LARGE_FILE_THRESHOLD_BYTES, V4_PART_BYTES, buildV4PartPaths } from "../../src/lib/v4/large-files";
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "../../src/lib/v4/part-write-policy";
import { assertV4RemoteRecordDescriptor } from "../../src/lib/v4/remote-index";
import type { V4FileRecord } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const bytes = (value: string) => new TextEncoder().encode(value);

test("v4 chunk threshold includes predicted encrypted overhead without changing the 50 MiB boundary", () => {
  const threshold = V4_LARGE_FILE_THRESHOLD_BYTES;
  assert.equal(shouldUseV4Parts(threshold, threshold), false);
  assert.equal(shouldUseV4Parts(threshold + 1, threshold + 1), true);
  assert.equal(shouldUseV4Parts(threshold - 16, threshold - 16 + 33), true);
  assert.equal(shouldUseV4Parts(threshold - 34, threshold - 34 + 33), false);
});


test("new V4 writer splits 8/16/32/50/100 MB safely while legacy 50 MiB single read rules are retained", async () => {
  const writerPart = V4_GITHUB_REST_SAFE_WRITER_BYTES;
  assert.equal(writerPart, 8 * 1024 * 1024);
  assert.equal(V4_PART_BYTES, 48 * 1024 * 1024, "legacy readers still support 48 MiB parts");
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });
  for (const size of [8 * 1024 * 1024, 16_000_000, 32_000_000, 50_000_000, 100_000_000]) {
    const chunked = size > writerPart;
    assert.equal(shouldWriteV4Parts(size), chunked, `new writer policy at ${size}`);
    assert.equal(shouldUseV4Parts(size), false === (size <= V4_LARGE_FILE_THRESHOLD_BYTES));
    const prepared = await codec.prepareFromSource({
      logicalPath: "fixture.bin",
      source: { size, async *chunks() { throw new Error("Planning must remain lazy") } },
      expectedHash: "a".repeat(64),
      version: "v1",
      mtime: 1,
      fileId: "fixture",
      partBytes: writerPart,
    });
    assert.equal(prepared.objectCount, chunked ? Math.ceil(size / writerPart) : 1, `objects for ${size}`);
    const sample = await codec.prepare("fixture.bin", bytes("small"), "v1", 1, "fixture");
    const record = {
      ...sample.record, path: "fixture.bin", size,
      storage: chunked ? "chunked" as const : "single" as const,
      remotePath: prepared.objectPaths[0],
      partPaths: chunked ? [...prepared.objectPaths] : undefined,
    };
    assertV4RemoteRecordDescriptor(record, { formatVersion: 4, mode: "plaintext", repoId: "o/r#main" });
  }
});

test("old single blobs up to 50 MiB and old 48 MiB chunk descriptors remain accepted", async () => {
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });
  const sample = await codec.prepare("archive.bin", bytes("small"), "v1", 1);
  const config = { formatVersion: 4 as const, mode: "plaintext" as const, repoId: "o/r#main" };
  for (const size of [16_000_000, 32_000_000, 50_000_000, V4_LARGE_FILE_THRESHOLD_BYTES]) {
    assertV4RemoteRecordDescriptor({ ...sample.record, path: "archive.bin", size, storage: "single", partPaths: undefined }, config);
  }
  const legacySize = V4_PART_BYTES + 2_000_000;
  const parts = buildV4PartPaths({ mode: "plaintext", logicalPath: "archive.bin", version: "v1", partCount: 2 });
  assertV4RemoteRecordDescriptor({ ...sample.record, path: "archive.bin", size: legacySize, storage: "chunked",
    remotePath: parts[0], partPaths: parts }, config);
});

test("v4 chunk reader accepts valid variable-size parts and verifies the full logical hash", async () => {
  const content = new Uint8Array(9 * 1024 * 1024 + 3);
  for (let offset = 0; offset < content.length; offset += 4093) content[offset] = (offset / 4093) & 0xff;
  content[content.length - 1] = 0xa5;

  const parts = splitV4Parts(content, 2 * 1024 * 1024);
  const partPaths = parts.map((_, index) => `.obsidian-github-sync-v4/large/variable/v1/${String(index + 1).padStart(6, "0")}.part`);
  const record: V4FileRecord = {
    pathId: "path-variable",
    fileId: "file-variable",
    plaintextSha256: await sha256Hex(content),
    size: content.byteLength,
    mtime: 1,
    remoteVersion: "v1",
    remotePath: partPaths[0],
    storage: "chunked",
    partPaths,
  };
  const remote = new Map(partPaths.map((path, index) => [path, parts[index]]));
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" });

  assert.ok(parts.length > 4);
  assert.deepEqual(await codec.read(record, async path => remote.get(path)!), content);
});

test("v4 opaque-stable chunk authentication binds file identity, version, and part order", async () => {
  const keys = await deriveV4Keyring({ passphrase: "contract", repoId: "owner/repo#main", salt: bytes("contract-salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const plaintextParts = [bytes("part-zero"), bytes("part-one")];
  const partPaths = ["part-0.enc", "part-1.enc"];
  const fileId = "stable-file";
  const version = "journal-contract";
  const encryptedParts = await Promise.all(plaintextParts.map((part, index) => encryptV4Payload(keys.contentKey, part, {
    kind: "part",
    aad: `${fileId}:${version}:${index}`,
  })));
  const joined = new Uint8Array(plaintextParts.reduce((sum, part) => sum + part.byteLength, 0));
  joined.set(plaintextParts[0], 0);
  joined.set(plaintextParts[1], plaintextParts[0].byteLength);
  const record: V4FileRecord = {
    pathId: "opaque-path-id",
    fileId,
    plaintextSha256: await sha256Hex(joined),
    size: joined.byteLength,
    mtime: 1,
    remoteVersion: version,
    remotePath: partPaths[0],
    storage: "chunked",
    partPaths,
  };

  const correct = new Map(partPaths.map((path, index) => [path, encryptedParts[index]]));
  assert.deepEqual(await codec.read(record, async path => correct.get(path)!), joined);

  const reordered = new Map([
    [partPaths[0], encryptedParts[1]],
    [partPaths[1], encryptedParts[0]],
  ]);
  await assert.rejects(() => codec.read(record, async path => reordered.get(path)!));
});

test("v4 encrypted relocate changes path identity only and reuses the existing content object", async () => {
  const keys = await deriveV4Keyring({ passphrase: "contract", repoId: "owner/repo#main", salt: bytes("relocate-salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const prepared = await codec.prepare("Private/original.md", bytes("same content"), "journal-1", 1, "stable-file");
  const relocated = await codec.relocate(prepared.record, "Archive/renamed.txt");

  assert.notEqual(relocated.pathId, prepared.record.pathId);
  assert.equal(relocated.fileId, prepared.record.fileId);
  assert.equal(relocated.remotePath, prepared.record.remotePath);
  assert.equal(relocated.encryptedPath, prepared.record.encryptedPath);
  assert.equal(relocated.plaintextSha256, prepared.record.plaintextSha256);
  assert.equal(relocated.remoteVersion, prepared.record.remoteVersion);
});
