import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyV3LocalIndex, type V3LocalIndexAdapter } from "../../src/lib/encrypted-v3/local-index";
import { EncryptedV3SyncSession } from "../../src/lib/encrypted-v3/sync-session";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class FakeV3GitHub {
  refSha = "commit-0";
  treeSha = "tree-0";
  blobs = new Map<string, Uint8Array>();
  files = new Map<string, { sha: string; bytes: Uint8Array }>();
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

  async createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string) {
    assert.equal(baseTree, this.treeSha);
    this.pendingTree = tree;
    for (const entry of tree) {
      if (entry.sha === null) {
        this.files.delete(entry.path);
        continue;
      }
      this.files.set(entry.path, { sha: entry.sha, bytes: this.blobs.get(entry.sha) ?? new Uint8Array() });
    }
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

  async getFile(path: string) {
    const file = this.files.get(path);
    if (!file) return null;
    return { path, sha: file.sha, content: Buffer.from(file.bytes).toString("base64"), size: file.bytes.byteLength };
  }
}

class FakeV3Vault {
  listCount = 0;
  readCount = 0;
  writeCount = 0;
  deleteCount = 0;
  constructor(readonly files: Map<string, Uint8Array>) {}

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

  async write(path: string, bytes: Uint8Array) {
    this.writeCount += 1;
    this.files.set(path, new Uint8Array(bytes));
  }

  async delete(path: string) {
    this.deleteCount += 1;
    this.files.delete(path);
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

test("v3 force pull mirrors remote records to local vault and deletes local extras", async () => {
  const github = new FakeV3GitHub();
  const sourceVault = new FakeV3Vault(new Map([["Notes/a.md", new TextEncoder().encode("remote")]]));
  const sourceIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  sourceIndex.remoteCommitSha = "commit-0";
  await new EncryptedV3SyncSession({
    github,
    vault: sourceVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-source",
    index: sourceIndex,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "forcePush" });

  const targetVault = new FakeV3Vault(new Map([["local-only.md", new TextEncoder().encode("delete me")]]));
  const targetIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" });
  const target = new EncryptedV3SyncSession({
    github,
    vault: targetVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-target",
    index: targetIndex,
    keyMaterial: new TextEncoder().encode("key"),
  });

  const result = await target.sync({ operation: "forcePull" });

  assert.equal(result.mode, "force-pull");
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "remote");
  assert.equal(targetVault.files.has("local-only.md"), false);
  assert.equal(targetVault.writeCount, 1);
  assert.equal(targetVault.deleteCount, 1);
});

test("v3 normal sync pulls remote changes without deleting local-only files", async () => {
  const github = new FakeV3GitHub();
  const sourceVault = new FakeV3Vault(new Map([["Notes/remote.md", new TextEncoder().encode("remote wins")]]));
  const sourceIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  sourceIndex.remoteCommitSha = "commit-0";
  await new EncryptedV3SyncSession({
    github,
    vault: sourceVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-source",
    index: sourceIndex,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "forcePush" });

  const targetVault = new FakeV3Vault(new Map([["local-only.md", new TextEncoder().encode("old")]]));
  const targetIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" });
  targetIndex.remoteCommitSha = "commit-0";
  const result = await new EncryptedV3SyncSession({
    github,
    vault: targetVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-target",
    index: targetIndex,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "normal" });

  assert.equal(result.operation, "normal");
  assert.equal(result.mode, "force-pull");
  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/remote.md")), "remote wins");
  assert.equal(new TextDecoder().decode(targetVault.files.get("local-only.md")), "old");
});

test("v3 normal sync copies remote conflict instead of overwriting different local content", async () => {
  const github = new FakeV3GitHub();
  const sourceVault = new FakeV3Vault(new Map([["Notes/a.md", new TextEncoder().encode("remote")]]));
  const sourceIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  sourceIndex.remoteCommitSha = "commit-0";
  await new EncryptedV3SyncSession({
    github,
    vault: sourceVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-source",
    index: sourceIndex,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "forcePush" });

  const targetVault = new FakeV3Vault(new Map([["Notes/a.md", new TextEncoder().encode("local")]]));
  const targetIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" });
  targetIndex.remoteCommitSha = "commit-0";
  await new EncryptedV3SyncSession({
    github,
    vault: targetVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-target",
    index: targetIndex,
    keyMaterial: new TextEncoder().encode("key"),
    conflictPolicy: "copy",
  }).sync({ operation: "normal" });

  assert.equal(new TextDecoder().decode(targetVault.files.get("Notes/a.md")), "local");
  const conflictPath = [...targetVault.files.keys()].find(path => path.includes(".sync-conflict-") && path.includes("-remote"));
  assert.ok(conflictPath);
  assert.equal(new TextDecoder().decode(targetVault.files.get(conflictPath)), "remote");
});

test("v3 normal sync refuses to overwrite remote changes when local index is dirty", async () => {
  const github = new FakeV3GitHub();
  github.refSha = "commit-remote";
  const vault = new FakeV3Vault(new Map([["Notes/local.md", new TextEncoder().encode("local")]]));
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" });
  index.remoteCommitSha = "commit-old";
  index.shards.aa = {
    hash: "old",
    records: {
      local: {
        path: "Notes/local.md",
        pathId: "local",
        fileId: "local-file",
        plaintextSha256: "sha",
        size: 5,
        mtime: 1,
        remoteVersion: "1:sha",
        dirty: true,
      },
    },
  };

  await assert.rejects(
    () => new EncryptedV3SyncSession({
      github,
      vault,
      adapter: memoryAdapter(),
      indexRoot: ".idx",
      index,
      keyMaterial: new TextEncoder().encode("key"),
    }).sync({ operation: "normal" }),
    /remote changed/u,
  );

  assert.equal(github.commits.length, 0);
  assert.equal(vault.listCount, 0);
});

test("v3 local change refuses to push when the remote head changed first", async () => {
  const github = new FakeV3GitHub();
  github.refSha = "commit-remote";
  const vault = new FakeV3Vault(new Map([["Notes/local.md", new TextEncoder().encode("local")]]));
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" });
  index.remoteCommitSha = "commit-old";

  await assert.rejects(
    () => new EncryptedV3SyncSession({
      github,
      vault,
      adapter: memoryAdapter(),
      indexRoot: ".idx",
      index,
      keyMaterial: new TextEncoder().encode("key"),
    }).flushLocalChanges([{ type: "modify", path: "Notes/local.md", mtime: 1 }]),
    /remote changed/u,
  );

  assert.equal(github.getGitRefCount, 1);
  assert.equal(github.commits.length, 0);
  assert.equal(vault.readCount, 0);
});

test("v3 force push packs thousands of small files instead of writing one object per file", async () => {
  const github = new FakeV3GitHub();
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < 2_000; index++) entries.set(`Notes/note-${index}.md`, new TextEncoder().encode(`note ${index}`));
  const vault = new FakeV3Vault(entries);
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  index.remoteCommitSha = "commit-0";

  const result = await new EncryptedV3SyncSession({
    github,
    vault,
    adapter: memoryAdapter(),
    indexRoot: ".idx",
    index,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "forcePush" });

  assert.equal(result.mode, "force-push");
  assert.equal(github.commits.length, 1);
  assert.equal(github.commits[0].files.filter(path => path.includes("/objects/")).length, 0);
  assert.equal(github.commits[0].files.filter(path => path.includes("/packs/base/")).length, 1);
  assert.ok(github.commits[0].files.length < 270);
});

