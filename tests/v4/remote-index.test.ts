import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { assertV4RemoteRecordSet, buildV4RemoteMetadata, decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, encodeV4RemoteConfig } from "../../src/lib/v4/remote-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";

const enc = (value: string) => new TextEncoder().encode(value);

test("v4 remote config decoder accepts a valid explicit path layout", () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1" };
  assert.deepEqual(decodeV4RemoteConfig(encodeV4RemoteConfig(config)), config);
});

test("v4 remote config decoder accepts an omitted path layout for legacy detection", () => {
  const config = decodeV4RemoteConfig(enc(JSON.stringify({ formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main" })));
  assert.equal(config.pathLayout, undefined);
});

test("v4 remote config decoder rejects an unknown path layout", () => {
  const bytes = enc(JSON.stringify({ formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "unknown-v1" }));
  assert.throws(() => decodeV4RemoteConfig(bytes), /Unsupported V4 path layout/u);
});

test("v4 remote config decoder rejects an explicitly serialized legacy sentinel", () => {
  const bytes = enc(JSON.stringify({ formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "encrypted-folders-v0" }));
  assert.throws(() => decodeV4RemoteConfig(bytes), /Unsupported V4 path layout/u);
});

test("D64 remote KDF salt accepts canonical 64-byte input but rejects unsafe or aliased encodings", () => {
  const base = {
    formatVersion: 4, mode: "encrypted", repoId: "o/r#main",
    pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: "c2FsdA" },
  };
  const maxSalt = toBase64Url(new Uint8Array(64).fill(0x5a));
  assert.equal(decodeV4RemoteConfig(enc(JSON.stringify({
    ...base, kdfParams: { ...base.kdfParams, salt: maxSalt },
  }))).kdfParams?.salt, maxSalt);
  for (const [label, salt] of [
    ["65-byte salt", toBase64Url(new Uint8Array(65).fill(0x5a))],
    ["non-canonical trailing bits", "c2FsdB"],
    ["non-canonical single-byte salt", "AB"],
    ["long-but-metadata-bounded remote salt", "A".repeat(1_000)],
  ] as const) {
    assert.throws(
      () => decodeV4RemoteConfig(enc(JSON.stringify({
        ...base, kdfParams: { ...base.kdfParams, salt },
      }))),
      /KDF|salt|canonical/i,
      label,
    );
  }
});

test("D64 remote config refuses missing or incorrectly typed repository identity", () => {
  for (const repoId of [undefined, null, "", 0, [], { name: "owner/repo#main" }]) {
    assert.throws(
      () => decodeV4RemoteConfig(enc(JSON.stringify({
        formatVersion: 4, mode: "plaintext", repoId,
      }))),
      /repository|identity|config/i,
      String(repoId),
    );
  }
});

test("D62 remote KDF fields reject malformed types and salt before key derivation", () => {
  const base = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1" };
  const valid = { ...base, algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: "c2FsdA" } };
  assert.deepEqual(decodeV4RemoteConfig(enc(JSON.stringify(valid))), valid);
  assert.deepEqual(decodeV4RemoteConfig(enc(JSON.stringify(base))), base, "legacy encrypted config without KDF fields remains readable");
  const invalid: Array<[string, unknown]> = [
    ["string iteration", { ...valid, kdfParams: { iterations: "600000", salt: "c2FsdA" } }],
    ["zero iteration", { ...valid, kdfParams: { iterations: 0, salt: "c2FsdA" } }],
    ["negative iteration", { ...valid, kdfParams: { iterations: -1, salt: "c2FsdA" } }],
    ["fractional iteration", { ...valid, kdfParams: { iterations: 1.5, salt: "c2FsdA" } }],
    ["unsafe integer iteration", { ...valid, kdfParams: { iterations: Number.MAX_SAFE_INTEGER + 1, salt: "c2FsdA" } }],
    ["missing iteration", { ...valid, kdfParams: { salt: "c2FsdA" } }],
    ["null salt", { ...valid, kdfParams: { iterations: 600_000, salt: null } }],
    ["array salt", { ...valid, kdfParams: { iterations: 600_000, salt: ["c2FsdA"] } }],
    ["empty salt", { ...valid, kdfParams: { iterations: 600_000, salt: "" } }],
    ["malformed base64url salt", { ...valid, kdfParams: { iterations: 600_000, salt: "a?" } }],
    ["impossible base64url length", { ...valid, kdfParams: { iterations: 600_000, salt: "a" } }],
    ["null KDF params", { ...valid, kdfParams: null }],
    ["array KDF params", { ...valid, kdfParams: [] }],
    ["wrong KDF algorithm", { ...valid, kdf: "SHA-1" }],
    ["wrong cipher algorithm", { ...valid, algorithm: "AES-CBC" }],
  ];
  for (const [label, config] of invalid) {
    assert.throws(
      () => decodeV4RemoteConfig(enc(JSON.stringify(config))),
      /invalid V4 remote KDF|unsupported V4 encryption/i,
      label,
    );
  }
});

test("D63 remote PBKDF2 iteration cap rejects expensive configs without rewriting stored values", () => {
  const base = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main",
    kdfParams: { iterations: 1_200_000, salt: "c2FsdA" } };
  assert.equal(decodeV4RemoteConfig(enc(JSON.stringify(base))).kdfParams?.iterations, 1_200_000);
  const high = { ...base, kdfParams: { ...base.kdfParams, iterations: 1_200_001 } };
  assert.throws(() => decodeV4RemoteConfig(enc(JSON.stringify(high))), /PBKDF2|KDF|maximum|limit/i);
  const lowLegacy = { ...base, kdfParams: { ...base.kdfParams, iterations: 10 } };
  assert.equal(decodeV4RemoteConfig(enc(JSON.stringify(lowLegacy))).kdfParams?.iterations, 10,
    "legacy values below the new-setting minimum must still be readable");
});

test("D63 direct PBKDF2 key derivation rejects over-cap iterations before crypto work", async () => {
  await assert.rejects(
    () => deriveV4Keyring({ passphrase: "synthetic", repoId: "o/r#main", salt: enc("salt"), iterations: 1_200_001 }),
    /PBKDF2|iterations|maximum|limit/i,
  );
});

test("v4 encrypted remote metadata does not expose paths and round trips", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: expectedV4PathLayout("encrypted"), algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const head: V4RemoteHead = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", epoch: 1, generation: 2, journalId: "j2", shardHashes: { aa: "h" }, updatedAt: 3, deviceId: "d" };
  const record = { path: "Folder/private.md", pathId: "aa".padEnd(64, "0"), fileId: "f", plaintextSha256: "hash", size: 4, mtime: 3, remoteVersion: "v", remotePath: `.obsidian-github-sync-v4/data/aa/${"a".repeat(64)}.enc`, storage: "single" as const };
  const files = await buildV4RemoteMetadata({ config, head, records: [record], keyring: keys });
  const shard = files.find(file => file.path.includes("/index/"))!;
  assert.equal(new TextDecoder().decode(shard.bytes).includes("private.md"), false);
  assert.deepEqual((await decodeV4RemoteShard(shard.bytes, "aa", config, keys)).records[record.pathId], record);
  const headFile = files.find(file => file.path.endsWith("/head"))!;
  assert.deepEqual(await decodeV4RemoteHead(headFile.bytes, config, keys), head);
});

