import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { encryptedForcePull, encryptedForcePush } from "../../src/lib/encrypted/sync-engine";
import { GitHubClient } from "../../src/lib/github-api";

class MemoryGitHub {
  blobs = new Map<string, { content: string; sha: string }>();
  counter = 0;

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

  async putFile(path: string, content: string | ArrayBuffer) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const base64 = Buffer.from(bytes).toString("base64");
    const sha = `sha-${++this.counter}`;
    this.blobs.set(path, { content: base64, sha });
    return sha;
  }
}

class MemoryVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();

  constructor(entries: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(entries)) this.set(path, new TextEncoder().encode(content));
  }

  set(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
    this.mtimes.set(path, Date.now());
  }

  getFiles() {
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
      encryptionPassphrase: "correct horse battery staple",
      ignorePathRegex: "",
      conflictPolicy: "copy",
    },
    syncData: { files: {}, encrypted: { files: {} } },
    isSyncInProgress: false,
    disableWatch() {},
    enableWatch() {},
    addIgnoredFile(_path: string) {},
    removeIgnoredFile(_path: string) {},
    async saveSyncData() {},
  };
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
