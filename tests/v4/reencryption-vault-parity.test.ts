import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { buildV4PartPaths } from "../../src/lib/v4/large-files";
import { objectIdForV4File, opaqueV4PackPath } from "../../src/lib/v4/paths";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch";
import { assertV4ReencryptionVaultParity } from "../../src/lib/v4/reencryption-vault-parity";
import type { V4RemoteShard } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const enc = utf8ToBytes;
const pinned = "a".repeat(40);
const sourceId = "owner/repo#main";
const destinationId = "owner/repo#rekey/d78";
const makeConfig = (repoId: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId,
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: toBase64Url(enc(salt)) },
});
const sourceConfig = makeConfig(sourceId, "d78-original-salt");
const destinationConfig = makeConfig(destinationId, "d78-new-salt");
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: sourceId, destinationRepoId: destinationId,
  sourceCommitSha: pinned, sourcePhysicalRepositoryId: 500,
  destinationPhysicalRepositoryId: 500, expectedPhysicalRepositoryId: 500, defaultBranch: "main",
});
async function makeShards(records: V4IndexFileRecord[]) {
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(enc(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "j", deviceId: "d", updatedAt: 1, shardHashes,
  };
  return { shards, head };
}
async function fixture() {
  const sourceKeyring = await deriveV4Keyring({
    passphrase: "old pass", repoId: sourceId, salt: enc("d78-original-salt"), iterations: 10,
  });
  const destinationKeyring = await deriveV4Keyring({
    passphrase: "new pass", repoId: destinationId, salt: enc("d78-new-salt"), iterations: 10,
  });
  const oldCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: sourceKeyring });
  const newCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring });
  const paths = ["Unicode/秘密 🌿.md", "Archive/empty.bin", "Assets/binary.bin"];
  const contents = [enc("hello-world"), new Uint8Array(), new Uint8Array([0, 255, 1, 2])];
  const sourceRecords: V4IndexFileRecord[] = [];
  const destinationRecords: V4IndexFileRecord[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const bytes = contents[i]!;
    const old = await oldCodec.prepare(path, bytes, "source-v1", i + 1, `old-file-${i}`);
    const newer = await newCodec.prepare(path, bytes, "rekey-v1", i + 1, `new-file-${i}`);
    sourceRecords.push({ ...old.record, path });
    destinationRecords.push({ ...newer.record, path });
  }
  const removed = await oldCodec.prepare("Deleted/missing.md", enc("deleted"), "old-v1", 1, "deleted-old");
  sourceRecords.push({ ...removed.record, path: "Deleted/missing.md", deleted: true });
  const { head, shards } = await makeShards(sourceRecords);
  const options = {
    plan, sourceConfig, sourceHead: head, sourceShards: shards, sourceKeyring,
    destinationConfig, destinationKeyring, destinationRecords,
  };
  return { options, sourceRecords, destinationRecords, head, shards, sourceKeyring, destinationKeyring };
}

test("D78 full-vault logical parity accepts exact live set, redacts paths, and counts source tombstones", async () => {
  const f = await fixture();
  const proof = await assertV4ReencryptionVaultParity(f.options);
  assert.deepEqual(proof, {
    integrityScope: "metadata-parity-only",
    destinationContentVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    pinnedSourceCommitSha: pinned,
    destinationRepoId: destinationId,
    matchedLiveFileCount: 3,
    totalMatchedPlaintextBytes: "15",
    destinationObjectCount: 3,
    sourceTombstoneCount: 1,
  });
  assert.ok(Object.isFrozen(proof));
  assert.ok(!JSON.stringify(proof).includes("秘密"));
  assert.ok(!JSON.stringify(proof).includes("d78-original-salt"));
});

test("D78 refuses every missing, extra, duplicated or resurrected logical file", async () => {
  const f = await fixture();
  const sample = f.destinationRecords[0]!;
  const deletedSource = f.sourceRecords[3]!;
  for (const destinationRecords of [
    f.destinationRecords.slice(1),
    [...f.destinationRecords, { ...sample, path: "Unexpected.md" }],
    [...f.destinationRecords, sample],
    [...f.destinationRecords, { ...sample, path: deletedSource.path }],
  ]) {
    await assert.rejects(() => assertV4ReencryptionVaultParity({
      ...f.options, destinationRecords,
    }), /file|count|duplicate|path|parity|record|identity/i);
  }
});

test("D78 refuses altered hash/size/mtime and reused old logical encryption identifiers", async () => {
  const f = await fixture();
  const old = f.sourceRecords[0]!;
  const fresh = f.destinationRecords[0]!;
  for (const altered of [
    { ...fresh, plaintextSha256: "f".repeat(64) },
    { ...fresh, size: fresh.size + 1 },
    { ...fresh, mtime: fresh.mtime + 100 },
    { ...fresh, fileId: old.fileId },
    { ...fresh, pathId: old.pathId },
    { ...fresh, remotePath: old.remotePath },
  ]) {
    await assert.rejects(() => assertV4ReencryptionVaultParity({
      ...f.options, destinationRecords: [altered, ...f.destinationRecords.slice(1)],
    }), /hash|size|mtime|identity|fileId|pathId|object|storage|HMAC|path/i);
  }
});

