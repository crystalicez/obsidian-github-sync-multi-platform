import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import type { V4ConflictBatchRequest, V4ConflictBatchResolution } from "../../src/lib/v4/conflict-types";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { const file = this.files.get(path); if (!file) throw new Error(`Missing local file: ${path}`); return new Uint8Array(file.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? 0 }); }
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

async function diverged(files: Record<string, string>) {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  for (const [path, text] of Object.entries(files)) remoteVault.files.set(path, { bytes: enc(text), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = new MemoryVault();
  localVault.files = new Map([...remoteVault.files].map(([path]) => [path, { bytes: enc(`LOCAL ${path}\n`), mtime: 3 }]));
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";
  const changes = Object.keys(files).map(path => ({ type: "modify" as const, path, mtime: 2 }));
  for (const path of Object.keys(files)) remoteVault.files.set(path, { bytes: enc(`REMOTE ${path}\n`), mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes });
  return { github, localVault, localIndex };
}

function useRemote(request: V4ConflictBatchRequest): V4ConflictBatchResolution {
  return { runId: request.runId, generation: request.generation, files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-remote" as const })) };
}

test("transient conflict materialization failure is retryable within one generation", async () => {
  const fixture = await diverged({ "note.md": "base\n" });
  const original = fixture.github.getFileBytes.bind(fixture.github);
  let failed = false;
  fixture.github.getFileBytes = async (path: string, ref?: string) => {
    if (!failed && path === "note.md" && ref) { failed = true; throw new Error("transient materialization read"); }
    return original(path, ref);
  };
  let retried = false;
  await new V4SyncSession({
    github: fixture.github, vault: fixture.localVault, index: fixture.localIndex, config, conflictPolicy: "ask", abortChangePercent: 0,
    resolveConflictBatch: async request => {
      const file = request.files[0];
      await assert.rejects(request.materialize(file.fileId, request.generation), /transient materialization read/iu);
      assert.equal((await request.materialize(file.fileId, request.generation)).mode, "text");
      retried = true;
      return useRemote(request);
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 3 }] });
  assert.equal(retried, true);
});

test("conflict materialization cache evicts old files instead of retaining the full batch", async () => {
  const base = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`note-${index}.md`, `base ${index}\n`]));
  const fixture = await diverged(base);
  const original = fixture.github.getFileBytes.bind(fixture.github);
  const reads = new Map<string, number>();
  fixture.github.getFileBytes = async (path: string, ref?: string) => {
    if (ref && path.endsWith(".md")) reads.set(path, (reads.get(path) ?? 0) + 1);
    return original(path, ref);
  };
  await new V4SyncSession({
    github: fixture.github, vault: fixture.localVault, index: fixture.localIndex, config, conflictPolicy: "ask", abortChangePercent: 0,
    resolveConflictBatch: async request => {
      for (const file of request.files) assert.equal((await request.materialize(file.fileId, request.generation)).mode, "text");
      const first = request.files.find(file => file.displayPath === "note-0.md")!;
      const before = reads.get("note-0.md") ?? 0;
      await request.materialize(first.fileId, request.generation);
      assert.ok((reads.get("note-0.md") ?? 0) > before, "old materialization should have been evicted");
      return useRemote(request);
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: Object.keys(base).map(path => ({ type: "modify" as const, path, mtime: 3 })) });
});
