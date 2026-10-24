import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { objectIdForV4File, pathIdForV4Path, opaqueV4ObjectPath, opaqueV4PackPath } from "../../src/lib/v4/paths";
import { buildV4PartPaths } from "../../src/lib/v4/large-files";
import type { V4RemoteShard } from "../../src/lib/v4/remote-index";
import { inspectV4ReencryptionInventory } from "../../src/lib/v4/reencryption-inventory";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";

const SOURCE_SHA = "a".repeat(40);
const CONFIG: V4RemoteConfig = {
  formatVersion: 4, mode: "encrypted", repoId: "o/r#main",
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: "c2FsdA" },
};

async function makeRecord(keyring: V4Keyring, path: string, fileId = path, size = 4): Promise<V4IndexFileRecord> {
  return {
    path, fileId, pathId: await pathIdForV4Path(keyring.pathKey, path),
    plaintextSha256: await sha256Hex(utf8ToBytes("body-" + fileId)),
    size, mtime: 123, remoteVersion: "v1",
    remotePath: await opaqueV4ObjectPath(keyring.pathKey, fileId),
    storage: "single",
  };
}

async function fixture() {
  const keyring = await deriveV4Keyring({ passphrase: "synthetic", repoId: CONFIG.repoId, salt: utf8ToBytes("salt"), iterations: 10 });
  const records = [await makeRecord(keyring, "Folder/秘密.md", "f-one", 4), await makeRecord(keyring, "another.md", "f-two", 9)];
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 2, journalId: "j",
    shardHashes, updatedAt: 1, deviceId: "device",
  };
  return { keyring, records, shards, head };
}

test("D68 inventory accepts complete authenticated logical metadata and does not leak paths", async () => {
  const f = await fixture();
  const result = await inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards: f.shards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  });
  assert.deepEqual(result, {
    integrityScope: "metadata-only",
    objectContentVerified: false,
    pinnedSourceCommitSha: SOURCE_SHA,
    fileCount: 2,
    totalLogicalBytes: "13",
    shardCount: Object.keys(f.shards).length,
    distinctRemoteObjectCount: 2,
    chunkedFileCount: 0,
    packFileCount: 0,
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes("秘密"), false);
  assert.equal(JSON.stringify(result).includes("salt"), false);
});

test("D68 inventory fails closed for missing, unexpected and inconsistent buckets", async () => {
  const f = await fixture();
  const [firstBucket] = Object.keys(f.shards);
  assert.ok(firstBucket);
  const missing = { ...f.shards };
  delete missing[firstBucket];
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards: missing, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /missing|bucket|complete/i);
  const extra = { ...f.shards, ff: { bucket: "ff", records: {} } };
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards: extra, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /unexpected|bucket|complete/i);
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: { ...f.head, shardHashes: { ...f.head.shardHashes, [firstBucket]: "0".repeat(64) } },
    shards: f.shards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /hash|signature/i);
});

test("D68 inventory rejects corrupted paths, forged remote artifacts and duplicate logical records", async () => {
  const f = await fixture();
  const [first] = f.records;
  assert.ok(first);
  const bucket = first.pathId.slice(0, 2);
  const forged: V4IndexFileRecord = { ...first, remotePath: ".obsidian-github-sync-v4/data/00/not-the-object.enc" };
  const shards = { ...f.shards, [bucket]: { bucket, records: { ...f.shards[bucket]?.records, [first.pathId]: forged } } };
  const forgedHead = { ...f.head, shardHashes: { ...f.head.shardHashes,
    [bucket]: await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(shards[bucket]!.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    ))) } };
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: forgedHead, shards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /storage path|opaque|inconsistent/i);
  const duplicate = { ...f.records[1]!, path: first.path };
  const otherBucket = f.records[1]!.pathId.slice(0, 2);
  const duplicateShards = { ...f.shards,
    [otherBucket]: { bucket: otherBucket, records: { ...f.shards[otherBucket]?.records, [duplicate.pathId]: duplicate } } };
  const duplicateHead = { ...f.head, shardHashes: { ...f.head.shardHashes,
    [otherBucket]: await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(duplicateShards[otherBucket]!.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    ))) } };
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: duplicateHead, shards: duplicateShards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /duplicate|logical path/i);
});

