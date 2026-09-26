import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { assertV4RemoteRecordSet, buildV4RemoteMetadata, decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, encodeV4RemoteConfig } from "../../src/lib/v4/remote-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";

const enc = (value: string) => new TextEncoder().encode(value);

test("v4 remote config decoder accepts a valid explicit path layout", () => {
  const config: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  assert.deepEqual(decodeV4RemoteConfig(encodeV4RemoteConfig(config)), config);
});

test("v4 remote config decoder accepts an omitted path layout for legacy detection", () => {
  const config = decodeV4RemoteConfig(enc(JSON.stringify({
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  })));
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

test("v4 encrypted remote metadata does not expose paths and round trips", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: expectedV4PathLayout("encrypted"), algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const head: V4RemoteHead = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", epoch: 1, generation: 2, journalId: "j2", shardHashes: { aa: "a".repeat(64) }, updatedAt: 3, deviceId: "d" };
  const record = { path: "Folder/private.md", pathId: "aa".padEnd(64, "0"), fileId: "f", plaintextSha256: "a".repeat(64), size: 4, mtime: 3, remoteVersion: "v", remotePath: `.obsidian-github-sync-v4/data/aa/${"a".repeat(64)}.enc`, storage: "single" as const };
  const files = await buildV4RemoteMetadata({ config, head, records: [record], keyring: keys });
  const shard = files.find(file => file.path.includes("/index/"))!;
  assert.equal(new TextDecoder().decode(shard.bytes).includes("private.md"), false);
  assert.deepEqual((await decodeV4RemoteShard(shard.bytes, "aa", config, keys)).records[record.pathId], record);
  const headFile = files.find(file => file.path.endsWith("/head"))!;
  assert.deepEqual(await decodeV4RemoteHead(headFile.bytes, config, keys), head);
});

test("v4 remote shard rejects record keys and path ids outside its bucket", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const record = { path: "note.md", pathId: "bb".padEnd(64, "0"), fileId: "f", plaintextSha256: "a".repeat(64), size: 4, mtime: 3, remoteVersion: "v", remotePath: "note.md", storage: "single" as const };
  await assert.rejects(
    () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { ["aa".padEnd(64, "0")]: record } })), "aa", config),
    /path id|bucket|record key/iu,
  );
});

test("v4 remote shard rejects unsafe or non-normalized logical paths", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const record = { path: "Folder\\note.md", pathId, fileId: "f", plaintextSha256: "a".repeat(64), size: 4, mtime: 3, remoteVersion: "v", remotePath: "Folder\\note.md", storage: "single" as const };
  await assert.rejects(
    () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { [pathId]: record } })), "aa", config),
    /normalized|unsafe/iu,
  );
});

test("v4 remote shard rejects inconsistent storage descriptors", async () => {
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const record = { path: "large.bin", pathId, fileId: "f", plaintextSha256: "a".repeat(64), size: 4, mtime: 3, remoteVersion: "v", remotePath: "wrong.part", storage: "chunked" as const, partPaths: [] };
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


test("v4 encrypted remote config rejects unsupported crypto semantics and unsafe KDF parameters", () => {
  const base = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: "c2FsdA" },
  };

  for (const [label, value] of [
    ["algorithm", { ...base, algorithm: "AES-CBC" }],
    ["kdf", { ...base, kdf: "scrypt" }],
    ["zero iterations", { ...base, kdfParams: { ...base.kdfParams, iterations: 0 } }],
    ["fractional iterations", { ...base, kdfParams: { ...base.kdfParams, iterations: 1.5 } }],
    ["above writer iterations", { ...base, kdfParams: { ...base.kdfParams, iterations: 600_001 } }],
    ["unbounded iterations", { ...base, kdfParams: { ...base.kdfParams, iterations: Number.MAX_SAFE_INTEGER } }],
    ["malformed salt", { ...base, kdfParams: { ...base.kdfParams, salt: "***" } }],
    ["oversized salt", { ...base, kdfParams: { ...base.kdfParams, salt: "A".repeat(1024) } }],
  ] as const) {
    assert.throws(
      () => decodeV4RemoteConfig(enc(JSON.stringify(value))),
      /encrypted|algorithm|kdf|iteration|salt|config/iu,
      label,
    );
  }
});

