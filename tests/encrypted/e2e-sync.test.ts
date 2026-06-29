import assert from "node:assert/strict";
import test from "node:test";
import { modalButtons, modalEvents, Notice, resetModalTestState, TFile } from "obsidian";
import { encryptedDelete, encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "../../src/lib/encrypted/sync-engine";
import { NoteModify, NoteRename, overrideRemoteAllFilesImpl, syncAllFilesImpl } from "../../src/lib/fs";
import { hashContent } from "../../src/lib/helps";
import { GitHubClient } from "../../src/lib/github-api";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { sha256Hex, utf8ToBytes } from "../../src/lib/encrypted/bytes";

class MemoryGitHub {
  blobs = new Map<string, { content: string; sha: string }>();
  counter = 0;
  headSha = "head-1";
  getRemoteHeadCount = 0;
  getTreeCount = 0;
  failRemoteHead = false;
  putCounts = new Map<string, number>();
  getCounts = new Map<string, number>();
  deletedPaths: string[] = [];
  failPutPathPrefix?: string;
  truncated = false;

  async getRemoteHeadSha() {
    this.getRemoteHeadCount += 1;
    if (this.failRemoteHead) throw new Error("Injected remote head failure");
    return this.headSha;
  }



  async getTree() {
    this.getTreeCount += 1;
    return {
      sha: "tree",
      url: "",
      truncated: this.truncated,
      tree: [...this.blobs.entries()].map(([path, value]) => ({ path, mode: "100644", type: "blob" as const, sha: value.sha, url: "" })),
    };
  }

  async getFile(path: string) {
    this.getCounts.set(path, (this.getCounts.get(path) ?? 0) + 1);
    const item = this.blobs.get(path);
    if (!item) return null;
    return { content: item.content, sha: item.sha, path, size: item.content.length };
  }

  async putFile(path: string, content: string | ArrayBuffer, _sha?: string) {
    if (this.failPutPathPrefix && path.startsWith(this.failPutPathPrefix)) throw new Error("Injected put failure for " + path);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha = `sha-${++this.counter}`;
    this.headSha = `head-${this.counter}`;
    this.putCounts.set(path, (this.putCounts.get(path) ?? 0) + 1);
    this.blobs.set(path, { content: base64, sha });
    return sha;
  }

  async deleteFile(path: string) {
    this.deletedPaths.push(path);
    this.blobs.delete(path);
    this.headSha = `head-${++this.counter}`;
  }
}

class StrictFolderVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  folders = new Set<string>();

  getFiles() {
    return [...this.files.entries()].map(([path, bytes]) => {
      const file = new TFile(path, bytes);
      file.stat.mtime = this.mtimes.get(path) ?? Date.now();
      return file;
    });
  }

  getAbstractFileByPath(path: string) {
    const bytes = this.files.get(path);
    if (bytes) {
      const file = new TFile(path, bytes);
      file.stat.mtime = this.mtimes.get(path) ?? Date.now();
      return file;
    }
    return this.folders.has(path) ? { path } : null;
  }

  async readBinary(file: TFile) {
    return this.files.get(file.path)?.buffer.slice(0) ?? new ArrayBuffer(0);
  }

  async read(file: TFile) {
    return new TextDecoder().decode(this.files.get(file.path) ?? new Uint8Array());
  }

  async createFolder(path: string) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.folders.has(parent)) throw new Error("Missing parent folder: " + parent);
    this.folders.add(path);
  }

  async createBinary(path: string, buffer: ArrayBuffer) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.folders.has(parent)) throw new Error("Missing folder: " + parent);
    this.files.set(path, new Uint8Array(buffer));
    this.mtimes.set(path, Date.now());
  }

  async modifyBinary(file: TFile, buffer: ArrayBuffer) {
    this.files.set(file.path, new Uint8Array(buffer));
    this.mtimes.set(file.path, Date.now());
  }

  async delete(file: TFile) { this.files.delete(file.path); }
}

class MemoryVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  readCount = 0;
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
    this.readCount += 1;
    return new TextDecoder().decode(this.files.get(file.path) ?? new Uint8Array());
  }

  async createFolder(_path: string) {}
  async create(path: string, content: string) { this.set(path, new TextEncoder().encode(content)); }
  async modify(file: TFile, content: string) { this.set(file.path, new TextEncoder().encode(content)); }
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
    updateStats() { return Promise.resolve(); },
  };
}

