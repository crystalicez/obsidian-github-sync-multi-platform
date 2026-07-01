import assert from "node:assert/strict";
import test from "node:test";
import { modalButtons, modalEvents, Notice, resetModalTestState, TFile } from "obsidian";
import { encryptedDelete, encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "../../src/lib/encrypted/sync-engine";
import { NoteDelete, NoteModify, NoteRename, overrideLocalAllFilesImpl, overrideRemoteAllFilesImpl, syncAllFilesImpl } from "../../src/lib/fs";
import { hashContent } from "../../src/lib/helps";
import { GitHubClient } from "../../src/lib/github-api";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { EncryptedSnapshotStore, V2_HEAD_PATH, V2_SNAPSHOTS_ROOT } from "../../src/lib/encrypted/snapshot-store";
import { sha256Hex, utf8ToBytes } from "../../src/lib/encrypted/bytes";
import { ENCRYPTED_MANIFEST_PATH } from "../../src/lib/encrypted/constants";

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
  getBlobCount = 0;

  async getRemoteHeadSha() {
    this.getRemoteHeadCount += 1;
    if (this.failRemoteHead) throw new Error("Injected remote head failure");
    return this.blobs.size === 0 ? null : this.headSha;
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
    if (path === ".obsidian-github-sync-encrypted") {
      const exists = [...this.blobs.keys()].some(p => p.startsWith(".obsidian-github-sync-encrypted/"));
      return exists ? [] as any : null;
    }
    const item = this.blobs.get(path);
    if (!item) return null;
    return { content: item.content, sha: item.sha, path, size: item.content.length };
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    this.getBlobCount += 1;
    for (const [path, blob] of this.blobs.entries()) {
      if (blob.sha === sha) {
        this.getCounts.set(path, (this.getCounts.get(path) ?? 0) + 1);
        return GitHubClient.decodeContentBytes(blob.content);
      }
    }
    throw new Error("HTTP 404 - Blob not found: " + sha);
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

class HeadCasConflictOnceGitHub extends MemoryGitHub {
  failNextHeadCas = false;
  headCasFailures = 0;

  async putFile(path: string, content: string | ArrayBuffer, sha?: string) {
    if (this.failNextHeadCas && path === V2_HEAD_PATH && sha) {
      this.failNextHeadCas = false;
      this.headCasFailures += 1;
      const error = new Error("409 sha does not match") as Error & { status: number };
      error.status = 409;
      throw error;
    }
    return super.putFile(path, content, sha);
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

  getMarkdownFiles() {
    return this.getFiles().filter(file => file.extension === "md");
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

  getMarkdownFiles() {
    return this.getFiles().filter(file => file.extension === "md");
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
    isTesting: true,
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
    syncProgress: {
      status: "idle",
      pushCount: 0,
      totalPush: 0,
      pullCount: 0,
      totalPull: 0,
      lastSyncTime: 0,
    },
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

async function loadV2Snapshot(github: MemoryGitHub) {
  const loaded = await new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple", true).loadOrCreateKey();
  const snapshotStore = new EncryptedSnapshotStore(github as unknown as GitHubClient, loaded.key);
  const head = await snapshotStore.loadHead();
  assert.ok(head);
  const snapshot = await snapshotStore.loadSnapshot(head.head.snapshotId);
  assert.ok(snapshot);
  return { loaded, snapshotStore, head, snapshot };
}

async function mutateV2Snapshot(github: MemoryGitHub, mutate: (snapshot: Awaited<ReturnType<typeof loadV2Snapshot>>["snapshot"]) => void | Promise<void>) {
  const { snapshotStore, head, snapshot } = await loadV2Snapshot(github);
  await mutate(snapshot);
  snapshot.snapshotId = `${snapshot.snapshotId}-mutated-${Date.now()}`;
  snapshot.parentSnapshotIds = [head.head.snapshotId];
  snapshot.generation = head.head.generation + 1;
  const written = await snapshotStore.writeSnapshot(snapshot);
  await snapshotStore.updateHeadCas({ formatVersion: 2, snapshotId: written.snapshot.snapshotId, generation: written.snapshot.generation, updatedAt: Date.now() }, head.sha);
  return written.snapshot;
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
  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);

  const targetVault = new MemoryVault({ "local-only.md": "delete me" });
  await encryptedForcePull(plugin(targetVault, github) as never);

  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "hello encrypted world");
  assert.equal(targetVault.files.has("local-only.md"), false);
});

test("encrypted force push writes a v2 snapshot head without plaintext remote paths", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/private.md": "secret v2 snapshot" });
  const instance = plugin(vault, github) as never;

  await encryptedForcePush(instance);

  assert.equal(github.blobs.has(V2_HEAD_PATH), true);
  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);
  const snapshotPath = [...github.blobs.keys()].find(path => path.startsWith(`${V2_SNAPSHOTS_ROOT}/`));
  assert.equal(typeof snapshotPath, "string");
  assert.equal(github.blobs.get(V2_HEAD_PATH)?.content.includes("Notes/private.md"), false);
  assert.equal(github.blobs.get(snapshotPath!)?.content.includes("Notes/private.md"), false);
});

test("encrypted force push overwrites a dangling v2 snapshot head", async () => {
  const github = new MemoryGitHub();
  const loaded = await new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple", true).loadOrCreateKey();
  const snapshotStore = new EncryptedSnapshotStore(github as unknown as GitHubClient, loaded.key);
  await snapshotStore.updateHeadCas({ formatVersion: 2, snapshotId: "missing-snapshot", generation: 1, updatedAt: Date.now() });

  const vault = new MemoryVault({ "Notes/a.md": "replacement" });
  await encryptedForcePush(plugin(vault, github) as never);

  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(snapshot.files["Notes/a.md"].deleted, false);
  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);
});
test("encrypted force push ignores corrupt legacy v1 manifest metadata", async () => {
  const github = new MemoryGitHub();
  await new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple", true).loadOrCreateKey();
  await github.putFile(ENCRYPTED_MANIFEST_PATH, "not a decryptable v1 manifest");

  const vault = new MemoryVault({ "Notes/a.md": "v2 wins" });
  await encryptedForcePush(plugin(vault, github) as never);

  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(snapshot.files["Notes/a.md"].deleted, false);
  assert.equal(github.blobs.has(V2_HEAD_PATH), true);
});
test("encrypted force pull prefers v2 snapshot when available", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/private.md": "from v2 snapshot" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault({ "local-only.md": "delete me" });
  await encryptedForcePull(plugin(targetVault, github) as never);

  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/private.md")), "from v2 snapshot");
  assert.equal(targetVault.files.has("local-only.md"), false);
});
test("normal encrypted sync skips unchanged file reads and manifest writes", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable content" });
  const instance = plugin(vault, github) as never;

  await encryptedForcePush(instance);
  const headPutsAfterInitialPush = github.putCounts.get(V2_HEAD_PATH) ?? 0;
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance);


  assert.equal(vault.readBinaryCount, 0);
  assert.equal(github.putCounts.get(V2_HEAD_PATH) ?? 0, headPutsAfterInitialPush);
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
  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);

  await encryptedForcePush(instance);
  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);
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
  const headPutsAfterPull = github.putCounts.get(V2_HEAD_PATH) ?? 0;
  targetVault.readBinaryCount = 0;

  await encryptedFullSync(target);

  assert.equal(targetVault.readBinaryCount, 0);
  assert.equal(github.putCounts.get(V2_HEAD_PATH) ?? 0, headPutsAfterPull);
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

