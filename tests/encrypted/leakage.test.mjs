import assert from "node:assert/strict";
import test from "node:test";

test("remote object path does not contain plaintext path", () => {
  const plaintextPath = "โฟลเดอร์/private note.md";
  const opaqueId = "00112233445566778899aabbccddeeff0011223344556677";
  const objectPath = `.obsidian-github-sync-encrypted/objects/${opaqueId.slice(0, 2)}/${opaqueId.slice(2, 4)}/${opaqueId}.enc`;
  assert.equal(objectPath.includes("private"), false);
  assert.equal(objectPath.includes("โฟลเดอร์"), false);
  assert.equal(objectPath.includes(plaintextPath), false);
});