test("D68 inventory handles shared packed ciphertext without double counting blobs", async () => {
  const f = await fixture();
  const packPath = await opaqueV4PackPath(f.keyring.pathKey, "pack-id");
  const records = f.records.map(record => ({
    ...record, storage: "pack" as const, packId: "pack-id", remotePath: packPath,
  }));
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const result = await inspectV4ReencryptionInventory({
    config: CONFIG, head: { ...f.head, shardHashes }, shards, keyring: f.keyring,
    pinnedSourceCommitSha: SOURCE_SHA,
  });
  assert.equal(result.distinctRemoteObjectCount, 1);
  assert.equal(result.packFileCount, 2);
  assert.equal(result.totalLogicalBytes, "13");
});

test("D68 inventory counts chunked remote parts and sums logical bytes without precision loss", async () => {
  const f = await fixture();
  const first = f.records[0]!;
  const bucket = first.pathId.slice(0, 2);
  const opaqueId = await objectIdForV4File(f.keyring.pathKey, first.fileId);
  const partPaths = buildV4PartPaths({
    mode: "encrypted", logicalPath: first.path, version: first.remoteVersion,
    partCount: 2, opaqueId,
  });
  const updated = {
    ...first, size: Number.MAX_SAFE_INTEGER,
    storage: "chunked" as const, partPaths, remotePath: partPaths[0]!,
  };
  const other = { ...f.records[1]!, size: Number.MAX_SAFE_INTEGER };
  const records = [updated, other];
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const shardBucket = record.pathId.slice(0, 2);
    (shards[shardBucket] ??= { bucket: shardBucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [shardBucket, shard] of Object.entries(shards)) {
    shardHashes[shardBucket] = await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const result = await inspectV4ReencryptionInventory({
    config: CONFIG, head: { ...f.head, shardHashes }, shards,
    keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  });
  assert.equal(result.chunkedFileCount, 1);
  assert.equal(result.distinctRemoteObjectCount, 3);
  assert.equal(result.totalLogicalBytes, "18014398509481982");
});

test("D68 inventory rejects local dirty records and tombstones without treating them as live files", async () => {
  const f = await fixture();
  const record = f.records[0]!;
  const bucket = record.pathId.slice(0, 2);
  const dirty = { ...record, dirty: true };
  const shards = { ...f.shards, [bucket]: { bucket, records: { ...f.shards[bucket]?.records, [record.pathId]: dirty } } };
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /dirty|uncommitted/i);
  const deleted = { ...record, deleted: true };
  const delShards = { ...f.shards, [bucket]: { bucket, records: { ...f.shards[bucket]?.records, [record.pathId]: deleted } } };
  const deletedBucketRecords = Object.values(delShards[bucket]!.records)
    .sort((a, b) => a.pathId.localeCompare(b.pathId));
  const delHead = { ...f.head, shardHashes: {
    ...f.head.shardHashes,
    [bucket]: await sha256Hex(utf8ToBytes(JSON.stringify(deletedBucketRecords))),
  } };
  const result = await inspectV4ReencryptionInventory({
    config: CONFIG, head: delHead, shards: delShards, keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  });
  assert.equal(result.fileCount, 1);
  assert.equal(result.totalLogicalBytes, "9");
});

test("D68 inventory rejects absent key, malformed head and unpinned source SHA", async () => {
  const f = await fixture();
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards: f.shards, pinnedSourceCommitSha: SOURCE_SHA,
  }), /keyring|encryption/i);
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: { ...f.head, mode: "plaintext" }, shards: f.shards,
    keyring: f.keyring, pinnedSourceCommitSha: SOURCE_SHA,
  }), /head|mode/i);
  await assert.rejects(() => inspectV4ReencryptionInventory({
    config: CONFIG, head: f.head, shards: f.shards, keyring: f.keyring, pinnedSourceCommitSha: "HEAD",
  }), /commit SHA/i);
});
