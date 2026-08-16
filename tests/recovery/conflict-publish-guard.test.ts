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
  refUpdates = 0;
  onCreateCommit?: () => void;
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
  async createGitCommit(message: string, tree: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha: tree, parents, message });
    this.onCreateCommit?.();
    return sha;
  }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); this.refUpdates++; await this.createGitRef(sha); }
}

function config(): V4RemoteConfig { return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" }; }

async function fixture() {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("note.md", { bytes: enc("base\n"), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  const localVault = new MemoryVault();
  localVault.files.set("note.md", { bytes: enc("local\n"), mtime: 3 });
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";
  remoteVault.files.set("note.md", { bytes: enc("remote\n"), mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 2 }] });
  github.refUpdates = 0;
  return { github, localVault, localIndex };
}

function useLocal(request: V4ConflictBatchRequest): V4ConflictBatchResolution {
  return {
    runId: request.runId,
    generation: request.generation,
    files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-local" as const })),
  };
}

test("local conflict input changed after Continue but before ref publication prevents updateGitRef", async () => {
  const f = await fixture();
  let mutated = false;
  f.github.onCreateCommit = () => {
    if (mutated) return;
    mutated = true;
    f.localVault.files.set("note.md", { bytes: enc("newer local\n"), mtime: 4 });
  };

  const syncing = new V4SyncSession({
    github: f.github,
    vault: f.localVault,
    index: f.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async request => useLocal(request),
  }).sync({ operation: "normal", allowThresholdOverride: false });

  await assert.rejects(syncing, /conflict.*replan|local.*changed/iu);
  assert.equal(mutated, true, "test must mutate after candidate commit creation");
  assert.equal(f.github.refUpdates, 0, "stale resolved conflict must never publish its candidate ref");
});
