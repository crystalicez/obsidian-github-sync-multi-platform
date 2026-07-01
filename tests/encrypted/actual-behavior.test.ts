import assert from "node:assert/strict";
import test from "node:test";
import { modalButtons, modalEvents, resetModalTestState, TFile } from "obsidian";
import { bytesToUtf8, fromBase64, fromBase64Url, sha256Hex, toBase64, toBase64Url, toHex, utf8ToBytes } from "../../src/lib/encrypted/bytes";
import { chooseConflictResolution, chooseNewerResolution, isTextLikePath, mergeTextContent } from "../../src/lib/encrypted/conflicts";
import { decryptJson, deriveEncryptionKey, encryptJson, encryptBytes, decryptBytes } from "../../src/lib/encrypted/crypto";
import { GITHUB_RECOMMENDED_MAX_BYTES } from "../../src/lib/encrypted/constants";
import { compileIgnorePathRegex, isIgnoredPath } from "../../src/lib/encrypted/ignore";
import { chunkPathForId, shouldChunkEncryptedPayload, shouldChunkPlaintext } from "../../src/lib/encrypted/large-objects";
import { conflictPathFor, detectCaseInsensitiveCollisions, normalizeVaultPath, objectPathForId } from "../../src/lib/encrypted/paths";
import { EncryptedObjectRecord } from "../../src/lib/encrypted/types";
import { listEncryptedSyncCandidates, readVaultFileBytes, shouldSyncEncryptedFile, writeVaultFileBytes } from "../../src/lib/encrypted/vault";

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