function plaintextPlugin(vault: MemoryVault, github: MemoryGitHub) {
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  instance.settings.encryptionMode = "plaintext";
  return instance;
}


function manyFileEntries(count: number, prefix = "v1"): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < count; index++) entries[`Notes/note-${String(index).padStart(5, "0")}.md`] = `${prefix}-${index}`;
  return entries;
}

async function waitForAsyncWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
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
async function withMutedConsoleWarn(run: () => Promise<void>): Promise<void> {
  const originalConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    await run();
  } finally {
    console.warn = originalConsoleWarn;
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

test("normal encrypted sync skips manifest load when remote head and local encrypted state are unchanged", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable" });
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  await encryptedForcePush(instance as never);
  instance.syncData.lastRemoteHeadSha = github.headSha;
  github.getRemoteHeadCount = 0;
  github.getCounts.clear();
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance as never);

  assert.equal(github.getRemoteHeadCount, 1);
  assert.equal(github.getCounts.size, 0);
  assert.equal(vault.readBinaryCount, 0);
});
test("normal encrypted sync skips remote pack downloads and uploads when pack state is unchanged", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "stable"));
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault({});
  const target = plugin(targetVault, github) as never;
  await encryptedForcePull(target);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  assert.equal(packPaths.length > 0, true);
  const packGetsAfterPull = new Map(packPaths.map(path => [path, github.getCounts.get(path) ?? 0]));
  const packPutsAfterPull = new Map(packPaths.map(path => [path, github.putCounts.get(path) ?? 0]));
  const manifestPutsAfterPull = github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0;
  targetVault.readBinaryCount = 0;

  await encryptedFullSync(target);

  assert.equal(targetVault.readBinaryCount, 0);
  assert.equal(github.putCounts.get(".obsidian-github-sync-encrypted/manifest.enc") ?? 0, manifestPutsAfterPull);
  for (const path of packPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, packGetsAfterPull.get(path));
    assert.equal(github.putCounts.get(path) ?? 0, packPutsAfterPull.get(path));
  }
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

test("normal encrypted sync uploads only changed packs in a large vault", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(10_001, "v1"));
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  const packPutsBefore = new Map(packPaths.map(path => [path, github.putCounts.get(path) ?? 0]));
  vault.set("Notes/note-00000.md", new TextEncoder().encode("v2-0"));
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance);

  const changedPackUploads = packPaths.filter(path => (github.putCounts.get(path) ?? 0) > (packPutsBefore.get(path) ?? 0));
  assert.equal(changedPackUploads.length, 1);
  assert.equal(vault.readBinaryCount <= 1_000, true);
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

test("encrypted local modify checks conflict before pushing over remote changes", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "base" });
  const remote = plugin(remoteVault, github) as never;
  await encryptedForcePush(remote);

  const localVault = new MemoryVault({});
  const local = plugin(localVault, github) as never;
  await encryptedForcePull(local);

  remoteVault.set("Notes/a.md", new TextEncoder().encode("remote edit"));
  await encryptedModify(remoteVault.getAbstractFileByPath("Notes/a.md") as TFile, remote, true);

  localVault.set("Notes/a.md", new TextEncoder().encode("local edit"));
  await encryptedModify(localVault.getAbstractFileByPath("Notes/a.md") as TFile, local, true);

  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/a.md")), "remote edit");
  assert.equal([...localVault.files.keys()].some(path => path.includes(".sync-conflict-") && path.endsWith(".md")), true);
});

test("encrypted local delete checks conflict before deleting a remotely changed file", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "base" });
  const remote = plugin(remoteVault, github) as never;
  await encryptedForcePush(remote);

  const localVault = new MemoryVault({});
  const local = plugin(localVault, github) as never;
  await encryptedForcePull(local);

  remoteVault.set("Notes/a.md", new TextEncoder().encode("remote survives"));
  await encryptedModify(remoteVault.getAbstractFileByPath("Notes/a.md") as TFile, remote, true);

  const deletedFile = localVault.getAbstractFileByPath("Notes/a.md") as TFile;
  localVault.files.delete("Notes/a.md");
  await encryptedDelete(deletedFile, local, true);

  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/a.md")), "remote survives");
  assert.equal([...localVault.files.keys()].some(path => path.includes(".sync-conflict-") && path.endsWith(".md")), true);
});