test("normal encrypted sync uploads one loose object instead of rewriting packs for one changed packed file", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(10_001, "v1"));
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  await encryptedForcePush(instance);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  const packPutsBefore = new Map(packPaths.map(path => [path, github.putCounts.get(path) ?? 0]));
  const objectPathsBefore = new Set([...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/")));
  vault.set("Notes/note-00000.md", new TextEncoder().encode("v2-0"));
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance);

  const changedPackUploads = packPaths.filter(path => (github.putCounts.get(path) ?? 0) > (packPutsBefore.get(path) ?? 0));
  const newObjectPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/") && !objectPathsBefore.has(path));
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(changedPackUploads.length, 0);
  assert.equal(newObjectPaths.length, 1);
  assert.equal(snapshot.files["Notes/note-00000.md"].storage, "object");
  assert.equal(Object.keys(snapshot.packs ?? {}).length, packPaths.length);
  assert.equal(instance.syncProgress.totalPull, 0);
  assert.equal(instance.syncProgress.totalPush, 1);
  assert.equal(vault.readBinaryCount <= 2, true);
});

test("encrypted auto local change uploads one loose object instead of rewriting packs for one changed packed file", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(2_059, "v1"));
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  await encryptedForcePush(instance);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  const packPutsBefore = new Map(packPaths.map(path => [path, github.putCounts.get(path) ?? 0]));
  const objectPathsBefore = new Set([...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/")));
  vault.set("Notes/note-00000.md", new TextEncoder().encode("v2-0"));
  const changedFile = vault.getAbstractFileByPath("Notes/note-00000.md") as TFile;
  vault.readBinaryCount = 0;

  await encryptedModify(changedFile, instance as never, true);

  const changedPackUploads = packPaths.filter(path => (github.putCounts.get(path) ?? 0) > (packPutsBefore.get(path) ?? 0));
  const newObjectPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/") && !objectPathsBefore.has(path));
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(changedPackUploads.length, 0);
  assert.equal(newObjectPaths.length, 1);
  assert.equal(snapshot.files["Notes/note-00000.md"].storage, "object");
  assert.equal(Object.keys(snapshot.packs ?? {}).length, packPaths.length);
  assert.equal(instance.syncProgress.totalPull, 0);
  assert.equal(instance.syncProgress.totalPush, 1);
  assert.equal(vault.readBinaryCount <= 2, true);
});
test("encrypted local modify is blocked until force push after enabling encryption", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "needs migration" });
  const instance = plugin(vault, github) as never;
  (instance as { settings: { encryptedForcePushRequired?: boolean } }).settings.encryptedForcePushRequired = true;

  await withMutedConsoleError(async () => {
    await encryptedModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance, true);
  });

  assert.equal(github.blobs.has(ENCRYPTED_MANIFEST_PATH), false);
});

