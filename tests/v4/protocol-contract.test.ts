import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { shouldUseV4Parts, splitV4Parts, V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
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