test("encrypted rename checks conflict before deleting a remotely changed source path", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/old.md": "base" });
  const remote = plugin(remoteVault, github) as never;
  await encryptedForcePush(remote);

  const localVault = new MemoryVault({});
  const local = plugin(localVault, github) as never;
  await encryptedForcePull(local);

  remoteVault.set("Notes/old.md", new TextEncoder().encode("remote old edit"));
  await encryptedModify(remoteVault.getAbstractFileByPath("Notes/old.md") as TFile, remote, true);

  const bytes = localVault.files.get("Notes/old.md") ?? new Uint8Array();
  localVault.files.delete("Notes/old.md");
  localVault.set("Notes/new.md", bytes);
  await encryptedRename(localVault.getAbstractFileByPath("Notes/new.md") as TFile, "Notes/old.md", local, true);

  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/old.md")), "remote old edit");
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/new.md")), "base");
});


test("encrypted local modify treats missing local state as a conflict before overwriting remote", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "remote original" });
  await encryptedForcePush(plugin(remoteVault, github) as never);

  const localVault = new MemoryVault({ "Notes/a.md": "local unknown ancestry" });
  const local = plugin(localVault, github) as never;
  await encryptedModify(localVault.getAbstractFileByPath("Notes/a.md") as TFile, local, true);

  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/a.md")), "remote original");
  assert.equal([...localVault.files.keys()].some(path => path.includes(".sync-conflict-") && path.endsWith(".md")), true);
});

test("force push shrink keeps old remote packs available if object migration upload fails", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(10_001, "large"));
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);
  const packPathsBefore = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  assert.equal(packPathsBefore.length > 0, true);

  vault.files.clear();
  vault.mtimes.clear();
  vault.set("Notes/only.md", new TextEncoder().encode("small"));
  github.failPutPathPrefix = ".obsidian-github-sync-encrypted/objects/";
  await withMutedConsoleError(async () => {
    await encryptedForcePush(instance);
  });

  for (const packPath of packPathsBefore) assert.equal(github.blobs.has(packPath), true);
  assert.deepEqual(github.deletedPaths.filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/")), []);
});

test("force pull creates nested folders recursively before writing deep paths", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "a/b/c/deep.md": "deep content" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new StrictFolderVault();
  await encryptedForcePull(plugin(targetVault as unknown as MemoryVault, github) as never);

  assert.equal(new TextDecoder().decode(targetVault.files.get("a/b/c/deep.md")), "deep content");
  assert.equal(targetVault.folders.has("a"), true);
  assert.equal(targetVault.folders.has("a/b"), true);
  assert.equal(targetVault.folders.has("a/b/c"), true);
});


test("plaintext local modify honors the syncEnabled master switch", () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "local" });
  const instance = plaintextPlugin(vault, github);
  instance.settings.syncEnabled = false;

  NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);

  assert.equal(instance.debounceTimers.size, 0);
  assert.equal(github.putCounts.size, 0);
});

test("plaintext local modify refuses case-insensitive path collisions before upload", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/File.md": "upper", "Notes/file.md": "lower" });
  const instance = plaintextPlugin(vault, github);
  Notice.messages.length = 0;
  const callbacks: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = (globalThis as typeof globalThis & { window?: typeof globalThis }).window;
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  (globalThis as typeof globalThis & { window?: typeof globalThis }).window = globalThis;

  try {
    NoteModify(vault.getAbstractFileByPath("Notes/File.md") as TFile, instance as never, true);
    await withMutedConsoleError(async () => {
      await callbacks.at(-1)?.();
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    (globalThis as typeof globalThis & { window?: typeof globalThis }).window = originalWindow;
  }

  assert.equal(github.putCounts.size, 0);
  assert.match(Notice.messages.at(-1) ?? "", /case-insensitive path collision/i);
});

test("plaintext rename refuses case-insensitive path collisions before upload", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/File.md": "upper", "Notes/file.md": "lower" });
  const instance = plaintextPlugin(vault, github);
  Notice.messages.length = 0;

  await withMutedConsoleError(async () => {
    await NoteRename(vault.getAbstractFileByPath("Notes/file.md") as TFile, "Notes/old.md", instance as never, true);
  });

  assert.equal(github.putCounts.size, 0);
  assert.match(Notice.messages.at(-1) ?? "", /case-insensitive path collision/i);
});