test("force pull refuses pack files whose plaintext hash differs from the manifest", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault(manyFileEntries(10_001, "hash"));
  const source = plugin(sourceVault, github) as never;
  await encryptedForcePush(source);

  await mutateV2Snapshot(github, snapshot => {
    snapshot.files["Notes/note-00000.md"].plaintextSha256 = "0".repeat(64);
  });

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
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(snapshot.files["Notes/old.md"].deleted, true);
  assert.equal(snapshot.files["Archive/new.md"].deleted, false);
  assert.equal(snapshot.files["Archive/new.md"].objectPath, snapshot.files["Notes/old.md"].objectPath);
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

  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.keys(snapshot.packs ?? {}).length, 0);
  assert.deepEqual(Object.keys(snapshot.files), ["Notes/only.md"]);
  assert.equal([...github.blobs.keys()].some(path => path.startsWith(".obsidian-github-sync-encrypted/packs/")), false);
});

test("encrypted modify events are debounced and only push the final file state", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  await encryptedForcePush(instance as never);
  const headPutsAfterInitialPush = github.putCounts.get(V2_HEAD_PATH) ?? 0;

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
    assert.equal(github.putCounts.get(V2_HEAD_PATH) ?? 0, headPutsAfterInitialPush);
    await callbacks.at(-1)?.();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.equal(github.putCounts.get(V2_HEAD_PATH) ?? 0, headPutsAfterInitialPush + 1);
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

test("plaintext sync does not trigger conflict when local file is edited and synced twice consecutively", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plaintextPlugin(vault, github);

  // Initial Sync
  await syncAllFilesImpl(instance as never);
  assert.equal(github.blobs.has("Notes/a.md"), true);
  assert.equal(new TextDecoder().decode(GitHubClient.decodeContentBytes(github.blobs.get("Notes/a.md")!.content)), "initial");

  // First edit
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));
  await syncAllFilesImpl(instance as never);
  assert.equal(new TextDecoder().decode(GitHubClient.decodeContentBytes(github.blobs.get("Notes/a.md")!.content)), "first edit");
  
  // Verify no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);

  // Second edit
  vault.files.set("Notes/a.md", new TextEncoder().encode("second edit"));
  await syncAllFilesImpl(instance as never);
  assert.equal(new TextDecoder().decode(GitHubClient.decodeContentBytes(github.blobs.get("Notes/a.md")!.content)), "second edit");

  // Verify STILL no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);
});

