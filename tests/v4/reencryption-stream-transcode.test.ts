import assert from "node:assert/strict";
import test from "node:test";

import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { createV4ReencryptedObjectStream } from "../../src/lib/v4/reencryption-stream-transcode";
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch";
import { V4StorageCodec, type V4PreparedRemoteWrite } from "../../src/lib/v4/storage-codec";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { sha256Hex, utf8ToBytes, toBase64Url } from "../../src/lib/bytes";
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "../../src/lib/v4/large-files";

const sha = "a".repeat(40);
const sourceRepoId = "owner/repo#main";
const destinationRepoId = "owner/repo#rekey/d76";
const str = utf8ToBytes;
const cfg = (repoId: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId,
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
  kdfParams: { iterations: 600_000, salt },
});
const sourceCfg = cfg(sourceRepoId, toBase64Url(str("source-salt")));
const destinationCfg = cfg(destinationRepoId, toBase64Url(str("destination-salt")));
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId, destinationRepoId, sourceCommitSha: sha, sourcePhysicalRepositoryId: 900,
  destinationPhysicalRepositoryId: 900, expectedPhysicalRepositoryId: 900, defaultBranch: "main",
});
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const oldKey = await deriveV4Keyring({
    passphrase: "synthetic-old", repoId: sourceRepoId, salt: str("source-salt"), iterations: 10,
  });
  const newKey = await deriveV4Keyring({
    passphrase: "synthetic-new", repoId: destinationRepoId, salt: str("destination-salt"), iterations: 10,
  });
  const oldCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: oldKey });
  const newCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: newKey });
  return { oldKey, newKey, oldCodec, newCodec };
}
function sourceOf(f: Fixture, prepared: V4PreparedRemoteWrite, path: string) {
  const record: V4IndexFileRecord = { ...prepared.record, path };
  const blobs = new Map(prepared.files.map(file => [file.path, file.bytes]));
  let stableChecks = 0;
  const options = {
    plan, sourceConfig: sourceCfg, destinationConfig: destinationCfg,
    sourceKeyring: f.oldKey, destinationKeyring: f.newKey, sourceRecord: record,
    async readSourceObject(path: string, exactSha: string) {
      assert.equal(exactSha, sha);
      return blobs.get(path) ?? null;
    },
    async verifySourceStillPinned() { stableChecks++; },
  };
  return { record, blobs, options, get stableChecks() { return stableChecks; } };
}
async function consume(f: Fixture, source: ReturnType<typeof sourceOf>) {
  const staged = await createV4ReencryptedObjectStream(source.options);
  assert.equal(staged.objectPaths.length, staged.objectCount);
  await assert.rejects(() => staged.finalize(), /finish|consum|complete/i);
  const blobs = new Map<string, Uint8Array>();
  for await (const obj of staged.objects()) {
    assert.equal(blobs.has(obj.path), false);
    assert.ok(obj.bytes.byteLength <= V4_GITHUB_REST_SAFE_WRITER_BYTES);
    blobs.set(obj.path, obj.bytes);
    obj.release?.();
  }
  const record = await staged.finalize();
  const plain = await f.newCodec.read(record, async path => {
    const blob = blobs.get(path);
    if (!blob) throw new Error("missing new encrypted object");
    return blob;
  });
  return { record, plain, blobs };
}
test("D76 re-encrypts a Unicode single file with different repository-bound ciphertext and opaque identity", async () => {
  const f = await setup();
  const old = await f.oldCodec.prepare("Unicode/秘密 🌎.md", str("a new secret"), "old-v1", 4, "old-fileid");
  const s = sourceOf(f, old, "Unicode/秘密 🌎.md");
  const result = await consume(f, s);
  assert.deepEqual(result.plain, str("a new secret"));
  assert.equal(result.record.plaintextSha256, s.record.plaintextSha256);
  assert.equal(result.record.pathId === s.record.pathId, false);
  assert.equal(result.record.remotePath === s.record.remotePath, false);
  assert.equal(result.record.fileId === s.record.fileId, false);
  assert.equal(result.record.storage, "single");
  assert.ok(s.stableChecks >= 2);
});

test("D76 converts two old packed file records to independent new ciphertext without reusing source pack", async () => {
  const f = await setup();
  const aPlain = str("one");
  const bPlain = str("two");
  const a = await f.oldCodec.prepare("a.md", aPlain, "v1", 1, "old-a");
  const b = await f.oldCodec.prepare("b.md", bPlain, "v1", 2, "old-b");
  const packed = await f.oldCodec.preparePack("old-pack", [{ record: a.record, plaintext: aPlain }, { record: b.record, plaintext: bPlain }]);
  const packedBlob = new Map([[packed.file.path, packed.file.bytes]]);
  for (const [i, item] of packed.records.entries()) {
    const record = { ...item, path: i === 0 ? "a.md" : "b.md" } satisfies V4IndexFileRecord;
    const staged = await createV4ReencryptedObjectStream({
      plan, sourceConfig: sourceCfg, destinationConfig: destinationCfg,
      sourceKeyring: f.oldKey, destinationKeyring: f.newKey,
      sourceRecord: record,
      async readSourceObject(path, exact) { assert.equal(exact, sha); return packedBlob.get(path) ?? null; },
      async verifySourceStillPinned() {},
    });
    const objects = [];
    for await (const object of staged.objects()) objects.push(object);
    const next = await staged.finalize();
    assert.equal(next.storage, "single");
    assert.notEqual(next.remotePath, packed.file.path);
    assert.deepEqual(await f.newCodec.read(next, async path => objects.find(o => o.path === path)!.bytes), i === 0 ? aPlain : bPlain);
  }
});