test("plaintext full sync preserves local edits when remote changed since last sync", async () => {
  const github = new MemoryGitHub();
  await github.putFile("Notes/a.md", "remote edit");
  const remoteSha = github.blobs.get("Notes/a.md")?.sha ?? "";
  const vault = new MemoryVault({ "Notes/a.md": "local edit" });
  const instance = plaintextPlugin(vault, github);
  instance.syncData.files["Notes/a.md"] = { sha: "old-sha", lastSync: Date.now(), hash: hashContent("base") };

  await syncAllFilesImpl(instance as never);

  assert.equal(new TextDecoder().decode(vault.files.get("Notes/a.md")), "local edit");
  assert.equal([...vault.files.keys()].some(path => path.includes(".sync-conflict-") && path.endsWith(".md")), true);
  assert.equal(instance.syncData.files["Notes/a.md"].sha, remoteSha);
});

test("plaintext rename keeps old remote file if new upload fails", async () => {
  const github = new MemoryGitHub();
  const oldSha = await github.putFile("Notes/old.md", "old remote");
  const vault = new MemoryVault({ "Notes/new.md": "new local" });
  const instance = plaintextPlugin(vault, github);
  instance.syncData.files["Notes/old.md"] = { sha: oldSha, lastSync: Date.now(), hash: hashContent("old remote") };
  github.failPutPathPrefix = "Notes/new.md";

  await withMutedConsoleError(async () => {
    await NoteRename(vault.getAbstractFileByPath("Notes/new.md") as TFile, "Notes/old.md", instance as never, true);
  });

  assert.equal(github.blobs.has("Notes/old.md"), true);
  assert.equal(github.blobs.has("Notes/new.md"), false);
});

test("encrypted normal pull treats existing local file without state as a conflict", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "remote original" });
  await encryptedForcePush(plugin(remoteVault, github) as never);

  const localVault = new MemoryVault({ "Notes/a.md": "local unknown" });
  await encryptedFullSync(plugin(localVault, github) as never);

  assert.equal(new TextDecoder().decode(localVault.files.get("Notes/a.md")), "local unknown");
  assert.equal([...localVault.files.keys()].some(path => path.includes(".sync-conflict-") && path.endsWith(".md")), true);
});

test("encrypted overwrite command path performs force push semantics", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "remote" });
  await encryptedForcePush(plugin(remoteVault, github) as never);

  const localVault = new MemoryVault({ "Notes/a.md": "local" });
  const instance = plugin(localVault, github) as never;
  await overrideRemoteAllFilesImpl(instance);

  const pulledVault = new MemoryVault({});
  await encryptedForcePull(plugin(pulledVault, github) as never);
  assert.equal(new TextDecoder().decode(pulledVault.files.get("Notes/a.md")), "local");
});


