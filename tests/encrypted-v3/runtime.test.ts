import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";

import { encryptedV3ForcePull, encryptedV3ForcePush, encryptedV3Modify, flushEncryptedV3PendingChanges, shouldUseEncryptedV3 } from "../../src/lib/encrypted-v3/runtime";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class RuntimeGitHub {
  refSha = "commit-0";
  treeSha = "tree-0";
  blobs = new Map<string, Uint8Array>();
  files = new Map<string, { sha: string; bytes: Uint8Array }>();
  getTreeCount = 0;
  private nextBlob = 0;
  private pendingTree: GitHubCreateTreeEntry[] = [];
  commitCount = 0;

  async getGitRef() { return { ref: "refs/heads/main", sha: this.refSha, type: "commit" }; }
  async getGitCommit(sha: string) { return { sha, treeSha: this.treeSha, parentShas: [] }; }
  async getTree() {
    this.getTreeCount += 1;
    return {
      sha: this.treeSha,
      url: "",
      truncated: false,
      tree: [...this.files.entries()].map(([path, file]) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: file.sha,
        size: file.bytes.byteLength,
        url: "",
      })),
    };
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${++this.nextBlob}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }
  async createGitTree(tree: GitHubCreateTreeEntry[], _baseTree?: string) {
    this.pendingTree = tree;
    for (const entry of tree) {
      if (entry.sha === null) this.files.delete(entry.path);
      else this.files.set(entry.path, { sha: entry.sha, bytes: this.blobs.get(entry.sha) ?? new Uint8Array() });
    }
    this.treeSha = `tree-${this.nextBlob}`;
    return this.treeSha;
  }
  async createGitCommit() {
    this.commitCount += 1;
    return `commit-${this.nextBlob}`;
  }
  async updateGitRef(sha: string) { this.refSha = sha; }
  async putFile() { throw new Error("v3 runtime must not use Contents API putFile"); }
  async getFile(path: string) {
    const file = this.files.get(path);
    if (!file) return null;
    return { path, sha: file.sha, content: Buffer.from(file.bytes).toString("base64"), size: file.bytes.byteLength };
  }
  committedPaths() { return this.pendingTree.map(entry => entry.path); }
}

class RuntimeVault {
  files = new Map<string, Uint8Array>();
  indexFiles = new Map<string, string>();
  getFilesCount = 0;
  readBinaryCount = 0;
  adapterWriteCount = 0;
  adapterReadCount = 0;
  adapterExistsCount = 0;
  configDir = ".obsidian";
  adapter = {
    read: async (path: string) => {
      this.adapterReadCount += 1;
      const value = this.indexFiles.get(path);
      if (value === undefined) throw new Error(`missing adapter file ${path}`);
      return value;
    },
    write: async (path: string, data: string) => {
      this.adapterWriteCount += 1;
      this.indexFiles.set(path, data);
    },
    exists: async (path: string) => {
      this.adapterExistsCount += 1;
      return this.indexFiles.has(path);
    },
    mkdir: async (_path: string) => {},
  };
  constructor(entries: Record<string, string>) {
    for (const [path, text] of Object.entries(entries)) this.files.set(path, new TextEncoder().encode(text));
  }
  getFiles() {
    this.getFilesCount += 1;
    return [...this.files.entries()].map(([path, bytes]) => new TFile(path, bytes));
  }
  getAbstractFileByPath(path: string) {
    const bytes = this.files.get(path);
    return bytes ? new TFile(path, bytes) : null;
  }
  async readBinary(file: TFile) {
    this.readBinaryCount += 1;
    return (this.files.get(file.path) ?? new Uint8Array()).buffer.slice(0) as ArrayBuffer;
  }
  async createFolder(_path: string) {}
  async createBinary(path: string, bytes: ArrayBuffer) { this.files.set(path, new Uint8Array(bytes)); }
  async modifyBinary(file: TFile, bytes: ArrayBuffer) { this.files.set(file.path, new Uint8Array(bytes)); }
  async delete(file: TFile) { this.files.delete(file.path); }
}

class RuntimeVaultWithoutAdapter extends RuntimeVault {
  adapter = undefined as never;
}