test("encrypted sync does not trigger conflict when local file is edited and synced twice consecutively", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github);

  // Enable encryption
  instance.settings.encryptionMode = "encrypted";
  instance.settings.encryptionPassphrase = "correct horse battery staple";

  // Initial Sync (requires force push because remote is empty/new)
  await encryptedForcePush(instance as never);
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/config.json"), true);

  // First edit
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));
  await encryptedFullSync(instance as never);
  
  // Verify no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);

  // Second edit
  vault.files.set("Notes/a.md", new TextEncoder().encode("second edit"));
  await encryptedFullSync(instance as never);

  // Verify STILL no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);
});

test("encrypted auto-sync does not trigger conflict when local file is edited and auto-synced twice consecutively", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github);

  // Enable encryption
  instance.settings.encryptionMode = "encrypted";
  instance.settings.encryptionPassphrase = "correct horse battery staple";

  // Initial Sync (requires force push because remote is empty/new)
  await encryptedForcePush(instance as never);
  assert.equal(github.blobs.has(".obsidian-github-sync-encrypted/config.json"), true);

  // First edit and immediate auto-sync (eventEnter = false runs immediately)
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));
  await NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false);

  // Verify no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);

  // Second edit and immediate auto-sync
  vault.files.set("Notes/a.md", new TextEncoder().encode("second edit"));
  await NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false);

  // Verify STILL no conflict copies created
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);
});

test("plaintext manual sync cancels pending debounce auto-sync timers", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plaintextPlugin(vault, github);

  // Initial Sync
  await syncAllFilesImpl(instance as never);
  assert.equal(github.blobs.has("Notes/a.md"), true);

  // Simulate local modification trigger NoteModify
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));
  NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);

  // Verify debounce timer is scheduled
  assert.equal(instance.debounceTimers.has("Notes/a.md"), true);

  // Immediately run manual sync
  await syncAllFilesImpl(instance as never);

  // Verify debounce timer has been cancelled and cleared
  assert.equal(instance.debounceTimers.has("Notes/a.md"), false);
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);
});

test("encrypted manual sync cancels pending debounce auto-sync timers", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github);

  instance.settings.encryptionMode = "encrypted";
  instance.settings.encryptionPassphrase = "correct horse battery staple";

  // Initial Sync
  await encryptedForcePush(instance as never);

  // Simulate local modification trigger NoteModify
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));
  NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);

  // Verify debounce timer is scheduled
  const debounceKey = `encrypted:Notes/a.md`;
  assert.equal(instance.debounceTimers.has(debounceKey), true);

  // Immediately run manual sync
  await encryptedFullSync(instance as never);

  // Verify debounce timer has been cancelled and cleared
  assert.equal(instance.debounceTimers.has(debounceKey), false);
  assert.equal([...vault.files.keys()].some(p => p.includes(".sync-conflict-")), false);
});

test("plaintext auto-sync performs isSyncInProgress concurrency check", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plaintextPlugin(vault, github);

  // Initial sync
  await syncAllFilesImpl(instance as never);

  // Simulate local change
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));

  // Set sync in progress
  instance.isSyncInProgress = true;

  // Attempt auto-sync performSync
  // It should exit early without pushing or changing stats
  const putCountsBefore = github.putCounts.get("Notes/a.md") ?? 0;
  await NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false); // eventEnter = false runs performSync immediately

  assert.equal(github.putCounts.get("Notes/a.md") ?? 0, putCountsBefore);
  instance.isSyncInProgress = false;
});

test("encrypted auto-sync performs isSyncInProgress concurrency check", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github);
  instance.settings.encryptionMode = "encrypted";
  instance.settings.encryptionPassphrase = "correct horse battery staple";

  // Initial sync
  await encryptedForcePush(instance as never);

  // Simulate local change
  vault.files.set("Notes/a.md", new TextEncoder().encode("first edit"));

  // Set sync in progress
  instance.isSyncInProgress = true;

  // Attempt auto-sync encryptedModify
  const initialManifestSha = instance.syncData.encrypted?.manifestSha;
  await NoteModify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false); // eventEnter = false runs encryptedModify immediately

  // Manifest should not have been updated since auto-sync was skipped
  assert.equal(instance.syncData.encrypted?.manifestSha, initialManifestSha);
  instance.isSyncInProgress = false;
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