test("D78 refuses incomplete authenticated source buckets, wrong pin, destination key reuse and salt reuse", async () => {
  const f = await fixture();
  const [bucket] = Object.keys(f.shards);
  assert.ok(bucket);
  const missing = { ...f.shards };
  delete missing[bucket];
  for (const patch of [
    { sourceShards: missing },
    { sourceHead: { ...f.head, shardHashes: { ...f.head.shardHashes, [bucket]: "0".repeat(64) } } },
    { sourceKeyring: f.destinationKeyring },
    { destinationKeyring: f.sourceKeyring },
    { destinationConfig: { ...destinationConfig, kdfParams: sourceConfig.kdfParams } },
    { plan: { ...plan, pinnedSourceCommitSha: "HEAD" } },
    { destinationConfig: { ...destinationConfig, repoId: sourceId } },
  ]) {
    await assert.rejects(() => assertV4ReencryptionVaultParity({ ...f.options, ...patch }),
      /source|destination|inventory|shard|bucket|hash|identity|key|salt|commit|SHA|plan/i);
  }
});

test("D78 refuses colliding destination paths, old remote-object references and dirty output", async () => {
  const f = await fixture();
  const [a, b] = f.destinationRecords;
  assert.ok(a && b);
  const one = f.sourceRecords[0]!;
  for (const records of [
    [{ ...a, path: "archive/EMPTY.bin" }, b, f.destinationRecords[2]!],
    [{ ...a, remotePath: one.remotePath }, b, f.destinationRecords[2]!],
    [{ ...a, dirty: true }, b, f.destinationRecords[2]!],
    [{ ...a, deleted: true }, b, f.destinationRecords[2]!],
  ]) {
    await assert.rejects(() => assertV4ReencryptionVaultParity({
      ...f.options, destinationRecords: records,
    }), /path|collision|object|dirty|deleted|invalid|record|parity/i);
  }
});

test("D78 compares all live file identities across shared old packs and multipart source storage", async () => {
  const f = await fixture();
  const oldPackId = "d78-shared-pack";
  const sharedPackPath = await opaqueV4PackPath(f.sourceKeyring.pathKey, oldPackId);
  const oldRecords = f.sourceRecords.map((record, i) => i < 2
    ? { ...record, storage: "pack" as const, packId: oldPackId, remotePath: sharedPackPath, encryptedPath: sharedPackPath }
    : { ...record });
  const third = oldRecords[2]!;
  const opaqueId = await objectIdForV4File(f.sourceKeyring.pathKey, third.fileId);
  const partPaths = buildV4PartPaths({
    mode: "encrypted", logicalPath: third.path, version: third.remoteVersion,
    partCount: 2, opaqueId,
  });
  oldRecords[2] = {
    ...third, storage: "chunked", remotePath: partPaths[0]!, encryptedPath: partPaths[0]!, partPaths,
  };
  const { head, shards } = await makeShards(oldRecords);
  const proof = await assertV4ReencryptionVaultParity({
    ...f.options, sourceHead: head, sourceShards: shards,
  });
  assert.equal(proof.matchedLiveFileCount, 3);
  assert.equal(proof.destinationObjectCount, 3);
  assert.equal(proof.sourceTombstoneCount, 1);
});

test("D78 handles an authenticated tombstone-only source without silently restoring deleted content", async () => {
  const f = await fixture();
  const { head, shards } = await makeShards([f.sourceRecords[3]!]);
  const proof = await assertV4ReencryptionVaultParity({
    ...f.options, sourceHead: head, sourceShards: shards, destinationRecords: [],
  });
  assert.equal(proof.matchedLiveFileCount, 0);
  assert.equal(proof.sourceTombstoneCount, 1);
  assert.equal(proof.permissionToPublish, false);
  assert.equal(proof.cutoverAuthorized, false);
});

test("D78 detects virtual logically huge complete snapshots using BigInt without allocating real files", async () => {
  const f = await fixture();
  const heavy = Number.MAX_SAFE_INTEGER;
  const sourceRecords = f.sourceRecords.map((record, i) => i < 2 ? { ...record, size: heavy } : record);
  const destinationRecords = f.destinationRecords.map((record, i) => i < 2 ? { ...record, size: heavy } : record);
  const { head, shards } = await makeShards(sourceRecords);
  const result = await assertV4ReencryptionVaultParity({
    ...f.options, sourceHead: head, sourceShards: shards, destinationRecords,
  });
  assert.equal(result.totalMatchedPlaintextBytes, (BigInt(heavy) * BigInt(2) + BigInt(4)).toString());
});