test("v4 remote shard rejects impossible numeric and chunk descriptor workloads before content reads", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const base = {
    path: "large.bin",
    pathId,
    fileId: "f",
    plaintextSha256: "a".repeat(64),
    size: 1,
    mtime: 3,
    remoteVersion: "v1",
    remotePath: ".obsidian-github-sync-v4/large/large.bin/v1/000001.part",
    storage: "chunked" as const,
  };
  const excessiveParts = Array.from({ length: 401 }, (_, index) =>
    `.obsidian-github-sync-v4/large/large.bin/v1/${String(index + 1).padStart(6, "0")}.part`
  );

  for (const [label, record] of [
    ["negative size", { ...base, size: -1, partPaths: [base.remotePath] }],
    ["unsafe size", { ...base, size: Number.MAX_SAFE_INTEGER + 1, partPaths: [base.remotePath] }],
    ["excessive chunk parts", { ...base, size: excessiveParts.length, partPaths: excessiveParts }],
  ] as const) {
    await assert.rejects(
      () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { [pathId]: record } })), "aa", config),
      /size|chunk|part|descriptor|limit|budget/iu,
      label,
    );
  }
});


test("v4 remote records reject missing integrity/version identifiers that the writer never emits", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const pathId = "aa".padEnd(64, "0");
  const base = {
    path: "note.md",
    pathId,
    fileId: "file-a",
    plaintextSha256: "a".repeat(64),
    size: 1,
    mtime: 1,
    remoteVersion: "v1",
    remotePath: "note.md",
    storage: "single" as const,
  };
  for (const [label, record] of [
    ["empty plaintext hash", { ...base, plaintextSha256: "" }],
    ["malformed plaintext hash", { ...base, plaintextSha256: "not-a-sha" }],
    ["empty remote version", { ...base, remoteVersion: "" }],
  ] as const) {
    await assert.rejects(
      () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: "aa", records: { [pathId]: record } })), "aa", config),
      /hash|version|record/iu,
      label,
    );
  }
});


test("v4 remote shard rejects chunk counts outside the writer-compatible size range", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const path = "large.bin";
  const pathId = await sha256Hex(enc(`path:${path}`));
  const version = "v1";
  const partPath = (index: number) => `.obsidian-github-sync-v4/large/large.bin/${version}/${String(index + 1).padStart(6, "0")}.part`;
  const base = {
    path,
    pathId,
    fileId: "f",
    plaintextSha256: "a".repeat(64),
    mtime: 3,
    remoteVersion: version,
    remotePath: partPath(0),
    storage: "chunked" as const,
  };

  const cases = [
    {
      label: "small file cannot claim chunked storage",
      record: { ...base, size: 1, partPaths: Array.from({ length: 400 }, (_, index) => partPath(index)) },
    },
    {
      label: "part count cannot exceed one part per MiB writer minimum",
      record: { ...base, size: 51 * 1024 * 1024, partPaths: Array.from({ length: 100 }, (_, index) => partPath(index)) },
    },
    {
      label: "part count cannot be below 48 MiB writer maximum",
      record: { ...base, size: 97 * 1024 * 1024, partPaths: [partPath(0), partPath(1)] },
    },
  ];

  for (const { label, record } of cases) {
    await assert.rejects(
      () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: pathId.slice(0, 2), records: { [pathId]: record } })), pathId.slice(0, 2), config),
      /chunk|part|writer|size|count/iu,
      label,
    );
  }
});


test("v4 remote records reject local-only cache flags", async () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const path = "Notes/a.md";
  const pathId = await sha256Hex(enc(`path:${path}`));
  const base = {
    path,
    pathId,
    fileId: "file-a",
    plaintextSha256: "a".repeat(64),
    size: 1,
    mtime: 1,
    remoteVersion: "v1",
    remotePath: path,
    storage: "single" as const,
  };

  for (const [label, record] of [
    ["dirty", { ...base, dirty: true }],
    ["deleted", { ...base, deleted: true }],
  ] as const) {
    await assert.rejects(
      () => decodeV4RemoteShard(enc(JSON.stringify({ bucket: pathId.slice(0, 2), records: { [pathId]: record } })), pathId.slice(0, 2), config),
      /local-only|dirty|deleted|remote record/iu,
      label,
    );
  }
});