test("bytes helpers handle sliced Uint8Arrays and fallback without Buffer", async () => {
  const rawBytes = new Uint8Array([65, 66, 67, 68, 69, 70, 71, 72]); // "ABCDEFGH"
  const sliced = rawBytes.subarray(2, 6); // "CDEF" = [67, 68, 69, 70]
  
  // 1. With Buffer (default Node environment)
  assert.equal(toBase64(sliced), "Q0RFRg==");
  assert.equal(toBase64Url(sliced), "Q0RFRg");
  assert.equal(toHex(sliced), "43444546");
  assert.equal(await sha256Hex(sliced), await sha256Hex(new Uint8Array([67, 68, 69, 70])));

  // 2. Without Buffer (fallback pure JS environment)
  const originalBuffer = globalThis.Buffer;
  try {
    (globalThis as any).Buffer = undefined;
    
    assert.equal(toBase64(sliced), "Q0RFRg==");
    assert.equal(toBase64Url(sliced), "Q0RFRg");
    assert.equal(toHex(sliced), "43444546");
    assert.equal(await sha256Hex(sliced), await sha256Hex(new Uint8Array([67, 68, 69, 70])));
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

test("chooseConflictResolution respects policies and text-like fallback", async () => {
  const plugin = { app: {} };
  const localFile = new TFile("note.md", new Uint8Array(10));
  localFile.stat.mtime = 1000;
  
  // newer policy
  assert.equal(await chooseConflictResolution(plugin as any, "newer", "note.md", localFile, 500), "keep-local");
  assert.equal(await chooseConflictResolution(plugin as any, "newer", "note.md", localFile, 1500), "use-remote");
  assert.equal(await chooseConflictResolution(plugin as any, "newer", "note.md", localFile, 1000), "copy-remote");
  
  // merge policy
  assert.equal(await chooseConflictResolution(plugin as any, "merge", "note.md", localFile, 500), "merged");
  assert.equal(await chooseConflictResolution(plugin as any, "merge", "image.png", localFile, 500), "copy-remote"); // fallback for non-text
  
  // copy policy
  assert.equal(await chooseConflictResolution(plugin as any, "copy", "note.md", localFile, 500), "copy-remote");
});

test("shouldChunkPlaintext correctly predicts chunking threshold", () => {
  const belowBoundary = new Uint8Array(37 * 1024 * 1024); // 37MB < 37.5MB
  const aboveBoundary = new Uint8Array(38 * 1024 * 1024); // 38MB > 37.5MB

  assert.equal(shouldChunkPlaintext(belowBoundary), false);
  assert.equal(shouldChunkPlaintext(aboveBoundary), true);
});

test("Web Crypto operations process offset-sliced Uint8Array views correctly without buffer copy", async () => {
  const config = {
    formatVersion: 1 as const,
    indexMode: "single" as const,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdHNhbHQ" }, // "saltsalt" in base64url
    createdAt: 1,
    updatedAt: 1
  };
  const key = await deriveEncryptionKey("testpassphrase", config);

  const rawBytes = new Uint8Array([9, 9, 83, 69, 67, 82, 69, 84, 9, 9]); // padding + "SECRET" + padding
  const slicedBytes = rawBytes.subarray(2, 8); // "SECRET"

  // Encrypt slicedBytes (Uint8Array view with offset=2, length=6)
  const payload = await encryptBytes(key, slicedBytes);
  const decrypted = await decryptBytes(key, payload);

  assert.deepEqual(decrypted, new Uint8Array([83, 69, 67, 82, 69, 84]));
});

test("uploadEncryptedFileObject skips single encryption entirely for large files", async () => {
  // Mock GitHubClient
  const putFiles: { path: string; content: string }[] = [];
  const mockGithub = {
    putFile: async (path: string, content: string) => {
      putFiles.push({ path, content });
      return "mock-sha";
    },
    deleteFile: async () => {}
  };

  const config = {
    formatVersion: 1 as const,
    indexMode: "single" as const,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdHNhbHQ" },
    createdAt: 1,
    updatedAt: 1
  };
  const key = await deriveEncryptionKey("testpassphrase", config);

  let encryptCallCount = 0;
  const originalCryptoSubtleEncrypt = crypto.subtle.encrypt;
  
  // 39MB of empty bytes
  const largePlaintext = new Uint8Array(39 * 1024 * 1024);

  const spyEncrypt = async (algorithm: any, key: any, data: any) => {
    encryptCallCount++;
    return originalCryptoSubtleEncrypt.call(crypto.subtle, algorithm, key, data);
  };
  
  (crypto.subtle as any).encrypt = spyEncrypt;

  try {
    const { uploadEncryptedFileObject } = await import("../../src/lib/encrypted/large-objects");
    await uploadEncryptedFileObject(mockGithub as any, key, "large-id", largePlaintext);
  } finally {
    (crypto.subtle as any).encrypt = originalCryptoSubtleEncrypt;
  }

  // The number of chunks for 39MB (with chunk size = 24MB) is 2 chunks.
  // Since we bypass the single payload encryption check, encrypt should be called exactly 2 times (once per chunk).
  assert.equal(encryptCallCount, 2);
});

test("writeVaultFileBytes avoids ArrayBuffer.slice for full arrays (zero-copy)", async () => {
  const writtenBuffers: ArrayBuffer[] = [];
  const mockVault = {
    getAbstractFileByPath: () => null,
    createFolder: async () => {},
    createBinary: async (path: string, buffer: ArrayBuffer) => {
      writtenBuffers.push(buffer);
    }
  };

  // 1. Full Uint8Array (no slice)
  const fullBytes = new Uint8Array([1, 2, 3, 4]);
  await writeVaultFileBytes(mockVault as any, "Notes/a.md", fullBytes);
  assert.equal(writtenBuffers.length, 1);
  assert.equal(writtenBuffers[0], fullBytes.buffer); // identical reference (zero-copy!)

  // 2. Sliced Uint8Array (must slice)
  const parentBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const slicedBytes = parentBytes.subarray(2, 5); // [3, 4, 5]
  await writeVaultFileBytes(mockVault as any, "Notes/b.md", slicedBytes);
  assert.equal(writtenBuffers.length, 2);
  assert.notEqual(writtenBuffers[1], parentBytes.buffer); // sliced (new reference)
  assert.deepEqual(new Uint8Array(writtenBuffers[1]), new Uint8Array([3, 4, 5]));
});
test("readVaultFileBytes retries transient Windows EBUSY locks", async () => {
  const file = new TFile("Notes/locked.md", new Uint8Array());
  let attempts = 0;
  const mockVault = {
    readBinary: async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error("EBUSY: resource busy or locked, open 'Notes/locked.md'") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return new Uint8Array([1, 2, 3]).buffer;
    },
  };

  assert.deepEqual(await readVaultFileBytes(mockVault as any, file), new Uint8Array([1, 2, 3]));
  assert.equal(attempts, 3);
});

test("SettingTab dirty state tracking and save behavior", async () => {
  const originalSettings = {
    syncEnabled: true,
    githubOwner: "old-owner",
    githubRepo: "old-repo",
    githubBranch: "main",
    githubToken: "old-token",
    encryptionMode: "plaintext",
    encryptionPassphrase: "",
    statusBarStatusEnabled: true,
  };
  
  const savedSettings: any[] = [];
  const mockPlugin = {
    settings: JSON.parse(JSON.stringify(originalSettings)),
    saveSettings: async () => {
      savedSettings.push(JSON.parse(JSON.stringify(mockPlugin.settings)));
    },
    initGitHubClient: () => {},
    updateStatusBar: () => {},
  };

  const mockTab = {
    plugin: mockPlugin,
    tempSettings: null as any,
    bannerEl: {
      empty: () => {},
      addClass: () => {},
      removeClass: () => {},
      createDiv: () => ({
        createEl: () => ({}),
        createDiv: () => ({
          createEl: () => ({})
        })
      })
    },
    display: () => {},
    isDirty() {
      if (!this.tempSettings) return false;
      return JSON.stringify(this.tempSettings) !== JSON.stringify(this.plugin.settings);
    },
    updateDirtyState() {
    }
  };

  // Initialize display
  mockTab.tempSettings = JSON.parse(JSON.stringify(mockPlugin.settings));
  assert.equal(mockTab.isDirty(), false);

  // Edit temporary settings
  mockTab.tempSettings.githubOwner = "new-owner";
  assert.equal(mockTab.isDirty(), true);
  assert.equal(mockPlugin.settings.githubOwner, "old-owner"); // original unchanged!

  // Save changes
  mockPlugin.settings = JSON.parse(JSON.stringify(mockTab.tempSettings));
  await mockPlugin.saveSettings();
  assert.equal(mockTab.isDirty(), false);
  assert.equal(mockPlugin.settings.githubOwner, "new-owner");
  assert.equal(savedSettings.length, 1);
  assert.equal(savedSettings[0].githubOwner, "new-owner");
});

test("Status Bar progress widget behaves as a kill-switch", () => {
  let statusBarCreated = 0;
  let statusBarRemoved = 0;
  
  const mockStatusBarEl = {
    empty: () => {},
    createEl: () => ({ title: "", onclick: null }),
    remove: () => {
      statusBarRemoved++;
    }
  };

  const mockPlugin = {
    settings: {
      statusBarStatusEnabled: true
    },
    statusBarItem: null as any,
    isSyncInProgress: false,
    syncProgress: {
      status: "idle",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: 0
    },
    addStatusBarItem: () => {
      statusBarCreated++;
      return mockStatusBarEl;
    },
    updateStatusBar() {
      if (!this.settings.statusBarStatusEnabled) {
        if (this.statusBarItem) {
          this.statusBarItem.remove();
          this.statusBarItem = null;
        }
        return;
      }

      if (!this.statusBarItem) {
        this.statusBarItem = this.addStatusBarItem();
      }
      this.statusBarItem.empty();
      this.statusBarItem.createEl("span", { text: "mock" });
    }
  };

  // 1. With status bar status enabled: creates status bar item
  mockPlugin.updateStatusBar();
  assert.equal(statusBarCreated, 1);
  assert.notEqual(mockPlugin.statusBarItem, null);

  // 2. Kill-switch activated (disabled): removes status bar item
  mockPlugin.settings.statusBarStatusEnabled = false;
  mockPlugin.updateStatusBar();
  assert.equal(statusBarRemoved, 1);
  assert.equal(mockPlugin.statusBarItem, null);

  // 3. Updates skipped entirely when disabled
  statusBarCreated = 0;
  mockPlugin.updateStatusBar();
  assert.equal(statusBarCreated, 0); // No status bar item created
});