function plugin(vault: RuntimeVault, github: RuntimeGitHub) {
  let saveSyncDataCount = 0;
  return {
    manifest: { id: "encrypted-github-sync-multi-platform" },
    app: { vault },
    githubClient: github,
    settings: {
      encryptionMode: "encrypted",
      encryptedProtocolVersion: "v3",
      encryptionPassphrase: "passphrase",
      githubOwner: "owner",
      githubRepo: "repo",
      githubBranch: "main",
      ignorePathRegex: "",
      vault: "test-device",
      consoleLoggingEnabled: false,
    },
    syncData: { files: {} },
    syncProgress: { status: "idle", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: 0 },
    isSyncInProgress: false,
    isWatchEnabled: true,
    get saveSyncDataCount() { return saveSyncDataCount; },
    async saveSyncData() { saveSyncDataCount += 1; },
    updateStatusBar() {},
  };
}

test("encrypted v3 runtime force push and force pull round trip without plaintext remote paths", async () => {
  const github = new RuntimeGitHub();
  const source = plugin(new RuntimeVault({ "Secret/a.md": "hello" }), github);
  await encryptedV3ForcePush(source as never);

  assert.equal(shouldUseEncryptedV3(source as never), true);
  assert.equal(github.committedPaths().some(path => path.includes("Secret") || path.includes("a.md")), false);

  const targetVault = new RuntimeVault({ "local-only.md": "delete me" });
  await encryptedV3ForcePull(plugin(targetVault, github) as never);

  assert.equal(new TextDecoder().decode(targetVault.files.get("Secret/a.md")), "hello");
  assert.equal(targetVault.files.has("local-only.md"), false);
});

test("encrypted v3 runtime local modify reads only the changed file", async () => {
  const github = new RuntimeGitHub();
  const vault = new RuntimeVault({ "Notes/a.md": "one", "Notes/b.md": "two" });
  const instance = plugin(vault, github);
  await encryptedV3ForcePush(instance as never);
  vault.getFilesCount = 0;
  vault.readBinaryCount = 0;
  vault.files.set("Notes/a.md", new TextEncoder().encode("changed"));

  await encryptedV3Modify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false);

  assert.equal(vault.getFilesCount, 0);
  assert.equal(vault.readBinaryCount, 1);
});

test("encrypted v3 runtime batches watcher modify events into one commit", async () => {
  const github = new RuntimeGitHub();
  const vault = new RuntimeVault({ "Notes/a.md": "one", "Notes/b.md": "two", "Notes/c.md": "three" });
  const instance = plugin(vault, github);
  await encryptedV3ForcePush(instance as never);
  github.commitCount = 0;
  vault.readBinaryCount = 0;

  vault.files.set("Notes/a.md", new TextEncoder().encode("changed a"));
  vault.files.set("Notes/b.md", new TextEncoder().encode("changed b"));
  vault.files.set("Notes/c.md", new TextEncoder().encode("changed c"));
  await encryptedV3Modify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, true);
  await encryptedV3Modify(vault.getAbstractFileByPath("Notes/b.md") as TFile, instance as never, true);
  await encryptedV3Modify(vault.getAbstractFileByPath("Notes/c.md") as TFile, instance as never, true);

  assert.equal(github.commitCount, 0);
  await flushEncryptedV3PendingChanges(instance as never);

  assert.equal(github.commitCount, 1);
  assert.equal(vault.readBinaryCount, 3);
});

test("encrypted v3 runtime stores local index in physical sharded adapter files without saveData churn", async () => {
  const github = new RuntimeGitHub();
  const vault = new RuntimeVault({ "Notes/a.md": "one" });
  const instance = plugin(vault, github);

  await encryptedV3ForcePush(instance as never);

  assert.equal(instance.saveSyncDataCount, 0);
  assert.ok(vault.adapterWriteCount > 0);
  assert.ok(vault.indexFiles.has(".obsidian/plugins/encrypted-github-sync-multi-platform/encrypted-v3-index/index.json"));
  assert.ok([...vault.indexFiles.keys()].some(path => path.startsWith(".obsidian/plugins/encrypted-github-sync-multi-platform/encrypted-v3-index/shards/")));

  vault.files.set("Notes/a.md", new TextEncoder().encode("two"));
  await encryptedV3Modify(vault.getAbstractFileByPath("Notes/a.md") as TFile, instance as never, false);

  assert.equal(instance.saveSyncDataCount, 0);
});

test("encrypted v3 runtime falls back to non-persistent memory index when vault adapter is unavailable", async () => {
  const github = new RuntimeGitHub();
  const vault = new RuntimeVaultWithoutAdapter({ "Notes/a.md": "one" });
  const instance = plugin(vault, github);

  await encryptedV3ForcePush(instance as never);

  assert.equal(instance.saveSyncDataCount, 0);
  assert.ok(github.committedPaths().some(path => path.endsWith("/head.enc")));
  assert.equal(vault.files.has("Notes/a.md"), true);
});
