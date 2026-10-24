import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity";
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch";
import { stageV4ReencryptionVaultObjects } from "../../src/lib/v4/reencryption-staging-receipts";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import type { V4RemoteShard } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const bytes = utf8ToBytes;
const sha = "a".repeat(40);
const oldId = "owner/repo#main";
const newId = "owner/repo#rekey/d79";
const config = (repoId: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
  kdf: "PBKDF2-SHA-256", algorithm: "AES-GCM",
  kdfParams: { iterations: 600_000, salt: toBase64Url(bytes(salt)) },
});
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: oldId, destinationRepoId: newId,
  sourceCommitSha: sha, sourcePhysicalRepositoryId: 45, destinationPhysicalRepositoryId: 45,
  expectedPhysicalRepositoryId: 45, defaultBranch: "main",
});
async function fixture(extraSize = 0) {
  const sourceKeyring = await deriveV4Keyring({
    repoId: oldId, passphrase: "old-secret", salt: bytes("old-salt"), iterations: 10,
  });
  const destinationKeyring = await deriveV4Keyring({
    repoId: newId, passphrase: "new-secret", salt: bytes("new-salt"), iterations: 10,
  });
  const sourceCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: sourceKeyring });
  const destinationCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring });
  const sourceBytes = new Map<string, Uint8Array>();
  const targets = new Map<string, Uint8Array>([
    ["Unicode/秘密 🌼.md", bytes("some encrypted data")],
    ["Archive/empty.bin", new Uint8Array()],
  ]);
  if (extraSize) targets.set("Files/big.bin", new Uint8Array(extraSize).fill(0x47));
  const records: V4IndexFileRecord[] = [];
  for (const [path, value] of targets) {
    const prepared = await sourceCodec.prepare(path, value, "v1", 22, "old-" + records.length);
    records.push({ ...prepared.record, path });
    for (const part of prepared.files) sourceBytes.set(part.path, part.bytes);
  }
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(bytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "j",
    deviceId: "device", updatedAt: 1, shardHashes,
  };
  const staged = new Map<string, Uint8Array>();
  const receipts: Array<{ path: string; sha: string }> = [];
  let sourceChecks = 0;
  let stages = 0;
  const input = {
    plan, sourceConfig: config(oldId, "old-salt"), sourceHead: head, sourceShards: shards,
    sourceKeyring, destinationConfig: config(newId, "new-salt"), destinationKeyring,
    async readSourceObject(path: string, commitSha: string) {
      assert.equal(commitSha, sha);
      return sourceBytes.get(path) ?? null;
    },
    async verifySourceStillPinned() { sourceChecks++; },
    async stageImmutableObject(path: string, ciphertext: Uint8Array) {
      stages++;
      const value = ciphertext.slice();
      staged.set(path, value);
      const id = computeV4GitBlobSha1(value);
      receipts.push({ path, sha: id });
      return id;
    },
  };
  return {
    input, staged, receipts, targets, destinationCodec, sourceBytes,
    get stages() { return stages; }, get sourceChecks() { return sourceChecks; },
  };
}

test("D79 stages only finalized V4 output and matches full-vault parity without permitting publish", async () => {
  const f = await fixture();
  const result = await stageV4ReencryptionVaultObjects(f.input);
  assert.equal(result.preview.integrityScope, "staged-immutable-blobs-only");
  assert.equal(result.preview.permissionToPublish, false);
  assert.equal(result.preview.cutoverAuthorized, false);
  assert.equal(result.preview.backupVerified, false);
  assert.equal(result.preview.destinationReadbackVerified, false);
  assert.equal(result.preview.finalizedFileCount, 2);
  assert.equal(result.preview.validatedReceiptCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.receipts.length, 2);
  assert.equal(f.stages, 2);
  assert.ok(f.sourceChecks >= 3);
  assert.ok(Object.isFrozen(result.preview));
  assert.ok(!JSON.stringify(result.preview).includes("秘密"));
  for (const record of result.records) {
    assert.deepEqual(await f.destinationCodec.read(record, async path => f.staged.get(path)!), f.targets.get(record.path));
  }
});

