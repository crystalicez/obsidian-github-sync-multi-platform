import assert from "node:assert/strict";
import test from "node:test";

import { decryptV4Payload, deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { encryptedV4RemotePath, normalizeV4VaultPath, pathIdForV4Path } from "../../src/lib/v4/paths";
import { V4_FORMAT_VERSION, V4_ROOT } from "../../src/lib/v4/protocol-types";

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

test("v4 encrypted remote paths preserve folders but hide basenames", async () => {
  const pathKey = new Uint8Array(32).fill(3);
  const path = normalizeV4VaultPath("\\Projects\\Secret Note.md");
  const pathId = await pathIdForV4Path(pathKey, path);
  const remotePath = await encryptedV4RemotePath(pathKey, path);

  assert.equal(path, "Projects/Secret Note.md");
  assert.match(pathId, /^[0-9a-f]{64}$/u);
  assert.equal(remotePath.startsWith(`${V4_ROOT}/data/Projects/`), true);
  assert.equal(remotePath.includes("Secret Note"), false);
  assert.match(remotePath.split("/").at(-1) ?? "", /^[A-Za-z0-9_-]{32}\.enc$/u);
  assert.equal(V4_FORMAT_VERSION, 4);
});
