import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyV3LocalIndex, type V3LocalIndexAdapter } from "../../src/lib/encrypted-v3/local-index";
import { EncryptedV3SyncSession } from "../../src/lib/encrypted-v3/sync-session";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class FakeV3GitHub {
  refSha = "commit-0";
  treeSha = "tree-0";
  blobs = new Map<string, Uint8Array>();
  commits: Array<{ message: string; files: string[]; parents: string[] }> = [];
  getGitRefCount = 0;
  getGitCommitCount = 0;
  getTreeCount = 0;
  putFileCount = 0;
  private nextBlob = 0;
  private pendingTree: GitHubCreateTreeEntry[] = [];

  async getGitRef() {
    this.getGitRefCount += 1;
    return { ref: "refs/heads/main", sha: this.refSha, type: "commit" };
  }

  async getGitCommit(sha: string) {
    this.getGitCommitCount += 1;
    return { sha, treeSha: this.treeSha, parentShas: [] };
  }

  async getTree() {
    this.getTreeCount += 1;
    return { sha: this.treeSha, url: "", truncated: false, tree: [] };
  }

  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${++this.nextBlob}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }

  async createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string) {
    assert.equal(baseTree, this.treeSha);
    this.pendingTree = tree;
    this.treeSha = `tree-${this.commits.length + 1}`;
    return this.treeSha;
  }

  async createGitCommit(message: string, _tree: string, parents: string[]) {
    const sha = `commit-${this.commits.length + 1}`;
    this.commits.push({ message, files: this.pendingTree.map(entry => entry.path), parents });
    return sha;
  }

  async updateGitRef(sha: string, expectedSha?: string) {
    assert.equal(expectedSha, this.refSha);
    this.refSha = sha;
  }

  async putFile() {
    this.putFileCount += 1;
    throw new Error("putFile must not be used by encrypted v3 sync");
  }
}

class FakeV3Vault {
  listCount = 0;
  readCount = 0;
  constructor(private readonly files: Map<string, Uint8Array>) {}

  async listFiles() {
    this.listCount += 1;
    return [...this.files.entries()].map(([path, bytes]) => ({ path, size: bytes.byteLength, mtime: 1 }));
  }

  async read(path: string) {
    this.readCount += 1;
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes;
  }
}

function memoryAdapter(): V3LocalIndexAdapter & { writes: Map<string, string> } {
  const writes = new Map<string, string>();
  return {
    writes,
    async read(path: string) {
      const value = writes.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async write(path: string, data: string) {
      writes.set(path, data);
    },
    async exists(path: string) {
      return writes.has(path);
    },
    async mkdir(_path: string) {},
  };
}

test("v3 normal sync with unchanged remote and clean index does not scan vault or load manifests", async () => {
  const github = new FakeV3GitHub();
  const vault = new FakeV3Vault(new Map([["Notes/a.md", new TextEncoder().encode("a")]]));
  const adapter = memoryAdapter();
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.remoteCommitSha = "commit-0";

  const session = new EncryptedV3SyncSession({ github, vault, adapter, indexRoot: ".idx", index, keyMaterial: new TextEncoder().encode("key") });
  const result = await session.sync({ operation: "normal" });

  assert.equal(result.mode, "noop");
  assert.equal(github.getGitRefCount, 1);
  assert.equal(github.getTreeCount, 0);
  assert.equal(vault.listCount, 0);
  assert.equal(vault.readCount, 0);
});

test("v3 local modify writes object shard and head in one atomic commit without plaintext remote paths", async () => {
  const github = new FakeV3GitHub();
  const vault = new FakeV3Vault(new Map([["Secret Folder/a.md", new TextEncoder().encode("private")]]));
  const adapter = memoryAdapter();
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.remoteCommitSha = "commit-0";

  const session = new EncryptedV3SyncSession({ github, vault, adapter, indexRoot: ".idx", index, keyMaterial: new TextEncoder().encode("key") });
  const result = await session.flushLocalChanges([{ type: "modify", path: "Secret Folder/a.md", mtime: 2 }]);

  assert.equal(result.mode, "loose-delta");
  assert.equal(github.commits.length, 1);
  assert.equal(github.putFileCount, 0);
  assert.equal(github.getTreeCount, 0);
  assert.equal(vault.listCount, 0);
  assert.equal(vault.readCount, 1);
  assert.equal(github.commits[0].files.length, 3);
  assert.equal(github.commits[0].files.some(path => path.includes("Secret Folder") || path.includes("a.md")), false);
  assert.equal(github.commits[0].files.some(path => path.endsWith("/head.enc")), true);
  assert.equal(github.commits[0].files.some(path => path.includes("/shards/")), true);
  assert.equal(github.commits[0].files.some(path => path.includes("/objects/")), true);
  assert.equal(index.remoteCommitSha, "commit-1");
  assert.equal(adapter.writes.has(".idx/index.json"), true);
});

test("v3 local delete writes a tombstone shard and head without deleting objects in the hot path", async () => {
  const github = new FakeV3GitHub();
  const vault = new FakeV3Vault(new Map([["Notes/remove.md", new TextEncoder().encode("remove me")]]));
  const adapter = memoryAdapter();
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.remoteCommitSha = "commit-0";

  const session = new EncryptedV3SyncSession({ github, vault, adapter, indexRoot: ".idx", index, keyMaterial: new TextEncoder().encode("key") });
  await session.flushLocalChanges([{ type: "modify", path: "Notes/remove.md", mtime: 1 }]);
  const commitCountAfterCreate = github.commits.length;

  const result = await session.flushLocalChanges([{ type: "delete", path: "Notes/remove.md", mtime: 2 }]);

  assert.equal(result.mode, "loose-delta");
  assert.equal(github.commits.length, commitCountAfterCreate + 1);
  assert.equal(github.commits.at(-1)?.files.length, 2);
  assert.equal(github.commits.at(-1)?.files.some(path => path.includes("/shards/")), true);
  assert.equal(github.commits.at(-1)?.files.some(path => path.endsWith("/head.enc")), true);
  assert.equal(github.commits.at(-1)?.files.some(path => path.includes("/objects/")), false);
  assert.equal(Object.values(Object.values(index.shards)[0].records)[0].deleted, true);
});

test("v3 rename reuses the existing file identity and object when content is unchanged", async () => {
  const github = new FakeV3GitHub();
  const bytes = new TextEncoder().encode("same content");
  const vault = new FakeV3Vault(new Map([
    ["Notes/old.md", bytes],
    ["Notes/new.md", bytes],
  ]));
  const adapter = memoryAdapter();
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "device" });
  index.remoteCommitSha = "commit-0";
  const session = new EncryptedV3SyncSession({ github, vault, adapter, indexRoot: ".idx", index, keyMaterial: new TextEncoder().encode("key") });
  await session.flushLocalChanges([{ type: "modify", path: "Notes/old.md", mtime: 1 }]);
  const oldRecord = Object.values(Object.values(index.shards)[0].records)[0];

  const result = await session.flushLocalChanges([{ type: "rename", oldPath: "Notes/old.md", path: "Notes/new.md", mtime: 2 }]);
  const liveRecords = Object.values(index.shards).flatMap(shard => Object.values(shard.records).filter(record => !record.deleted));

  assert.equal(result.changedFiles, 1);
  assert.equal(liveRecords.length, 1);
  assert.equal(liveRecords[0].fileId, oldRecord.fileId);
  assert.equal(liveRecords[0].remoteVersion, oldRecord.remoteVersion);
  assert.equal(github.commits.at(-1)?.files.some(path => path.includes("old.md") || path.includes("new.md")), false);
});
