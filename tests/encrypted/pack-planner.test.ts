import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { ENCRYPTED_PACK_MAX_FILES, ENCRYPTED_PACK_PLAINTEXT_BYTES } from "../../src/lib/encrypted/constants";
import { decodePackArchive, encodePackArchive, estimateEncryptedPackPayloadBytes, packObjectPathForId } from "../../src/lib/encrypted/pack-format";
import { planEncryptedPacks } from "../../src/lib/encrypted/pack-planner";
import { chooseEncryptedStorageMode } from "../../src/lib/encrypted/scale-policy";
import { deriveEncryptionKey } from "../../src/lib/encrypted/crypto";
import { sha256Hex } from "../../src/lib/encrypted/bytes";
import { uploadEncryptedPack, downloadEncryptedPack } from "../../src/lib/encrypted/pack-sync";
import { uploadEncryptedFileObject } from "../../src/lib/encrypted/large-objects";
import type { GitHubClient } from "../../src/lib/github-api";
import type { EncryptedObjectRecord, EncryptedRepoConfig } from "../../src/lib/encrypted/types";

const FIVE_GIB = 5 * 1024 * 1024 * 1024;

function virtualFiles(count: number, totalBytes: number) {
  const baseSize = Math.floor(totalBytes / count);
  let remainder = totalBytes - baseSize * count;
  return Array.from({ length: count }, (_, index) => {
    const size = baseSize + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return {
      path: `Folder${String(Math.floor(index / 1000)).padStart(3, "0")}/note-${String(index).padStart(6, "0")}.md`,
      size,
      mtime: 1_800_000_000_000 + index,
    };
  });
}

test("pack planner handles 100,000 files totaling 5 GiB without oversized shards", () => {
  const files = virtualFiles(100_000, FIVE_GIB);
  const start = performance.now();
  const plan = planEncryptedPacks(files);
  const elapsed = performance.now() - start;

  assert.equal(plan.totalFiles, 100_000);
  assert.equal(plan.totalBytes, FIVE_GIB);
  assert.equal(plan.packs.flatMap(pack => pack.files).length, 100_000);
  assert.ok(plan.packs.length > 100, "5 GiB should be split into many bounded packs");
  assert.ok(plan.packs.length < 250, `unexpectedly high pack count: ${plan.packs.length}`);
  assert.ok(elapsed < 1_500, `100k pack planning took ${elapsed}ms`);

  for (const pack of plan.packs) {
    assert.ok(pack.totalBytes <= ENCRYPTED_PACK_PLAINTEXT_BYTES, `pack ${pack.id} is too large`);
    assert.ok(pack.files.length <= ENCRYPTED_PACK_MAX_FILES, `pack ${pack.id} has too many files`);
  }
});

test("pack planner accounts for archive metadata and encrypted upload size", () => {
  const longName = "x".repeat(220);
  const files = Array.from({ length: 10 }, (_, index) => ({
    path: `VeryLongFolder/${longName}-${String(index).padStart(2, "0")}.md`,
    size: 100,
    mtime: 1_800_000_000_000 + index,
  }));

  const plan = planEncryptedPacks(files, { maxPackBytes: 1_024, maxFilesPerPack: 10 });

  assert.ok(plan.packs.length > 1, "metadata overhead should split the pack before GitHub rejects it");
  for (const pack of plan.packs) {
    assert.ok(estimateEncryptedPackPayloadBytes(pack.files) <= 1_024, `pack ${pack.id} upload payload is too large`);
  }
});
test("pack planning is deterministic and uses opaque pack object paths", () => {
  const files = [
    { path: "b.md", size: 10, mtime: 2 },
    { path: "a.md", size: 10, mtime: 1 },
  ];

  const first = planEncryptedPacks(files, { maxFilesPerPack: 1 });
  const second = planEncryptedPacks([...files].reverse(), { maxFilesPerPack: 1 });

  assert.deepEqual(first, second);
  assert.equal(first.packs.map(pack => pack.files[0].path).join(","), "a.md,b.md");
  assert.equal(packObjectPathForId(first.packs[0].id), `.obsidian-github-sync-encrypted/packs/${first.packs[0].id}.pack.enc`);
});

test("scale policy selects pack mode for large file counts or large total size", () => {
  assert.equal(chooseEncryptedStorageMode({ fileCount: 100, totalBytes: 1024 }), "object");
  assert.equal(chooseEncryptedStorageMode({ fileCount: 100_000, totalBytes: 1024 }), "pack");
  assert.equal(chooseEncryptedStorageMode({ fileCount: 100, totalBytes: FIVE_GIB }), "pack");
});