test("v3 force push deletes obsolete encrypted v3 remote objects", async () => {
  const github = new FakeV3GitHub();
  github.files.set(".obsidian-github-sync-v3/objects/aa/bb/old.bin.enc", { sha: "old-object", bytes: new TextEncoder().encode("old") });
  github.files.set(".obsidian-github-sync-v3/packs/base/old.pack.enc", { sha: "old-pack", bytes: new TextEncoder().encode("old") });
  github.files.set("README.md", { sha: "readme", bytes: new TextEncoder().encode("keep") });
  const vault = new FakeV3Vault(new Map([["Notes/a.md", new TextEncoder().encode("new")]]));
  const index = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  index.remoteCommitSha = "commit-0";

  await new EncryptedV3SyncSession({
    github,
    vault,
    adapter: memoryAdapter(),
    indexRoot: ".idx",
    index,
    keyMaterial: new TextEncoder().encode("key"),
  }).sync({ operation: "forcePush" });

  assert.equal(github.files.has(".obsidian-github-sync-v3/objects/aa/bb/old.bin.enc"), false);
  assert.equal(github.files.has(".obsidian-github-sync-v3/packs/base/old.pack.enc"), false);
  assert.equal(github.files.has("README.md"), true);
});

test("v3 local modify chunks large files and force pull reassembles them", async () => {
  const github = new FakeV3GitHub();
  const bytes = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
  const sourceVault = new FakeV3Vault(new Map([["Media/big.bin", bytes]]));
  const sourceIndex = createEmptyV3LocalIndex({ repoId: "repo", deviceId: "source" });
  sourceIndex.remoteCommitSha = "commit-0";
  const source = new EncryptedV3SyncSession({
    github,
    vault: sourceVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-source",
    index: sourceIndex,
    keyMaterial: new TextEncoder().encode("key"),
    looseObjectMaxBytes: 10,
  });

  await source.flushLocalChanges([{ type: "modify", path: "Media/big.bin", mtime: 1 }]);

  const uploaded = github.commits.at(-1)?.files ?? [];
  assert.equal(uploaded.filter(path => path.includes("/objects/")).length, 0);
  assert.ok(uploaded.filter(path => path.includes("/chunks/")).length > 1);

  const targetVault = new FakeV3Vault(new Map());
  const target = new EncryptedV3SyncSession({
    github,
    vault: targetVault,
    adapter: memoryAdapter(),
    indexRoot: ".idx-target",
    index: createEmptyV3LocalIndex({ repoId: "repo", deviceId: "target" }),
    keyMaterial: new TextEncoder().encode("key"),
    looseObjectMaxBytes: 10,
  });

  await target.sync({ operation: "forcePull" });

  assert.equal(new TextDecoder().decode(targetVault.files.get("Media/big.bin")), "0123456789abcdefghijklmnopqrstuvwxyz");
});