test("D79 rejects a wrong or malformed GitHub object SHA receipt without returning a completed manifest", async () => {
  const f = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, async stageImmutableObject(_path, _content) { return "f".repeat(40); },
  }), /receipt|blob|SHA|identity/i);
  const next = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...next.input, async stageImmutableObject() { return "HEAD"; },
  }), /receipt|blob|SHA|identity/i);
});

test("D79 stages no extra blobs on incomplete/missing or changed source", async () => {
  const f = await fixture();
  const unknown = { ...f.input.sourceShards };
  delete unknown[Object.keys(unknown)[0]!];
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, sourceShards: unknown,
  }), /bucket|shard|missing/i);
  assert.equal(f.stages, 0);
  const g = await fixture();
  let calls = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...g.input, async verifySourceStillPinned() {
      if (++calls > 2) throw new Error("source HEAD changed");
    },
  }), /source HEAD changed/i);
});

test("D79 refuses a completed manifest if a later immutable blob staging attempt fails", async () => {
  const f = await fixture();
  let callbacks = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, async stageImmutableObject(path, value) {
      if (++callbacks === 2) throw new Error("temporary GitHub upload failed");
      return computeV4GitBlobSha1(value);
    },
  }), /temporary GitHub upload failed/i);
  assert.equal(callbacks, 2);
});

test("D79 rejects a staging callback that mutates the ciphertext buffer after its SHA was computed", async () => {
  const f = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input,
    async stageImmutableObject(_path, ciphertext) {
      const before = computeV4GitBlobSha1(ciphertext);
      ciphertext[0] = ciphertext[0]! ^ 1;
      return before;
    },
  }), /receipt SHA identity mismatch/i);
});

test("D79 never returns a completed manifest when a later source multipart part is corrupted", async () => {
  const f = await fixture(8 * 1024 * 1024 + 17);
  const all = Object.values(f.input.sourceShards).flatMap(shard => Object.values(shard.records));
  const chunked = all.find(record => record.storage === "chunked");
  assert.ok(chunked);
  const lastPath = chunked.partPaths?.[chunked.partPaths.length - 1];
  assert.ok(lastPath);
  const raw = f.sourceBytes.get(lastPath);
  assert.ok(raw);
  const tampered = raw.slice();
  tampered[tampered.length - 1] ^= 1;
  f.sourceBytes.set(lastPath, tampered);
  await assert.rejects(() => stageV4ReencryptionVaultObjects(f.input), /integrity|authentication|source|decrypt/i);
  assert.ok(f.stages > 0, "an earlier staged immutable object must never imply a complete vault");
});

test("D79 authenticates and stages multipart ciphertext one part at a time", async () => {
  const f = await fixture(8 * 1024 * 1024 + 17);
  const result = await stageV4ReencryptionVaultObjects(f.input);
  assert.equal(result.preview.finalizedFileCount, 3);
  assert.equal(result.preview.validatedReceiptCount, 4);
  for (const receipt of result.receipts) {
    assert.ok(receipt.byteLength <= 8 * 1024 * 1024);
    assert.equal(receipt.sha, computeV4GitBlobSha1(f.staged.get(receipt.path)!));
  }
  const big = result.records.find(record => record.path === "Files/big.bin")!;
  assert.equal(big.storage, "chunked");
  assert.ok(Object.isFrozen(big));
  assert.ok(Object.isFrozen(big.partPaths));
  assert.throws(() => big.partPaths!.push("forged-part"), TypeError,
    "completed multipart object paths must remain immutable after receipt validation");
  assert.deepEqual(await f.destinationCodec.read(big, async path => f.staged.get(path)!), f.targets.get(big.path));
});

test("D79 refuses cancellation before producing an output report", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, signal: controller.signal,
  }), /cancelled/i);
  assert.equal(f.stages, 0);
});
