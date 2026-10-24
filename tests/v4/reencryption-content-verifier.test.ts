import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { verifyV4ReencryptionSourceObjects } from "../../src/lib/v4/reencryption-content-verifier";
import type { V4RemoteShard } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const SHA = "a".repeat(40);
const MUTATED_SHA = "b".repeat(40);
const config: V4RemoteConfig = {
  formatVersion: 4, mode: "encrypted", repoId: "owner/repo#main",
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: "c2FsdA" },
};
const text = (s: string) => utf8ToBytes(s);

async function fixture() {
  const keyring = await deriveV4Keyring({ passphrase: "synthetic-d69", repoId: config.repoId, salt: text("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const objects = new Map<string, Uint8Array>();
  const records: V4IndexFileRecord[] = [];
  const add = (value: { record: Omit<V4IndexFileRecord, "path">; files: Array<{ path: string; bytes: Uint8Array }> }, path: string) => {
    records.push({ ...value.record, path });
    for (const file of value.files) objects.set(file.path, file.bytes);
  };
  const plaintext = text("秘密 😺\nHello");
  add(await codec.prepare("Folder/秘密.md", plaintext, "v1", 1, "file-1"), "Folder/秘密.md");
  return { keyring, codec, objects, records, plaintext };
}

async function inputOf(f: Awaited<ReturnType<typeof fixture>>) {
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of f.records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(text(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "j",
    shardHashes, updatedAt: 1, deviceId: "d",
  };
  const seenPaths: string[] = [];
  let observed = SHA;
  let reads = 0;
  return {
    config, head, shards, keyring: f.keyring, pinnedSourceCommitSha: SHA,
    async readCurrentSourceHeadSha() { return observed; },
    async readPinnedObject(path: string, sha: string) {
      assert.equal(sha, SHA, "never fetch a mutable branch ref");
      reads++;
      seenPaths.push(path);
      return f.objects.get(path) ?? null;
    },
    get reads() { return reads; },
    get seenPaths() { return seenPaths; },
    setCurrentHead(sha: string) { observed = sha; },
  };
}

test("D69 authenticates single object bytes and plaintext hash using pinned immutable Git commit", async () => {
  const f = await fixture();
  const input = await inputOf(f);
  const verified = await verifyV4ReencryptionSourceObjects(input);
  assert.deepEqual(verified, {
    integrityScope: "all-live-objects",
    pinnedSourceCommitSha: SHA,
    verifiedFileCount: 1,
    verifiedRemoteObjectCount: 1,
    totalVerifiedPlaintextBytes: String(f.plaintext.byteLength),
  });
  assert.ok(Object.isFrozen(verified));
  assert.equal(input.reads, 1);
  assert.equal(JSON.stringify(verified).includes("秘密"), false);
  assert.equal(JSON.stringify(verified).includes("salt"), false);
});

test("D69 rejects missing, modified, truncated, and auth-invalid single ciphertext", async () => {
  const f = await fixture();
  const sourceObject = f.records[0]!.remotePath;
  const pristine = f.objects.get(sourceObject)!;
  const variants: Array<[string, Uint8Array | null]> = [
    ["missing", null],
    ["ciphertext bit flipped", Uint8Array.from(pristine, (v, i) => i === pristine.length - 1 ? v ^ 1 : v)],
    ["truncated", pristine.subarray(0, 15)],
  ];
  for (const [name, bytes] of variants) {
    if (bytes === null) f.objects.delete(sourceObject);
    else f.objects.set(sourceObject, bytes);
    const input = await inputOf(f);
    await assert.rejects(() => verifyV4ReencryptionSourceObjects(input), /missing|decrypt|payload|integrity|auth/i, name);
  }
  f.objects.set(sourceObject, pristine);
  f.records[0] = { ...f.records[0]!, plaintextSha256: "0".repeat(64) };
  const input = await inputOf(f);
  await assert.rejects(() => verifyV4ReencryptionSourceObjects(input), /hash|integrity/i);
});

test("D69 refuses preflight HEAD mismatch and post-read source mutation", async () => {
  const f = await fixture();
  const source = await inputOf(f);
  source.setCurrentHead(MUTATED_SHA);
  await assert.rejects(() => verifyV4ReencryptionSourceObjects(source), /source HEAD|source commit|changed/i);
  assert.equal(source.reads, 0, "preflight HEAD race must prevent object reads");
  const post = await inputOf(f);
  const read = post.readPinnedObject;
  post.readPinnedObject = async (path: string, sha: string) => {
    const bytes = await read(path, sha);
    post.setCurrentHead(MUTATED_SHA);
    return bytes;
  };
  await assert.rejects(() => verifyV4ReencryptionSourceObjects(post), /source HEAD|source commit|changed/i);
});

test("D69 rejects corrupt or incomplete index before any object transfer", async () => {
  const f = await fixture();
  const source = await inputOf(f);
  const bucket = Object.keys(source.shards)[0]!;
  delete source.shards[bucket];
  await assert.rejects(() => verifyV4ReencryptionSourceObjects(source), /shard|bucket|missing/i);
  assert.equal(source.reads, 0);
});

test("D69 verifies packed records without treating one shared packed blob as two remote objects", async () => {
  const f = await fixture();
  const a = f.records[0]!;
  const bPlain = text("another packed item");
  const b = (await f.codec.prepare("next.md", bPlain, "v2", 2, "file-2")).record;
  const packed = await f.codec.preparePack("packed-together", [
    { record: a, plaintext: f.plaintext },
    { record: b, plaintext: bPlain },
  ]);
  f.records = packed.records.map((record, i) => ({ ...record, path: i === 0 ? "Folder/秘密.md" : "next.md" }));
  f.objects.clear();
  f.objects.set(packed.file.path, packed.file.bytes);
  const source = await inputOf(f);
  const verified = await verifyV4ReencryptionSourceObjects(source);
  assert.equal(verified.verifiedFileCount, 2);
  assert.equal(verified.verifiedRemoteObjectCount, 1);
  assert.equal(verified.totalVerifiedPlaintextBytes, String(f.plaintext.byteLength + bPlain.byteLength));
  assert.equal(source.reads, 2, "pack reread per logical record is bounded, not cached without a size policy");
  // Valid AES-GCM archive but missing packed fileId must fail.
  f.objects.set(packed.file.path, Uint8Array.from(packed.file.bytes, (v, i) => i === packed.file.bytes.length - 1 ? v ^ 1 : v));
  await assert.rejects(async () => verifyV4ReencryptionSourceObjects(await inputOf(f)), /decrypt|auth|integrity/i);
});

test("D69 authenticates every multipart object and refuses corrupt later parts", async () => {
  const f = await fixture();
  const large = new Uint8Array(8 * 1024 * 1024 + 1).fill(0x6b);
  const prepared = await f.codec.prepare("large.bin", large, "v3", 3, "file-large");
  assert.equal(prepared.record.storage, "chunked");
  f.records = [{ ...prepared.record, path: "large.bin" }];
  f.objects.clear();
  for (const part of prepared.files) f.objects.set(part.path, part.bytes);
  const source = await inputOf(f);
  const verified = await verifyV4ReencryptionSourceObjects(source);
  assert.equal(verified.verifiedFileCount, 1);
  assert.equal(verified.verifiedRemoteObjectCount, 2);
  assert.equal(verified.totalVerifiedPlaintextBytes, String(large.byteLength));
  const partPath = prepared.files[1]!.path;
  const damaged = f.objects.get(partPath)!;
  f.objects.set(partPath, Uint8Array.from(damaged, (v, i) => i === damaged.length - 1 ? v ^ 1 : v));
  await assert.rejects(async () => verifyV4ReencryptionSourceObjects(await inputOf(f)), /decrypt|auth|integrity/i);
});

test("D69 honors cancellation and never signals completion after interruption", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("cancel migration verification"));
  const input = await inputOf(f);
  await assert.rejects(
    () => verifyV4ReencryptionSourceObjects({ ...input, signal: controller.signal }),
    /cancel migration verification/i,
  );
  assert.equal(input.reads, 0);
});
