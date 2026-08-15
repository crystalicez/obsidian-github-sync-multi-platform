import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { createEmptyV4LocalIndex, type V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { coalesceV4Changes } from "../../src/lib/v4/sync-coordinator";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { return new Uint8Array(this.files.get(path)!.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() }); }
  async trash(path: string) { this.files.delete(path); }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined;
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path);
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) {
    const value = this.commits.get(sha)!;
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message };
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha: tree, parents, message });
    return sha;
  }
  async createGitRef(sha: string) {
    this.ref = { ref: "refs/heads/main", sha, type: "commit" };
    this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha));
  }
  async updateGitRef(sha: string, expected?: string) {
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref");
    await this.createGitRef(sha);
  }
}

function config(): V4RemoteConfig {
  return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" };
}

function recordByPath(index: ReturnType<typeof createEmptyV4LocalIndex>, path: string): V4IndexFileRecord {
  const record = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .find(candidate => !candidate.deleted && candidate.path === path);
  assert.ok(record, `missing index record for ${path}`);
  return record;
}

test("v4 ambiguous rename-chain rescan preserves recreate identity discontinuity", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("A.md", { bytes: enc("old A"), mtime: 1 });
  vault.files.set("B.md", { bytes: enc("old B"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = () => new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });

  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const beforeA = { ...recordByPath(index, "A.md") };
  const beforeB = { ...recordByPath(index, "B.md") };

  vault.files.delete("A.md");
  vault.files.delete("B.md");
  vault.files.set("C.md", { bytes: enc("new identity"), mtime: 5 });

  const changes = coalesceV4Changes([
    { type: "delete", path: "A.md", mtime: 2 },
    { type: "modify", path: "A.md", mtime: 3 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 4 },
    { type: "rename", oldPath: "B.md", path: "C.md", mtime: 5 },
  ]);
  assert.equal(changes.some(change => change.type === "rescan"), true);

  await session().sync({ operation: "normal", allowThresholdOverride: false, changes });

  const after = recordByPath(index, "C.md");
  assert.notEqual(after.fileId, beforeA.fileId);
  assert.notEqual(after.fileId, beforeB.fileId);
  assert.equal(github.files.has("A.md"), false);
  assert.equal(github.files.has("B.md"), false);
  assert.equal(github.files.has("C.md"), true);
});