test("plaintext full sync skips unchanged cached markdown reads at scale", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(100_000, "stable"));
  const instance = plaintextPlugin(vault, github);
  const files = vault.getFiles();

  for (const file of files) {
    const sha = `remote-${file.path}`;
    github.blobs.set(file.path, { content: "", sha });
    instance.syncData.files[file.path] = {
      sha,
      lastSync: Date.now(),
      hash: "cached",
      size: file.stat.size,
      mtime: file.stat.mtime,
    };
  }
  vault.readCount = 0;
  vault.readBinaryCount = 0;

  await syncAllFilesImpl(instance as never);

  assert.equal(vault.readCount, 0);
  assert.equal(vault.readBinaryCount, 0);
  assert.equal(github.putCounts.size, 0);
});
test("plaintext full sync falls back to tree sync when remote head lookup fails", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable" });
  const instance = plaintextPlugin(vault, github);
  const file = vault.getAbstractFileByPath("Notes/a.md") as TFile;
  const sha = await github.putFile("Notes/a.md", "stable");
  instance.syncData.files["Notes/a.md"] = { sha, lastSync: Date.now(), hash: hashContent("stable"), size: file.stat.size, mtime: file.stat.mtime };
  instance.syncData.lastRemoteHeadSha = github.headSha;
  github.failRemoteHead = true;
  github.getTreeCount = 0;

  await withMutedConsoleWarn(async () => {
    await syncAllFilesImpl(instance as never);
  });

  assert.equal(github.getRemoteHeadCount, 1);
  assert.equal(github.getTreeCount, 1);
});
test("plaintext full sync skips remote tree when remote head and local stat cache are unchanged", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable" });
  const instance = plaintextPlugin(vault, github);
  const file = vault.getAbstractFileByPath("Notes/a.md") as TFile;
  const sha = await github.putFile("Notes/a.md", "stable");
  instance.syncData.files["Notes/a.md"] = { sha, lastSync: Date.now(), hash: hashContent("stable"), size: file.stat.size, mtime: file.stat.mtime };
  instance.syncData.lastRemoteHeadSha = github.headSha;
  github.getRemoteHeadCount = 0;
  github.getTreeCount = 0;
  vault.readCount = 0;

  await withMutedConsoleWarn(async () => {
    await syncAllFilesImpl(instance as never);
  });

  assert.equal(github.getRemoteHeadCount, 1);
  assert.equal(github.getTreeCount, 0);
  assert.equal(vault.readCount, 0);
});
test("plaintext full sync refuses truncated remote trees before pushing local files", async () => {
  const github = new MemoryGitHub();
  github.truncated = true;
  const vault = new MemoryVault({ "Notes/local.md": "local" });
  const instance = plaintextPlugin(vault, github);
  Notice.messages.length = 0;

  await withMutedConsoleError(async () => {
    await syncAllFilesImpl(instance as never);
  });

  assert.equal(github.putCounts.size, 0);
  assert.match(Notice.messages.at(-1) ?? "", /truncated/i);
});


test("force push asks before initializing a foreign non-empty remote", async () => {
  const github = new MemoryGitHub();
  await github.putFile("README.md", "foreign");
  const vault = new MemoryVault({ "Notes/a.md": "local" });
  const instance = plugin(vault, github) as never;
  resetModalTestState();
  Notice.messages.length = 0;

  const cancelled = encryptedForcePush(instance);
  await waitForAsyncWork();
  assert.equal(modalEvents.filter(event => event === "open").length, 1);
  modalButtons.filter(button => button.text === "Cancel").at(-1)?.click();
  await cancelled;
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/config.json"), false);
  assert.match(Notice.messages.at(-1) ?? "", /cancelled/i);

  resetModalTestState();
  const confirmed = encryptedForcePush(instance);
  await waitForAsyncWork();
  modalButtons.filter(button => button.text === "Force push local to remote").at(-1)?.click();
  await confirmed;
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/config.json"), true);
});

test("normal encrypted sync migrates a gradually grown vault into pack mode", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/seed.md": "seed" });
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  vault.files.clear();
  vault.mtimes.clear();
  for (const [path, content] of Object.entries(manyFileEntries(10_001, "grown"))) vault.set(path, new TextEncoder().encode(content));
  await encryptedFullSync(instance);

  assert.equal([...github.blobs.keys()].some(path => path.startsWith(".obsidian-github-sync-encrypted/packs/")), true);
  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple");
  const loaded = await store.loadOrCreate();
  assert.equal(Object.keys(loaded.manifest.packs ?? {}).length > 0, true);
  assert.equal(Object.values(loaded.manifest.files).every(record => record.storage === "pack"), true);
});

test("concurrent local modifications do not overwrite remote manifest changes", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial a", "Notes/b.md": "initial b" });
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  vault.set("Notes/a.md", new TextEncoder().encode("updated a"));
  vault.set("Notes/b.md", new TextEncoder().encode("updated b"));

  const fileA = vault.getAbstractFileByPath("Notes/a.md") as TFile;
  const fileB = vault.getAbstractFileByPath("Notes/b.md") as TFile;

  await Promise.all([
    encryptedModify(fileA, instance, false),
    encryptedModify(fileB, instance, false),
  ]);

  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple");
  const loaded = await store.loadOrCreate();

  assert.equal(loaded.manifest.files["Notes/a.md"].plaintextSha256, await sha256Hex(utf8ToBytes("updated a")));
  assert.equal(loaded.manifest.files["Notes/b.md"].plaintextSha256, await sha256Hex(utf8ToBytes("updated b")));
});

