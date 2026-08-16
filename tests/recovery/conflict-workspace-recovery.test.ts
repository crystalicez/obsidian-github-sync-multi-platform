import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source";
import type { V4ConflictBatchRequest, V4ConflictBatchResolution } from "../../src/lib/v4/conflict-types";
import { createEmptyV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { createV4RecoveryStore, recoverV4PendingState } from "../../src/lib/v4/recovery-store";
import { createV4StagingStore } from "../../src/lib/v4/staging-store";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

class MemoryStageBackend {
  files = new Map<string, Uint8Array>();
  boundedAppend = true;
  async write(path: string, bytes: Uint8Array) { this.files.set(path, new Uint8Array(bytes)); }
  async append(path: string, bytes: Uint8Array) {
    const current = this.files.get(path) ?? new Uint8Array();
    const next = new Uint8Array(current.byteLength + bytes.byteLength);
    next.set(current); next.set(bytes, current.byteLength); this.files.set(path, next);
  }
  async remove(path: string) { this.files.delete(path); }
  async openSource(path: string, size: number) {
    const bytes = this.files.get(path);
    if (!bytes || bytes.byteLength !== size) throw new Error(`Missing stage: ${path}`);
    return createV4WholeBufferContentSource(bytes);
  }
  async freeBytes() { return Number.MAX_SAFE_INTEGER; }
}

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  private stageId = 0;
  private readonly stageBackend = new MemoryStageBackend();
  readonly staging = createV4StagingStore({
    root: "stage",
    backend: this.stageBackend,
    wholeBufferCeilingBytes: 32 * 1024 * 1024,
    randomId: () => `s${++this.stageId}`,
  });
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
  crashAfterRefUpdate = false;
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
  async updateGitRef(sha: string, expected?: string) {
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref");
    this.refUpdates++;
    await this.createGitRef(sha);
    if (this.crashAfterRefUpdate) throw new Error("simulated crash after ref update");
  }
}

class MemoryAdapter implements V4LocalIndexAdapter {
  values = new Map<string, string>();
  async read(path: string) { return this.values.get(path)!; }
  async write(path: string, value: string) { this.values.set(path, value); }
  async exists(path: string) { return this.values.has(path); }
  async mkdir() {}
}

const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" };

async function divergedFixture() {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("note.md", { bytes: enc("base\n"), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = new MemoryVault();
  localVault.files.set("note.md", { bytes: enc("local\n"), mtime: 3 });
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";

  remoteVault.files.set("note.md", { bytes: enc("remote\n"), mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 2 }] });
  github.refUpdates = 0;
  return { github, localVault, localIndex };
}

function keepBoth(request: V4ConflictBatchRequest): V4ConflictBatchResolution {
  return {
    runId: request.runId,
    generation: request.generation,
    files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "keep-both" as const })),
  };
}

function merged(request: V4ConflictBatchRequest, text = "merged\n"): V4ConflictBatchResolution {
  return {
    runId: request.runId,
    generation: request.generation,
    files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "merged" as const, path: file.displayPath, bytes: enc(text) })),
  };
}

async function runKeepBothCollision(collisionPath: string) {
  const fixture = await divergedFixture();
  const now = () => 100;
  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    now,
    resolveConflictBatch: async request => {
      fixture.localVault.files.set(collisionPath, { bytes: enc("USER COLLISION\n"), mtime: 99 });
      return keepBoth(request);
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 3 }] });
  return fixture;
}

test("keep-both re-reserves when the exact conflict-copy path appears while the resolver waits", async () => {
  const occupied = "note.conflict-remote-local-100.md";
  const fixture = await runKeepBothCollision(occupied);
  assert.equal(dec(fixture.localVault.files.get(occupied)!.bytes), "USER COLLISION\n");
  const copies = [...fixture.localVault.files].filter(([path, file]) => path !== "note.md" && path !== occupied && dec(file.bytes) === "remote\n");
  assert.equal(copies.length, 1, `expected one safely re-reserved remote copy, got: ${[...fixture.localVault.files.keys()].join(", ")}`);
  assert.notEqual(copies[0][0].toLocaleLowerCase("en-US"), occupied.toLocaleLowerCase("en-US"));
});

