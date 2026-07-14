import assert from "node:assert/strict";
import test from "node:test";

import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { buildV4RemoteMetadata, decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, encodeV4RemoteConfig } from "../../src/lib/v4/remote-index";
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

test("v4 encrypted remote metadata does not expose paths and round trips", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: expectedV4PathLayout("encrypted"), algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const head: V4RemoteHead = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", epoch: 1, generation: 2, journalId: "j2", shardHashes: { aa: "h" }, updatedAt: 3, deviceId: "d" };
  const record = { path: "Folder/private.md", pathId: "aa".padEnd(64, "0"), fileId: "f", plaintextSha256: "hash", size: 4, mtime: 3, remoteVersion: "v", remotePath: "opaque", storage: "single" as const };
  const files = await buildV4RemoteMetadata({ config, head, records: [record], keyring: keys });
  const shard = files.find(file => file.path.includes("/index/"))!;
  assert.equal(new TextDecoder().decode(shard.bytes).includes("private.md"), false);
  assert.deepEqual((await decodeV4RemoteShard(shard.bytes, "aa", config, keys)).records[record.pathId], record);
  const headFile = files.find(file => file.path.endsWith("/head"))!;
  assert.deepEqual(await decodeV4RemoteHead(headFile.bytes, config, keys), head);
});