test("v4 remote head rejects malformed generation and shard coordinates before sync", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "plaintext", epoch: 0, generation: 1,
    journalId: "j1", shardHashes: { ab: "legacy-hash-label" }, updatedAt: 1, deviceId: "device",
  };
  assert.deepEqual(await decodeV4RemoteHead(enc(JSON.stringify(head)), config), head);
  const invalid: Array<[string, unknown]> = [
    ["null head", null],
    ["missing generation", { ...head, generation: undefined }],
    ["null generation", { ...head, generation: null }],
    ["fractional generation", { ...head, generation: 1.5 }],
    ["negative generation", { ...head, generation: -1 }],
    ["unsafe generation", { ...head, generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid epoch", { ...head, epoch: "1" }],
    ["null shard hashes", { ...head, shardHashes: null }],
    ["array shard hashes", { ...head, shardHashes: [] }],
    ["invalid bucket name", { ...head, shardHashes: { zz: "hash" } }],
    ["invalid shard hash", { ...head, shardHashes: { ab: 5 } }],
    ["missing journal ID", { ...head, journalId: undefined }],
    ["invalid timestamp", { ...head, updatedAt: "yesterday" }],
    ["invalid device ID", { ...head, deviceId: null }],
  ];
  for (const [label, value] of invalid) {
    await assert.rejects(
      () => decodeV4RemoteHead(enc(JSON.stringify(value)), config),
      /invalid V4 remote head/i, label,
    );
  }
});

test("v4 remote shard rejects record keys and path ids outside its bucket", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const record = { path: "note.md", pathId: "bb".padEnd(64, "0"), fileId: "f", plaintextSha256: "hash", size: 4, mtime: 3, remoteVersion: "v", remotePath: "note.md", storage: "single" as const };
  await assert.rejects(
    () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { ["aa".padEnd(64, "0")]: record } })), "aa", config),
    /path id|bucket|record key/iu,
  );
});

test("v4 remote shard rejects unsafe or non-normalized logical paths", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const record = { path: "Folder\\note.md", pathId, fileId: "f", plaintextSha256: "hash", size: 4, mtime: 3, remoteVersion: "v", remotePath: "Folder\\note.md", storage: "single" as const };
  await assert.rejects(
    () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { [pathId]: record } })), "aa", config),
    /normalized|unsafe/iu,
  );
});

test("v4 remote shard rejects inconsistent storage descriptors", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const record = { path: "large.bin", pathId, fileId: "f", plaintextSha256: "hash", size: 4, mtime: 3, remoteVersion: "v", remotePath: "wrong.part", storage: "chunked" as const, partPaths: [] };
  await assert.rejects(
    () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { [pathId]: record } })), "aa", config),
    /chunked|storage|parts/iu,
  );
});

test("v4 complete remote record validation rejects duplicate logical paths", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const path = "duplicate.md";
  const pathId = await sha256Hex(enc(`path:${path}`));
  const base = { path, pathId, plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v", remotePath: path, storage: "single" as const };
  await assert.rejects(() => assertV4RemoteRecordSet([{ ...base, fileId: "first" }, { ...base, fileId: "second" }], config), /duplicate.*path/iu);
});

test("v4 complete remote record validation rejects pathId not derived from logical path", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const record = { path: "note.md", pathId: "ff".repeat(32), fileId: "file", plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v", remotePath: "note.md", storage: "single" as const };
  await assert.rejects(() => assertV4RemoteRecordSet([record], config), /path.*id|logical path/iu);
});