test("encrypted force push removes remote encrypted objects absent from local vault", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Notes/a.md": "keep remote", "Notes/remote-only.md": "delete remote object" });
  await encryptedForcePush(plugin(remoteVault, github) as never);
  const before = await loadV2Snapshot(github);
  const staleObjectPath = before.snapshot.files["Notes/remote-only.md"].objectPath;
  const staleSnapshotPath = `${V2_SNAPSHOTS_ROOT}/${before.snapshot.snapshotId}.enc`;
  const orphanObjectPath = ".obsidian-github-sync-encrypted/objects/aa/bb/orphan.enc";
  const orphanPackPath = ".obsidian-github-sync-encrypted/packs/999999.pack.enc";
  await github.putFile(orphanObjectPath, "orphan object");
  await github.putFile(orphanPackPath, "orphan pack");
  assert.equal(github.blobs.has(staleObjectPath), true);
  assert.equal(github.blobs.has(staleSnapshotPath), true);

  const localVault = new MemoryVault({ "Notes/a.md": "keep local" });
  await encryptedForcePush(plugin(localVault, github) as never);

  const after = await loadV2Snapshot(github);
  assert.equal(after.snapshot.files["Notes/remote-only.md"], undefined);
  assert.equal(github.blobs.has(staleObjectPath), false);
  assert.equal(github.blobs.has(staleSnapshotPath), false);
  assert.equal(github.blobs.has(orphanObjectPath), false);
  assert.equal(github.blobs.has(orphanPackPath), false);
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
test("plaintext fast path ignores plugin stats metadata and does not rescan unchanged vaults", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "stable" });
  const instance = plaintextPlugin(vault, github);
  const file = vault.getAbstractFileByPath("Notes/a.md") as TFile;
  const sha = await github.putFile("Notes/a.md", "stable");
  instance.syncData.files["Notes/a.md"] = { sha, lastSync: Date.now(), hash: hashContent("stable"), size: file.stat.size, mtime: file.stat.mtime };
  instance.syncData.files[".obsidian/sync-stats.json"] = { sha: "stats-sha", lastSync: Date.now() };
  instance.syncData.lastRemoteHeadSha = github.headSha;
  let statsCalls = 0;
  instance.updateStats = async () => {
    statsCalls += 1;
    for (const markdown of vault.getMarkdownFiles()) await vault.read(markdown);
  };
  vault.readCount = 0;
  vault.getFilesCount = 0;
  github.getTreeCount = 0;

  await syncAllFilesImpl(instance as never);

  assert.equal(github.getTreeCount, 0);
  assert.equal(vault.readCount, 0);
  assert.equal(statsCalls, 0);
});

test("plaintext force push mirrors local files to remote and deletes remote-only files", async () => {
  const github = new MemoryGitHub();
  await github.putFile("Notes/a.md", "old remote");
  await github.putFile("Notes/remote-only.md", "delete me");
  const vault = new MemoryVault({ "Notes/a.md": "local" });
  const instance = plaintextPlugin(vault, github);
  instance.syncData.files["Notes/a.md"] = { sha: github.blobs.get("Notes/a.md")?.sha ?? "", lastSync: Date.now(), hash: "old" };
  instance.syncData.files["Notes/remote-only.md"] = { sha: github.blobs.get("Notes/remote-only.md")?.sha ?? "", lastSync: Date.now(), hash: "old" };

  await overrideRemoteAllFilesImpl(instance as never);

  assert.equal(github.blobs.has("Notes/remote-only.md"), false);
  assert.equal(GitHubClient.decodeContent(github.blobs.get("Notes/a.md")?.content ?? ""), "local");
});
test("plaintext force pull mirrors remote files to local vault", async () => {
  const github = new MemoryGitHub();
  await github.putFile("Notes/a.md", "remote");
  await github.putFile("Notes/Nested/b.md", "nested remote");
  const vault = new MemoryVault({ "Notes/a.md": "local", "Notes/local-only.md": "delete me" });
  const instance = plaintextPlugin(vault, github);

  await overrideLocalAllFilesImpl(instance as never);

  assert.equal(new TextDecoder().decode(vault.files.get("Notes/a.md")), "remote");
  assert.equal(new TextDecoder().decode(vault.files.get("Notes/Nested/b.md")), "nested remote");
  assert.equal(vault.files.has("Notes/local-only.md"), false);
});

