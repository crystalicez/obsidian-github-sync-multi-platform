import assert from "node:assert/strict";
import test from "node:test";

import { decryptV4Payload, deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { objectIdForV4File, opaqueV4ObjectPath, opaqueV4PackPath } from "../../src/lib/v4/paths";
import { effectiveV4PathLayout, expectedV4PathLayout } from "../../src/lib/v4/protocol-types";

test("v4 keyring is stable for one repository and domain-separated", async () => {
  const salt = new Uint8Array(16).fill(7);
  const first = await deriveV4Keyring({ passphrase: "secret", repoId: "owner/repo#main", salt, iterations: 1_000 });
  const second = await deriveV4Keyring({ passphrase: "secret", repoId: "owner/repo#main", salt, iterations: 1_000 });
  const otherSalt = await deriveV4Keyring({ passphrase: "secret", repoId: "owner/repo#main", salt: new Uint8Array(16).fill(8), iterations: 1_000 });

  assert.deepEqual(first.masterKey, second.masterKey);
  assert.notDeepEqual(first.pathKey, first.contentKey);
  assert.notDeepEqual(first.masterKey, otherSalt.masterKey);
});

test("v4 payload authentication hides bytes and rejects a wrong key", async () => {
  const plaintext = new TextEncoder().encode("private v4 content");
  const key = new Uint8Array(32).fill(1);
  const wrongKey = new Uint8Array(32).fill(2);
  const encrypted = await encryptV4Payload(key, plaintext, { kind: "content", aad: "repo:file:1" });

  assert.equal(new TextDecoder().decode(encrypted).includes("private v4 content"), false);
  assert.deepEqual(await decryptV4Payload(key, encrypted, { kind: "content", aad: "repo:file:1" }), plaintext);
  await assert.rejects(() => decryptV4Payload(wrongKey, encrypted, { kind: "content", aad: "repo:file:1" }));
});

test("v4 encrypted object identity is stable by file identity and repository key", async () => {
  const keyA = new Uint8Array(32).fill(3);
  const keyB = new Uint8Array(32).fill(4);
  const first = await opaqueV4ObjectPath(keyA, "file-1");
  assert.equal(first, await opaqueV4ObjectPath(keyA, "file-1"));
  assert.notEqual(first, await opaqueV4ObjectPath(keyA, "file-2"));
  assert.notEqual(first, await opaqueV4ObjectPath(keyB, "file-1"));
  assert.match(first, /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.doesNotMatch(first, /Projects|Secret|note|\.md/u);
});

test("v4 opaque object identity requires a non-empty file identity", async () => {
  const pathKey = new Uint8Array(32).fill(3);
  await assert.rejects(() => objectIdForV4File(pathKey, ""), /V4 file identity is required/u);
  await assert.rejects(() => opaqueV4ObjectPath(pathKey, ""), /V4 file identity is required/u);
});

test("v4 opaque pack identity is stable, domain-separated, and protocol-shaped", async () => {
  const keyA = new Uint8Array(32).fill(3);
  const keyB = new Uint8Array(32).fill(4);
  const first = await opaqueV4PackPath(keyA, "pack-1");
  const objectPath = await opaqueV4ObjectPath(keyA, "pack-1");

  assert.equal(first, await opaqueV4PackPath(keyA, "pack-1"));
  assert.notEqual(first, await opaqueV4PackPath(keyA, "pack-2"));
  assert.notEqual(first, await opaqueV4PackPath(keyB, "pack-1"));
  assert.notEqual(first.split("/").at(-1), objectPath.split("/").at(-1));
  assert.match(first, /^\.obsidian-github-sync-v4\/packs\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
});

test("v4 path layout distinguishes new plaintext, new encrypted, and legacy encrypted configs", () => {
  assert.equal(expectedV4PathLayout("plaintext"), "plaintext-v1");
  assert.equal(expectedV4PathLayout("encrypted"), "opaque-stable-v1");
  assert.equal(effectiveV4PathLayout({ formatVersion: 4, mode: "encrypted", repoId: "o/r#main" }), "encrypted-folders-v0");
});
