import assert from "node:assert/strict";
import test from "node:test";
import { modalButtons, modalEvents, resetModalTestState, TFile } from "obsidian";
import { bytesToUtf8, fromBase64, fromBase64Url, sha256Hex, toBase64, toBase64Url, utf8ToBytes } from "../../src/lib/encrypted/bytes";
import { chooseConflictResolution, chooseNewerResolution, isTextLikePath, mergeTextContent } from "../../src/lib/encrypted/conflicts";
import { GITHUB_RECOMMENDED_MAX_BYTES } from "../../src/lib/encrypted/constants";
import { decryptJson, deriveEncryptionKey, encryptJson } from "../../src/lib/encrypted/crypto";
import { compileIgnorePathRegex, isIgnoredPath } from "../../src/lib/encrypted/ignore";
import { chunkPathForId, shouldChunkEncryptedPayload } from "../../src/lib/encrypted/large-objects";
import { conflictPathFor, detectCaseInsensitiveCollisions, normalizeVaultPath, objectPathForId } from "../../src/lib/encrypted/paths";
import { EncryptedObjectRecord } from "../../src/lib/encrypted/types";
import { listEncryptedSyncCandidates, shouldSyncEncryptedFile } from "../../src/lib/encrypted/vault";

test("bytes helpers round trip UTF-8 and hash deterministically", async () => {
  const bytes = utf8ToBytes("ภาษาไทย/emoji 🚀");
  assert.equal(bytesToUtf8(bytes), "ภาษาไทย/emoji 🚀");
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(await sha256Hex(bytes), await sha256Hex(bytes));
});

test("path helpers preserve plaintext intent and detect collisions", () => {
  assert.equal(normalizeVaultPath("\\โฟลเดอร์//บันทึก 🚀.md"), "โฟลเดอร์/บันทึก 🚀.md");
  assert.deepEqual(detectCaseInsensitiveCollisions(["Note.md", "folder/ok.md", "note.md"]), [["Note.md", "note.md"]]);
  assert.equal(objectPathForId("abcdef123456").includes("abcdef123456.enc"), true);
  assert.equal(conflictPathFor("Folder/Note.md", Date.UTC(2026, 0, 2, 3, 4, 5), "remote"), "Folder/Note.sync-conflict-20260102T030405Z-remote.md");
});

test("ignore regex applies to normalized plaintext paths only", () => {
  const rules = compileIgnorePathRegex("# comments allowed\n^Archive/\n(^|/)\\.DS_Store$\n\\.tmp$");
  assert.equal(isIgnoredPath("Archive/old.md", rules), true);
  assert.equal(isIgnoredPath("Nested/.DS_Store", rules), true);
  assert.equal(isIgnoredPath("note.tmp", rules), true);
  assert.equal(isIgnoredPath("Notes/note.md", rules), false);
});

test("conflict helpers choose deterministic policies", () => {
  assert.equal(isTextLikePath("board.canvas"), true);
  assert.equal(isTextLikePath("image.png"), false);
  assert.equal(chooseNewerResolution(20, 10), "keep-local");
  assert.equal(chooseNewerResolution(10, 20), "use-remote");
  assert.equal(chooseNewerResolution(10, 10), "copy-remote");
  assert.match(mergeTextContent("local", "remote"), /<<<<<<< remote encrypted sync version/u);
});

test("large object helpers use stable chunk paths and threshold", () => {
  assert.equal(chunkPathForId("abcdef123456", 1), ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef123456.parts/000001.enc");
  assert.equal(shouldChunkEncryptedPayload("x".repeat(GITHUB_RECOMMENDED_MAX_BYTES)), false);
  assert.equal(shouldChunkEncryptedPayload("x".repeat(GITHUB_RECOMMENDED_MAX_BYTES + 1)), true);
});

test("crypto JSON helpers authenticate with the derived key", async () => {
  const config = {
    formatVersion: 1,
    indexMode: "single",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1, salt: toBase64Url(utf8ToBytes("1234567890123456")) },
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const key = await deriveEncryptionKey("passphrase", config);
  const encrypted = await encryptJson(key, { ok: true });
  assert.deepEqual(await decryptJson(key, encrypted), { ok: true });
});

test("vault helpers filter ignored, internal, conflict, and oversized files", () => {
  const rules = compileIgnorePathRegex("^Ignored/");
  assert.equal(shouldSyncEncryptedFile(new TFile("Ignored/a.md", new Uint8Array()), rules), false);
  assert.equal(shouldSyncEncryptedFile(new TFile(".obsidian-github-sync-encrypted/config.json", new Uint8Array()), rules), false);
  assert.equal(shouldSyncEncryptedFile(new TFile("note.sync-conflict-20260101.md", new Uint8Array()), rules), false);
  assert.equal(shouldSyncEncryptedFile(new TFile("Notes/a.md", new Uint8Array()), rules), true);

  const vault = { getFiles: () => [new TFile("Notes/a.md", new Uint8Array()), new TFile("Ignored/a.md", new Uint8Array())] };
  assert.deepEqual(listEncryptedSyncCandidates(vault as never, rules).map(file => file.path), ["Notes/a.md"]);
});

test("encrypted object record type accepts chunk metadata", () => {
  const record: EncryptedObjectRecord = {
    id: "id",
    path: "large.bin",
    objectPath: ".obsidian-github-sync-encrypted/objects/id.enc",
    plaintextSha256: "hash",
    storage: "chunked",
    chunks: [{ index: 1, path: "part", remoteSha: "sha" }],
    size: 1,
    mtime: 1,
  };
  assert.equal(record.chunks?.[0].index, 1);
});


test("ask conflict policy queues modals instead of opening stacked dialogs", async () => {
  resetModalTestState();
  const plugin = { app: {} };
  const localFile = new TFile("Notes/a.md", new TextEncoder().encode("local"));

  const first = chooseConflictResolution(plugin as never, "ask", "Notes/a.md", localFile, Date.now());
  const second = chooseConflictResolution(plugin as never, "ask", "Notes/b.md", localFile, Date.now());
  await Promise.resolve();

  assert.equal(modalEvents.filter(event => event === "open").length, 1);
  modalButtons.find(button => button.text === "Copy remote")?.click();
  assert.equal(await first, "copy-remote");
  await Promise.resolve();
  assert.equal(modalEvents.filter(event => event === "open").length, 2);
  modalButtons.filter(button => button.text === "Keep local").at(-1)?.click();
  assert.equal(await second, "keep-local");
});


test("encrypted sync candidates allow files large enough to require chunking", () => {
  const file = new TFile("Media/big.bin", new Uint8Array());
  file.stat.size = 120 * 1024 * 1024;
  assert.equal(shouldSyncEncryptedFile(file), true);
});
