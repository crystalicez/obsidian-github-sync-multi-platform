import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";

import { encryptedV3ForcePull, encryptedV3ForcePush, encryptedV3Modify, shouldUseEncryptedV3 } from "../../src/lib/encrypted-v3/runtime";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class RuntimeGitHub {
  refSha = "commit-0";
  treeSha = "tree-0";
  blobs = new Map<string, Uint8Array>();
  files = new Map<string, { sha: string; bytes: Uint8Array }>();
  private nextBlob = 0;
  private pendingTree: GitHubCreateTreeEntry[] = [];

  async getGitRef() { return { ref: "refs/heads/main", sha: this.refSha, type: "commit" }; }
  async getGitCommit(sha: string) { return { sha, treeSha: this.treeSha, parentShas: [] }; }
  async getTree() { throw new Error("v3 runtime must not use recursive tree"); }
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
  async createGitCommit() { return `commit-${this.nextBlob}`; }
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
  getFilesCount = 0;
  readBinaryCount = 0;
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

function plugin(vault: RuntimeVault, github: RuntimeGitHub) {
  return {
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
    async saveSyncData() {},
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