test("pack archive round trips binary file entries without base64-in-json expansion", () => {
  const files = [
    { path: "Notes/a.md", mtime: 1, bytes: new TextEncoder().encode("hello") },
    { path: "Images/pixel.bin", mtime: 2, bytes: new Uint8Array([0, 255, 1, 254]) },
  ];

  const archive = encodePackArchive(files);
  const decoded = decodePackArchive(archive);

  assert.equal(archive.byteLength < 256, true);
  assert.equal(decoded.length, files.length);
  assert.equal(decoded[0].path, "Images/pixel.bin");
  assert.deepEqual(decoded[0].bytes, files[1].bytes);
  assert.equal(decoded[1].path, "Notes/a.md");
  assert.equal(new TextDecoder().decode(decoded[1].bytes), "hello");
});

class PackMemoryGitHub {
  blobs = new Map<string, { content: string; sha: string }>();
  counter = 0;
  deletedPaths: string[] = [];

  async putFile(path: string, content: string) {
    const sha = `pack-sha-${++this.counter}`;
    this.blobs.set(path, { content: Buffer.from(content, "utf8").toString("base64"), sha });
    return sha;
  }

  async getFile(path: string) {
    const item = this.blobs.get(path);
    if (!item) return null;
    return { path, content: item.content, sha: item.sha, size: item.content.length };
  }

  async deleteFile(path: string) {
    this.deletedPaths.push(path);
    this.blobs.delete(path);
  }
}

async function testPackKey() {
  const config: EncryptedRepoConfig = {
    formatVersion: 1,
    indexMode: "single",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1, salt: "test-salt" },
    createdAt: 1,
    updatedAt: 1,
  };
  return deriveEncryptionKey("pack-password", config);
}

test("encrypted pack upload and download round trip a whole shard", async () => {
  const github = new PackMemoryGitHub();
  const key = await testPackKey();
  const files = [
    { path: "Notes/a.md", mtime: 1, bytes: new TextEncoder().encode("alpha") },
    { path: "Notes/b.md", mtime: 2, bytes: new Uint8Array([1, 2, 3, 4]) },
  ];

  const record = await uploadEncryptedPack(github as unknown as GitHubClient, key, "000001", files);
  assert.equal(github.blobs.size, 1);
  assert.equal(record.objectPath, ".obsidian-github-sync-encrypted/packs/000001.pack.enc");
  assert.equal(record.fileCount, 2);

  const restored = await downloadEncryptedPack(github as unknown as GitHubClient, key, record);
  assert.equal(restored.length, 2);
  assert.equal(new TextDecoder().decode(restored.find(file => file.path === "Notes/a.md")?.bytes), "alpha");
  assert.deepEqual(restored.find(file => file.path === "Notes/b.md")?.bytes, new Uint8Array([1, 2, 3, 4]));
});

test("pack archive detects corrupted file bytes with per-file hashes", async () => {
  const bytes = new TextEncoder().encode("original");
  const archive = encodePackArchive([{ path: "Notes/a.md", mtime: 1, bytes, plaintextSha256: await sha256Hex(bytes) }]);
  archive[archive.byteLength - 1] ^= 0xff;

  assert.throws(() => decodePackArchive(archive), /integrity check failed/u);
});

test("encrypted pack download reports missing remote pack", async () => {
  const github = new PackMemoryGitHub();
  const key = await testPackKey();

  await assert.rejects(
    () => downloadEncryptedPack(github as unknown as GitHubClient, key, { id: "missing", objectPath: ".obsidian-github-sync-encrypted/packs/missing.pack.enc", totalBytes: 1, fileCount: 1, updatedAt: 1 }),
    /Missing encrypted pack/u,
  );
});


test("large object upload removes stale chunks when a chunked file shrinks to a single object", async () => {
  const github = new PackMemoryGitHub();
  const key = await testPackKey();
  const existing: EncryptedObjectRecord = {
    id: "abcdef1234567890abcdef12",
    path: "Notes/large.bin",
    objectPath: ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef1234567890abcdef12.enc",
    plaintextSha256: "0".repeat(64),
    size: 100,
    mtime: 1,
    storage: "chunked",
    chunks: [
      { index: 1, path: ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef1234567890abcdef12.parts/000001.enc", remoteSha: "sha-1" },
      { index: 2, path: ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef1234567890abcdef12.parts/000002.enc", remoteSha: "sha-2" },
    ],
  };
  for (const chunk of existing.chunks ?? []) github.blobs.set(chunk.path, { content: "old", sha: chunk.remoteSha ?? "old" });

  const uploaded = await uploadEncryptedFileObject(github as unknown as GitHubClient, key, existing.id, new TextEncoder().encode("small"), existing);

  assert.equal(uploaded.storage, "single");
  assert.deepEqual(github.deletedPaths.sort(), (existing.chunks ?? []).map(chunk => chunk.path).sort());
  for (const chunk of existing.chunks ?? []) assert.equal(github.blobs.has(chunk.path), false);
});