test("D76 streams >8 MiB chunked source into new ciphertext parts at the fixed REST payload cap", async () => {
  const f = await setup();
  const plain = new Uint8Array(8 * 1024 * 1024 + 121).fill(0xa7);
  const old = await f.oldCodec.prepare("big.bin", plain, "old-v2", 100, "old-chunked");
  assert.equal(old.record.storage, "chunked");
  const s = sourceOf(f, old, "big.bin");
  const result = await consume(f, s);
  assert.equal(result.record.storage, "chunked");
  assert.deepEqual(result.plain, plain);
  assert.equal(result.record.plaintextSha256, await sha256Hex(plain));
  assert.equal(result.blobs.size, 2);
  assert.ok([...result.blobs.values()].every(b => b.byteLength <= V4_GITHUB_REST_SAFE_WRITER_BYTES));
});

test("D76 rejects tampered source bytes and mismatched expected SHA without returning a publishable record", async () => {
  const f = await setup();
  const old = await f.oldCodec.prepare("c.md", str("ciphertext"), "v1", 5, "old-c");
  const s = sourceOf(f, old, "c.md");
  const remote = s.blobs.get(s.record.remotePath)!;
  s.blobs.set(s.record.remotePath, Uint8Array.from(remote, (v, i) => i === remote.length - 1 ? v ^ 1 : v));
  const staged = await createV4ReencryptedObjectStream(s.options);
  await assert.rejects(async () => { for await (const _ of staged.objects()) {} }, /auth|decrypt|integrity|source/i);
  await assert.rejects(() => staged.finalize(), /finish|complete|consum/i);
  s.blobs.set(s.record.remotePath, remote);
  const wrongHash = await createV4ReencryptedObjectStream({
    ...s.options, sourceRecord: { ...s.record, plaintextSha256: "f".repeat(64) },
  });
  await assert.rejects(async () => {
    for await (const _ of wrongHash.objects()) {}
    await wrongHash.finalize();
  }, /hash|changed|integrity/i);
});

test("D76 preserves authenticated empty encrypted files", async () => {
  const f = await setup();
  const old = await f.oldCodec.prepare("empty.bin", new Uint8Array(), "v1", 42, "old-empty");
  const migrated = await consume(f, sourceOf(f, old, "empty.bin"));
  assert.equal(migrated.plain.byteLength, 0);
  assert.equal(migrated.record.size, 0);
  assert.equal(migrated.record.plaintextSha256, await sha256Hex(new Uint8Array()));
  assert.equal(migrated.blobs.size, 1);
});

test("D76 never finalizes a multipart source if a later encrypted part fails authentication", async () => {
  const f = await setup();
  const old = await f.oldCodec.prepare("multifile.bin", new Uint8Array(8 * 1024 * 1024 + 31).fill(0x48), "v1", 12, "old-multi");
  const s = sourceOf(f, old, "multifile.bin");
  const badPath = s.record.partPaths?.[1];
  assert.ok(badPath);
  const original = s.blobs.get(badPath);
  assert.ok(original);
  const tampered = original.slice();
  tampered[tampered.length - 1] ^= 1;
  s.blobs.set(badPath, tampered);
  const prepared = await createV4ReencryptedObjectStream(s.options);
  let seen = 0;
  await assert.rejects(async () => {
    for await (const object of prepared.objects()) {
      seen++;
      object.release?.();
    }
  }, /source part authentication|integrity|auth/i);
  assert.equal(seen, 1, "earlier immutable staging is not a complete publishable record");
  await assert.rejects(() => prepared.finalize(), /finish|complete|consum/i);
});

test("D76 rejects same-source destination, salt reuse, tombstone, stale source, and unsafe version", async () => {
  const f = await setup();
  const old = await f.oldCodec.prepare("check.md", str("content"), "v1", 5, "old-check");
  const s = sourceOf(f, old, "check.md");
  const patches = [
    { destinationConfig: sourceCfg },
    { destinationConfig: { ...destinationCfg, kdfParams: sourceCfg.kdfParams } },
    { sourceRecord: { ...s.record, deleted: true } },
    { targetVersion: "../evil" },
  ];
  for (const patch of patches) {
    await assert.rejects(() => createV4ReencryptedObjectStream({ ...s.options, ...patch }), /destination|salt|tombstone|version|invalid/i);
  }
  await assert.rejects(() => createV4ReencryptedObjectStream({
    ...s.options, async verifySourceStillPinned() { throw new Error("source HEAD changed"); },
  }), /source HEAD changed/);
  let observations = 0;
  const unstable = await createV4ReencryptedObjectStream({
    ...s.options, async verifySourceStillPinned() {
      if (++observations > 1) throw new Error("source HEAD changed mid-stream");
    },
  });
  await assert.rejects(async () => { for await (const _ of unstable.objects()) {} }, /source HEAD changed mid-stream/);
});

test("D77 transcode fixes near-8 MiB encrypted boundary by safely chunking", async () => {
  const f = await setup();
  const size = V4_GITHUB_REST_SAFE_WRITER_BYTES - 8;
  const plaintext = new Uint8Array(size).fill(0x5b);
  const old = await f.oldCodec.prepare("near-boundary.bin", plaintext, "v1", 23, "old-boundary");
  assert.equal(old.record.storage, "chunked");
  const result = await consume(f, sourceOf(f, old, "near-boundary.bin"));
  assert.equal(result.record.storage, "chunked");
  assert.equal(result.record.plaintextSha256, await sha256Hex(plaintext));
  assert.deepEqual(result.plain, plaintext);
  assert.ok([...result.blobs.values()].every(b => b.length <= V4_GITHUB_REST_SAFE_WRITER_BYTES));
});