test("normal encrypted sync skips download for identical single objects when cache is empty", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/a.md": "stable content" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault({ "Notes/a.md": "stable content" });
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;
  
  // Clear any cache if it got populated during initialization
  target.syncData.encrypted = { files: {} };
  github.getCounts.clear();

  await encryptedFullSync(target as never);

  const objectPaths = [...github.blobs.keys()].filter(path => path.includes("/objects/"));
  assert.equal(objectPaths.length > 0, true);
  for (const path of objectPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, 0);
  }
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "stable content");
  assert.ok(target.syncData.encrypted?.files["Notes/a.md"]);
});

test("normal encrypted sync skips download for identical packs when cache is empty", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "stable"));
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault(manyFileEntries(10_001, "stable"));
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;
  
  // Clear cache and counts
  target.syncData.encrypted = { files: {} };
  github.getCounts.clear();

  await encryptedFullSync(target as never);

  const packPaths = [...github.blobs.keys()].filter(path => path.includes("/packs/"));
  assert.equal(packPaths.length > 0, true);
  for (const path of packPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, 0);
  }
  assert.ok(target.syncData.encrypted?.files["Notes/note-00000.md"]);
});

test("normal encrypted sync skips download for identical single objects when cache is outdated", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/a.md": "stable content" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault({ "Notes/a.md": "stable content" });
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;
  
  // Populate cache with outdated/mismatching hash
  target.syncData.encrypted = {
    files: {
      "Notes/a.md": {
        plaintextSha256: "0".repeat(64), // mismatching hash
        objectPath: ".obsidian-github-sync-encrypted/objects/something.enc",
        manifestUpdatedAt: 1,
      }
    }
  };
  github.getCounts.clear();

  await encryptedFullSync(target as never);

  const objectPaths = [...github.blobs.keys()].filter(path => path.includes("/objects/"));
  assert.equal(objectPaths.length > 0, true);
  for (const path of objectPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, 0);
  }
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "stable content");
});

test("normal encrypted sync skips download for identical packs when cache is outdated", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "stable"));
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault(manyFileEntries(10_001, "stable"));
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;
  
  // Populate cache with outdated/mismatching hash for one of the files
  target.syncData.encrypted = {
    files: {
      "Notes/note-00000.md": {
        plaintextSha256: "0".repeat(64), // mismatching hash
        objectPath: ".obsidian-github-sync-encrypted/packs/000001.pack.enc",
        manifestUpdatedAt: 1,
      }
    }
  };
  github.getCounts.clear();

  await encryptedFullSync(target as never);

  const packPaths = [...github.blobs.keys()].filter(path => path.includes("/packs/"));
  assert.equal(packPaths.length > 0, true);
  for (const path of packPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, 0);
  }
});

test("normal encrypted sync overwrites local file when remote is newer and local matches outdated cache", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/a.md": "new remote content" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault({ "Notes/a.md": "old local content" });
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;
  
  // Populate cache with "old local content" hash to indicate it wasn't modified locally
  const oldHash = await sha256Hex(new TextEncoder().encode("old local content"));
  target.syncData.encrypted = {
    files: {
      "Notes/a.md": {
        plaintextSha256: oldHash,
        objectPath: ".obsidian-github-sync-encrypted/objects/something.enc",
        manifestUpdatedAt: 1,
      }
    }
  };
  github.getCounts.clear();

  await encryptedFullSync(target as never);

  // It should download the file and overwrite
  const objectPaths = [...github.blobs.keys()].filter(path => path.includes("/objects/"));
  assert.equal(objectPaths.length > 0, true);
  for (const path of objectPaths) {
    assert.equal(github.getCounts.get(path) ?? 0, 1); // exactly 1 download
  }
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "new remote content");
});