test("plaintext force pull respects ignore path regex for remote downloads and local deletes", async () => {
  const github = new MemoryGitHub();
  await github.putFile("Notes/a.md", "remote");
  await github.putFile("Archive/ignored.md", "remote ignored");
  const vault = new MemoryVault({ "Archive/local.md": "keep ignored local" });
  const instance = plaintextPlugin(vault, github);
  instance.settings.ignorePathRegex = "^Archive/";

  await overrideLocalAllFilesImpl(instance as never);

  assert.equal(vault.files.has("Archive/ignored.md"), false);
  assert.equal(new TextDecoder().decode(vault.files.get("Archive/local.md")), "keep ignored local");
  assert.equal(new TextDecoder().decode(vault.files.get("Notes/a.md")), "remote");
});
test("plaintext rename debounce cleanup supports paths containing colons", () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault({ "Notes/a:b-new.md": "content" });
  const instance = plaintextPlugin(vault, github);
  instance.isTesting = false;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextTimer = 1;
  const cleared = new Set<number>();
  globalThis.setTimeout = ((callback: () => void) => nextTimer++ as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: number) => { cleared.add(timer); }) as typeof clearTimeout;

  try {
    NoteRename(vault.getAbstractFileByPath("Notes/a:b-new.md") as TFile, "Notes/a:b.md", instance as never, true);
    assert.equal([...instance.debounceTimers.keys()].some(key => key.includes("Notes/a:b.md")), true);

    NoteDelete({ path: "Notes/a:b.md" } as never, instance as never, true);

    assert.equal([...instance.debounceTimers.keys()].some(key => key.includes("Notes/a:b-new.md")), false);
    assert.equal(cleared.size > 0, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("encrypted conflict handling does not log plaintext metadata by default", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault({ "Secret/path.md": "remote base" });
  await encryptedForcePush(plugin(remoteVault, github) as never);

  remoteVault.set("Secret/path.md", new TextEncoder().encode("remote changed"));
  await encryptedForcePush(plugin(remoteVault, github) as never);

  const localVault = new MemoryVault({ "Secret/path.md": "local changed" });
  const instance = plugin(localVault, github);
  const logLines: string[] = [];
  const warnLines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warnLines.push(args.map(String).join(" ")); };

  try {
    await encryptedModify(localVault.getAbstractFileByPath("Secret/path.md") as TFile, instance as never, true);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const combined = [...logLines, ...warnLines].join("\n");
  assert.equal(combined.includes("Secret/path.md"), false);
  assert.equal(combined.includes("plaintextSha256"), false);
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

test("encrypted local change in a 2000-file vault migrates to pack mode instead of continuing single-object uploads", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(2_000, "bulk"));
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  const state = instance.syncData.encrypted!;
  for (const file of vault.getFiles().slice(0, 1_000)) {
    state.files[file.path] = {
      plaintextSha256: "0".repeat(64),
      objectPath: `.obsidian-github-sync-encrypted/objects/legacy/${file.path}.enc`,
      remoteSha: `legacy-${file.path}`,
      storage: "single",
      manifestUpdatedAt: Date.now(),
      size: file.stat.size,
      mtime: file.stat.mtime,
    };
  }
  vault.getFilesCount = 0;

  await encryptedModify(vault.getAbstractFileByPath("Notes/note-00000.md") as TFile, instance as never, true);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  const objectPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/"));
  assert.equal(packPaths.length > 0, true);
  assert.equal(objectPaths.length, 0);
  assert.equal(vault.getFilesCount > 0, true);
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.values(snapshot.files).every(record => record.storage === "pack"), true);
});

