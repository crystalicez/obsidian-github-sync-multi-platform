import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import type { V4ConflictBatchRequest } from "../../src/lib/v4/conflict-types";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class Vault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { const file = this.files.get(path); if (!file) throw new Error(`Missing ${path}`); return new Uint8Array(file.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? 0 }); }
  async trash(path: string) { this.files.delete(path); }
}

class GitHubMemory {
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
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }; }
  async getTreeAt(treeSha: string) {
    const tree = this.trees.get(treeSha) ?? new Map();
    return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: `tree-blob-${index}`, size: bytes.byteLength, url: "" })) };
  }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha: tree, parents, message }); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); await this.createGitRef(sha); }
}

const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" };

async function fixture(count: number) {
  const github = new GitHubMemory();
  const remoteVault = new Vault();
  for (let i = 0; i < count; i++) remoteVault.files.set(`note-${i}.md`, { bytes: enc(`base ${i}\n`), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = new Vault();
  for (let i = 0; i < count; i++) localVault.files.set(`note-${i}.md`, { bytes: enc(`LOCAL ${i}\n`), mtime: 3 });
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";

  const changes = [] as Array<{ type: "modify"; path: string; mtime: number }>;
  for (let i = 0; i < count; i++) {
    remoteVault.files.set(`note-${i}.md`, { bytes: enc(`REMOTE ${i}\n`), mtime: 2 });
    changes.push({ type: "modify", path: `note-${i}.md`, mtime: 2 });
  }
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes });
  return { github, localVault, localIndex };
}

test("parallel conflict materialization keeps prefetched remote bodies bounded", async () => {
  const count = 6;
  const { github, localVault, localIndex } = await fixture(count);
  const remoteHead = github.ref!.sha;
  const originalGet = github.getFileBytes.bind(github);
  let currentRemoteReads = 0;
  github.getFileBytes = async (path: string, ref?: string) => {
    if (ref === remoteHead && path.endsWith(".md")) currentRemoteReads++;
    return originalGet(path, ref);
  };

  await new V4SyncSession({
    github,
    vault: localVault,
    index: localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async (request: V4ConflictBatchRequest) => {
      await Promise.all(request.files.map(file => request.materialize(file.fileId, request.generation)));
      assert.equal(currentRemoteReads, count, "each preview should fetch the current remote body once");
      return {
        runId: request.runId,
        generation: request.generation,
        files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "keep-both" as const })),
      };
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: Array.from({ length: count }, (_, i) => ({ type: "modify" as const, path: `note-${i}.md`, mtime: 3 })) });

  assert.ok(currentRemoteReads > count, "evicted previews must refetch instead of retaining every remote body");
});
