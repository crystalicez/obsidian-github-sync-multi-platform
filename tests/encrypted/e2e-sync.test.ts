import assert from "node:assert/strict";
import test from "node:test";
import { Notice, TFile } from "obsidian";
import { encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "../../src/lib/encrypted/sync-engine";
import { NoteModify } from "../../src/lib/fs";
import { GitHubClient } from "../../src/lib/github-api";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";

class MemoryGitHub {
  blobs = new Map<string, { content: string; sha: string }>();
  counter = 0;
  putCounts = new Map<string, number>();

  async getTree() {
    return {
      sha: "tree",
      url: "",
      truncated: false,
      tree: [...this.blobs.entries()].map(([path, value]) => ({ path, mode: "100644", type: "blob" as const, sha: value.sha, url: "" })),
    };
  }

  async getFile(path: string) {
    const item = this.blobs.get(path);
    if (!item) return null;
    return { content: item.content, sha: item.sha, path, size: item.content.length };
  }

  async putFile(path: string, content: string | ArrayBuffer, _sha?: string) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha = `sha-${++this.counter}`;
    this.putCounts.set(path, (this.putCounts.get(path) ?? 0) + 1);
    this.blobs.set(path, { content: base64, sha });
    return sha;
  }

  async deleteFile(path: string) {
    this.blobs.delete(path);
  }
}

class MemoryVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  readBinaryCount = 0;
  getFilesCount = 0;

  constructor(entries: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(entries)) this.set(path, new TextEncoder().encode(content));
  }

  set(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
    this.mtimes.set(path, Date.now());
  }

  getFiles() {
    this.getFilesCount += 1;
    return [...this.files.entries()].map(([path, bytes]) => {
      const file = new TFile(path, bytes);
      file.stat.mtime = this.mtimes.get(path) ?? Date.now();
      return file;
    });
  }

  getAbstractFileByPath(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    const file = new TFile(path, bytes);
    file.stat.mtime = this.mtimes.get(path) ?? Date.now();
    return file;
  }

  async readBinary(file: TFile) {
    this.readBinaryCount += 1;
    return this.files.get(file.path)?.buffer.slice(0) ?? new ArrayBuffer(0);
  }

  async read(file: TFile) {
    return new TextDecoder().decode(this.files.get(file.path) ?? new Uint8Array());
  }

  async createFolder(_path: string) {}
  async createBinary(path: string, buffer: ArrayBuffer) { this.set(path, new Uint8Array(buffer)); }
  async modifyBinary(file: TFile, buffer: ArrayBuffer) { this.set(file.path, new Uint8Array(buffer)); }
  async delete(file: TFile) { this.files.delete(file.path); }
}

function plugin(vault: MemoryVault, github: MemoryGitHub) {
  return {
    app: { vault },
    githubClient: github as unknown as GitHubClient,
    settings: {
      encryptionMode: "encrypted",
      syncEnabled: true,
      syncOnLocalChange: true,
      encryptionPassphrase: "correct horse battery staple",
      ignorePathRegex: "",
      conflictPolicy: "copy",
    },
    syncData: { files: {}, encrypted: { files: {} } },
    isSyncInProgress: false,
    isWatchEnabled: true,
    debounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    ignoredFiles: new Set<string>(),
    disableWatch() {},
    enableWatch() {},
    addIgnoredFile(_path: string) {},
    removeIgnoredFile(_path: string) {},
    async saveSyncData() {},
  };
}


function manyFileEntries(count: number, prefix = "v1"): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < count; index++) entries[`Notes/note-${String(index).padStart(5, "0")}.md`] = `${prefix}-${index}`;
  return entries;
}

async function withMutedConsoleError(run: () => Promise<void>): Promise<void> {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await run();
  } finally {
    console.error = originalConsoleError;
  }
}
test("force push then force pull round trips encrypted vault bytes", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/a.md": "hello encrypted world" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  assert.equal([...github.blobs.keys()].some(path => path.includes("Notes/a.md")), false);
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/config.json"), true);
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/manifest.enc"), true);

  const targetVault = new MemoryVault({ "local-only.md": "delete me" });
  await encryptedForcePull(plugin(targetVault, github) as never);

  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "hello encrypted world");
  assert.equal(targetVault.files.has("local-only.md"), false);
});

test("normal encrypted sync skips unchanged file reads and manifest writes", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable content" });
  const instance = plugin(vault, github) as never;

  await encryptedForcePush(instance);
  const manifestPutsAfterInitialPush = github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0;
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance);


  assert.equal(vault.readBinaryCount, 0);
  assert.equal(github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0, manifestPutsAfterInitialPush);
});
test("encrypted local modify pushes only the changed file without scanning the vault", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "old", "Notes/b.md": "stable" });
  const instance = plugin(vault, github) as never;

  await encryptedForcePush(instance);
  vault.set("Notes/a.md", new TextEncoder().encode("new"));
  vault.readBinaryCount = 0;
  vault.getFilesCount = 0;

  const changedFile = vault.getAbstractFileByPath("Notes/a.md") as TFile;
  await encryptedModify(changedFile, instance, true);

  assert.equal(vault.getFilesCount, 0);
  assert.equal(vault.readBinaryCount, 1);
});

