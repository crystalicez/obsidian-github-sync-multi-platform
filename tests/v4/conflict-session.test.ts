import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import type { V4ConflictBatchRequest, V4ConflictBatchResolution } from "../../src/lib/v4/conflict-types";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

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
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); this.refUpdates++; await this.createGitRef(sha); }
}

function config(): V4RemoteConfig { return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" }; }

async function commonBase(files: Record<string, string>) {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  for (const [path, content] of Object.entries(files)) remoteVault.files.set(path, { bytes: enc(content), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  const localVault = new MemoryVault();
  localVault.files = new Map([...remoteVault.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]));
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";
  return { github, remoteVault, remoteIndex, localVault, localIndex };
}

async function divergeSamePaths(files: Record<string, string>, remoteText: (path: string, base: string) => string, localText: (path: string, base: string) => string) {
  const fixture = await commonBase(files);
  const changes = [] as Array<{ type: "modify"; path: string; mtime: number }>;
  for (const [path, base] of Object.entries(files)) {
    fixture.remoteVault.files.set(path, { bytes: enc(remoteText(path, base)), mtime: 2 });
    fixture.localVault.files.set(path, { bytes: enc(localText(path, base)), mtime: 3 });
    changes.push({ type: "modify", path, mtime: 2 });
  }
  await new V4SyncSession({ github: fixture.github, vault: fixture.remoteVault, index: fixture.remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes });
  return fixture;
}

function useRemote(request: V4ConflictBatchRequest): V4ConflictBatchResolution {
  return {
    runId: request.runId,
    generation: request.generation,
    files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-remote" as const })),
  };
}

test("two planner conflicts become one deferred batch and no ref changes while waiting", async () => {
  const fixture = await divergeSamePaths(
    { "a.md": "base a\n", "b.md": "base b\n" },
    path => `remote ${path}\n`,
    path => `local ${path}\n`,
  );
  const headBefore = fixture.github.ref!.sha;
  const updatesBefore = fixture.github.refUpdates;
  const reached = deferred<V4ConflictBatchRequest>();
  const release = deferred<V4ConflictBatchResolution>();
  const syncing = new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async request => { reached.resolve(request); return release.promise; },
  }).sync({ operation: "normal", allowThresholdOverride: false });

  const batch = await reached.promise;
  assert.equal(batch.files.length, 2);
  assert.equal(fixture.github.ref!.sha, headBefore);
  assert.equal(fixture.github.refUpdates, updatesBefore);
  release.resolve(useRemote(batch));
  await syncing;
  assert.equal(dec(fixture.localVault.files.get("a.md")!.bytes), "remote a.md\n");
  assert.equal(dec(fixture.localVault.files.get("b.md")!.bytes), "remote b.md\n");
});

test("copy and newer policies do not invoke the batch callback", async () => {
  for (const policy of ["copy", "newer"] as const) {
    const fixture = await divergeSamePaths({ "note.md": "base\n" }, () => "remote\n", () => "local\n");
    let batches = 0;
    await new V4SyncSession({
      github: fixture.github,
      vault: fixture.localVault,
      index: fixture.localIndex,
      config: config(),
      conflictPolicy: policy,
      abortChangePercent: 0,
      resolveConflictBatch: async request => { batches++; return useRemote(request); },
    }).sync({ operation: "normal", allowThresholdOverride: false });
    assert.equal(batches, 0, policy);
  }
});

test("force operations never invoke conflict batch resolution", async () => {
  const fixture = await divergeSamePaths({ "note.md": "base\n" }, () => "remote\n", () => "local\n");
  let batches = 0;
  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async request => { batches++; return useRemote(request); },
  }).sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(batches, 0);
});

test("merge policy auto-resolves disjoint text changes without a batch", async () => {
  const fixture = await divergeSamePaths(
    { "note.md": "one\ntwo\nthree\n" },
    () => "REMOTE\ntwo\nthree\n",
    () => "one\ntwo\nLOCAL\n",
  );
  let batches = 0;
  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "merge",
    abortChangePercent: 0,
    resolveConflictBatch: async request => { batches++; return useRemote(request); },
  }).sync({ operation: "normal", allowThresholdOverride: false });
  assert.equal(batches, 0);
  assert.equal(dec(fixture.localVault.files.get("note.md")!.bytes), "REMOTE\ntwo\nLOCAL\n");
});

test("merge policy sends overlapping text conflict to one batch", async () => {
  const fixture = await divergeSamePaths({ "note.md": "base\n" }, () => "REMOTE\n", () => "LOCAL\n");
  let seen: V4ConflictBatchRequest | undefined;
  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "merge",
    abortChangePercent: 0,
    resolveConflictBatch: async request => { seen = request; return {
      runId: request.runId,
      generation: request.generation,
      files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-local" as const })),
    }; },
  }).sync({ operation: "normal", allowThresholdOverride: false });
  assert.ok(seen);
  assert.equal(seen.files.length, 1);
  assert.equal(seen.files[0].textCandidate, true);
});

test("divergent rename materializes as a file-level structural conflict", async () => {
  const fixture = await commonBase({ "note.md": "body\n" });
  const remoteFile = fixture.remoteVault.files.get("note.md")!;
  fixture.remoteVault.files.delete("note.md");
  fixture.remoteVault.files.set("remote.md", { ...remoteFile, mtime: 2 });
  await new V4SyncSession({ github: fixture.github, vault: fixture.remoteVault, index: fixture.remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "note.md", path: "remote.md", mtime: 2 }] });

  const localFile = fixture.localVault.files.get("note.md")!;
  fixture.localVault.files.delete("note.md");
  fixture.localVault.files.set("local.md", { ...localFile, mtime: 3 });
  let materializedMode: string | undefined;
  let textCandidate: boolean | undefined;
  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async request => {
      textCandidate = request.files[0].textCandidate;
      materializedMode = (await request.materialize(request.files[0].fileId, request.generation)).mode;
      return {
        runId: request.runId,
        generation: request.generation,
        files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-local" as const })),
      };
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "note.md", path: "local.md", mtime: 3 }] });
  assert.equal(textCandidate, false);
  assert.equal(materializedMode, "file");
});