test("encrypted force push of a 2100-file vault retries transient EBUSY reads", async () => {
  class BusyOnceVault extends MemoryVault {
    attemptsByPath = new Map<string, number>();
    lockedPaths = new Set(["Notes/note-00017.md", "Notes/note-01024.md", "Notes/note-02099.md"]);

    async readBinary(file: TFile) {
      const attempts = this.attemptsByPath.get(file.path) ?? 0;
      this.attemptsByPath.set(file.path, attempts + 1);
      if (this.lockedPaths.has(file.path) && attempts < 2) {
        const error = new Error(`EBUSY: resource busy or locked, open '${file.path}'`) as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return super.readBinary(file);
    }
  }

  const github = new MemoryGitHub();
  const vault = new BusyOnceVault(manyFileEntries(2_100, "busy"));
  const instance = plugin(vault, github) as never;

  await encryptedForcePush(instance);

  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.values(snapshot.files).filter(record => !record.deleted).length, 2_100);
  for (const path of vault.lockedPaths) assert.equal((vault.attemptsByPath.get(path) ?? 0) >= 3, true);
});
test("normal encrypted sync keeps pack mode after a packed vault shrinks below object threshold", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(2_000, "packed"));
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  vault.files.clear();
  vault.mtimes.clear();
  for (let index = 0; index < 878; index++) vault.set(`moved/note-${String(index).padStart(5, "0")}.md`, new TextEncoder().encode(`moved-${index}`));

  await encryptedFullSync(instance);

  const objectPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/objects/"));
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.values(snapshot.files).every(record => record.storage === "pack"), true);
  assert.equal(objectPaths.length, 0);
});
test("normal encrypted sync migrates 2000-file local cache into v2 pack snapshot after app restart", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault(manyFileEntries(2_000, "legacy"));
  const instance = plugin(vault, github) as ReturnType<typeof plugin>;
  const store = new EncryptedManifestStore(github as unknown as GitHubClient, "correct horse battery staple", true);
  const loaded = await store.loadOrCreate();
  const manifest = loaded.manifest;
  const state = instance.syncData.encrypted!;

  for (const file of vault.getFiles()) {
    const bytes = new Uint8Array(await vault.readBinary(file));
    const plaintextSha256 = await sha256Hex(bytes);
    const id = plaintextSha256.slice(0, 24);
    const objectPath = `.obsidian-github-sync-encrypted/objects/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.enc`;
    manifest.files[file.path] = {
      id,
      path: file.path,
      objectPath,
      plaintextSha256,
      remoteSha: `legacy-${id}`,
      storage: "single",
      size: file.stat.size,
      mtime: file.stat.mtime,
      deleted: false,
    };
    state.files[file.path] = {
      plaintextSha256,
      objectPath,
      remoteSha: `legacy-${id}`,
      storage: "single",
      manifestUpdatedAt: manifest.updatedAt,
      size: file.stat.size,
      mtime: file.stat.mtime,
    };
  }
  const manifestSha = await store.save(manifest, loaded.key, loaded.manifestSha);
  state.manifestSha = manifestSha;
  instance.syncData.lastRemoteHeadSha = github.headSha;
  vault.readBinaryCount = 0;

  await encryptedFullSync(instance as never);

  const packPaths = [...github.blobs.keys()].filter(path => path.startsWith(".obsidian-github-sync-encrypted/packs/"));
  assert.equal(packPaths.length > 0, true);
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.values(snapshot.files).every(record => record.storage === "pack"), true);
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
  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(Object.keys(snapshot.packs ?? {}).length > 0, true);
  assert.equal(Object.values(snapshot.files).every(record => record.storage === "pack"), true);
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

  const { snapshot } = await loadV2Snapshot(github);

  assert.equal(snapshot.files["Notes/a.md"].plaintextSha256, await sha256Hex(utf8ToBytes("updated a")));
  assert.equal(snapshot.files["Notes/b.md"].plaintextSha256, await sha256Hex(utf8ToBytes("updated b")));
});

test("normal encrypted sync retries snapshot head CAS conflict with a fresh attempt", async () => {
  const github = new HeadCasConflictOnceGitHub();
  const vault = new MemoryVault({ "Notes/a.md": "initial" });
  const instance = plugin(vault, github) as never;
  await encryptedForcePush(instance);

  vault.set("Notes/a.md", utf8ToBytes("updated after CAS conflict"));
  github.failNextHeadCas = true;

  await encryptedFullSync(instance);

  const { snapshot } = await loadV2Snapshot(github);
  assert.equal(github.headCasFailures, 1);
  assert.equal(snapshot.files["Notes/a.md"].plaintextSha256, await sha256Hex(utf8ToBytes("updated after CAS conflict")));
  assert.equal(Notice.messages.some(message => message.includes("SnapshotHeadCasError")), false);
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

test("normal encrypted sync downloads files using 1-request getBlob when SHA is available", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault({ "Notes/a.md": "some remote content" });
  await encryptedForcePush(plugin(sourceVault, github) as never);

  const targetVault = new MemoryVault(); // Empty target
  const target = plugin(targetVault, github) as ReturnType<typeof plugin>;

  github.getBlobCount = 0;

  await encryptedFullSync(target as never);

  assert.ok(github.getBlobCount > 0);
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "some remote content");
});