test("keep-both avoids case-insensitive conflict-copy collisions", async () => {
  const occupied = "NOTE.CONFLICT-REMOTE-LOCAL-100.MD";
  const fixture = await runKeepBothCollision(occupied);
  assert.equal(dec(fixture.localVault.files.get(occupied)!.bytes), "USER COLLISION\n");
  const lowered = new Set<string>();
  for (const path of fixture.localVault.files.keys()) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    assert.equal(lowered.has(key), false, `case-insensitive collision remained at ${path}`);
    lowered.add(key);
  }
  assert.equal([...fixture.localVault.files.values()].some(file => dec(file.bytes) === "remote\n"), true);
});

test("confirmed merged bytes survive an ambiguous crash after publication and recover through existing staging", async () => {
  const fixture = await divergedFixture();
  const adapter = new MemoryAdapter();
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId });
  fixture.github.crashAfterRefUpdate = true;

  await assert.rejects(new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    recoveryStore,
    runState: { runId: "merge-crash", conflictCopies: new Map(), conflictCopyStages: new Map() },
    resolveConflictBatch: async request => merged(request),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 3 }] }), /simulated crash/iu);

  assert.equal(fixture.github.refUpdates, 1);
  assert.equal(dec(fixture.github.files.get("note.md")!), "merged\n");
  assert.equal(dec(fixture.localVault.files.get("note.md")!.bytes), "local\n", "local mutation waits for verified recovery");
  const pending = await recoveryStore.load();
  assert.ok(pending);
  assert.equal(pending.header.phase, "publish-intent");

  fixture.github.crashAfterRefUpdate = false;
  const recovered = await recoverV4PendingState({
    store: recoveryStore,
    snapshot: pending,
    io: fixture.localVault,
    currentRemoteHead: fixture.github.ref!.sha,
    publicationGithub: fixture.github,
  });
  assert.equal(dec(fixture.localVault.files.get("note.md")!.bytes), "merged\n");
  assert.equal(recovered.replanRequired, true, "index still needs replanning/commit after recovered local mutation");
});

test("merged resolution changed locally before publication performs zero ref updates", async () => {
  const fixture = await divergedFixture();
  const adapter = new MemoryAdapter();
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId });
  let mutated = false;
  fixture.github.onCreateCommit = () => {
    if (mutated) return;
    mutated = true;
    fixture.localVault.files.set("note.md", { bytes: enc("newer local\n"), mtime: 4 });
  };

  await assert.rejects(new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    recoveryStore,
    runState: { runId: "merge-guard", conflictCopies: new Map(), conflictCopyStages: new Map() },
    resolveConflictBatch: async request => merged(request),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 3 }] }), /conflict.*replan|local.*changed/iu);

  assert.equal(mutated, true);
  assert.equal(fixture.github.refUpdates, 0);
  assert.equal(dec(fixture.localVault.files.get("note.md")!.bytes), "newer local\n");
  const pending = await recoveryStore.load();
  assert.ok(pending);
  assert.equal(pending.header.phase, "publish-intent");
  assert.equal((pending.payload?.mutations.length ?? 0) > 0, true);
});

test("keep-both copy path created after resolution but before publication performs zero ref updates", async () => {
  const fixture = await divergedFixture();
  const adapter = new MemoryAdapter();
  const recoveryStore = createV4RecoveryStore({ adapter, root: "recovery", repoId: config.repoId });
  const collisionPath = "note.conflict-remote-local-100.md";
  let mutated = false;
  fixture.github.onCreateCommit = () => {
    if (mutated) return;
    mutated = true;
    fixture.localVault.files.set(collisionPath, { bytes: enc("USER LATE COLLISION\n"), mtime: 4 });
  };

  await assert.rejects(new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    now: () => 100,
    recoveryStore,
    runState: { runId: "copy-guard", conflictCopies: new Map(), conflictCopyStages: new Map() },
    resolveConflictBatch: async request => keepBoth(request),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 3 }] }), /conflict.*replan|local.*changed|precondition/iu);

  assert.equal(mutated, true);
  assert.equal(fixture.github.refUpdates, 0, "late local copy-path collision must stop before branch publication");
  assert.equal(dec(fixture.localVault.files.get(collisionPath)!.bytes), "USER LATE COLLISION\n");
});