test("encrypted sync requires force push after enabling encryption from plaintext mode", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "needs migration" });
  const instance = plugin(vault, github) as never;
  (instance as { settings: { encryptedForcePushRequired?: boolean } }).settings.encryptedForcePushRequired = true;

  await withMutedConsoleError(async () => {
    await encryptedFullSync(instance);
  });
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/manifest.enc"), false);

  await encryptedForcePush(instance);
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/manifest.enc"), true);
  assert.equal((instance as { settings: { encryptedForcePushRequired?: boolean } }).settings.encryptedForcePushRequired, false);
});

test("normal encrypted sync restores changed files from pack mode without writing archive bytes", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "v1"));
  const source = plugin(sourceVault, github) as never;
  await encryptedForcePush(source);

  const targetVault = new MemoryVault({});
  const target = plugin(targetVault, github) as never;
  await encryptedForcePull(target);
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/note-00000.md")), "v1-0");

  sourceVault.set("Notes/note-00000.md", new TextEncoder().encode("v2-0"));
  await encryptedForcePush(source);
  await encryptedFullSync(target);

  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/note-00000.md")), "v2-0");
});

test("encrypted local modify is blocked until force push after enabling encryption", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "needs migration" });
  const instance = plugin(vault, github) as never;
  (instance as { settings: { encryptedForcePushRequired?: boolean } }).settings.encryptedForcePushRequired = true;

  await withMutedConsoleError(async () => {
    await encryptedModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance, true);
  });

  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/manifest.enc"), false);
});

test("force pull refuses pack files whose plaintext hash differs from the manifest", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "hash"));
  const source = plugin(sourceVault, github) as never;
  await encryptedForcePush(source);

  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple");
  const loaded = await store.loadOrCreate();
  loaded.manifest.files["Notes/note-00000.md"].plaintextSha256 = "0".repeat(64);
  await store.save(loaded.manifest, loaded.key, loaded.manifestSha);

  const targetVault = new MemoryVault({});
  const target = plugin(targetVault, github) as never;
  Notice.messages.length = 0;
  await withMutedConsoleError(async () => {
    await encryptedForcePull(target);
  });

  assert.equal(targetVault.files.has("Notes/note-00000.md"), false);
  assert.match(Notice.messages.at(-1) ?? "", /integrity|hash/i);
});

test("encrypted rename moves manifest state without scanning the whole vault", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/old.md": "same content", "Notes/other.md": "stable" });
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  const oldObjectCount = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/")).length;
  const bytes = vault.files.get("Notes/old.md") ?? new Uint8Array();
  vault.files.delete("Notes/old.md");
  vault.set("Archive/new.md", bytes);
  vault.getFilesCount = 0;
  vault.readBinaryCount = 0;

  await encryptedRename(vault.getAbstractFileByPath("Archive/new.md") as TFile, "Notes/old.md", instance, true);

  assert.equal(vault.getFilesCount, 0);
  assert.equal(vault.readBinaryCount, 1);
  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple");
  const loaded = await store.loadOrCreate();
  assert.equal(loaded.manifest.files["Notes/old.md"].deleted, true);
  assert.equal(loaded.manifest.files["Archive/new.md"].deleted, false);
  assert.equal(loaded.manifest.files["Archive/new.md"].objectPath, loaded.manifest.files["Notes/old.md"].objectPath);
  assert.equal([...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/")).length, oldObjectCount);
});

test("force push after a large vault shrinks clears obsolete pack metadata and remote pack objects", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(10_001, "large"));
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);
  assert.equal([...github.blobs.keys()].some(path => path.startsWith(".obsidian-github-sync-encrypted/packs/")), true);

  vault.files.clear();
  vault.mtimes.clear();
  vault.set("Notes/only.md", new TextEncoder().encode("small"));
  await encryptedForcePush(instance);

  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple");
  const loaded = await store.loadOrCreate();
  assert.equal(Object.keys(loaded.manifest.packs ?? {}).length, 0);
  assert.deepEqual(Object.keys(loaded.manifest.files), ["Notes/only.md"]);
  assert.equal([...github.blobs.keys()].some(path => path.startsWith(".obsidian-github-sync-encrypted/packs/")), false);
});

test("encrypted modify events are debounced and only push the final file state", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  await encryptedForcePush(instance as never);
  const manifestPutsAfterInitialPush = github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0;

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const callbacks: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    const index = Number(timer) - 1;
    if (callbacks[index]) callbacks[index] = () => {};
  }) as typeof clearTimeout;

  try {
    vault.set("Notes/a.md", new TextEncoder().encode("draft 1"));
    NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);
    vault.set("Notes/a.md", new TextEncoder().encode("draft 2"));
    NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);
    assert.equal(github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0, manifestPutsAfterInitialPush);
    await callbacks.at(-1)?.();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.equal(github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0, manifestPutsAfterInitialPush + 1);
  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/a.md")), "draft 2");
});
