import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import type { V4ConflictBatchRequest, V4ConflictFileSummary, V4ConflictMaterializedFile } from "../../src/lib/v4/conflict-types";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { V4ConflictResolutionView } from "../../src/views/conflict-resolution";
import type { V4ConflictCoordinatorSnapshot } from "../../src/lib/v4/conflict-coordinator";
import { WorkspaceLeaf } from "../stubs/obsidian";

const enc = (value: string) => new TextEncoder().encode(value);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function summary(index: number): V4ConflictFileSummary {
  const path = `note-${index}.md`;
  const base = { exists: true as const, path, hash: "a".repeat(64), size: 2, mtime: 1 };
  return {
    fileId: `f-${index}`,
    displayPath: path,
    fingerprint: `fp-${index}`,
    base,
    local: { ...base, hash: "b".repeat(64), mtime: 2 },
    remote: { ...base, hash: "c".repeat(64), mtime: 3 },
    textCandidate: true,
    requiresReview: true,
  };
}

function snapshot(files: readonly V4ConflictFileSummary[]): V4ConflictCoordinatorSnapshot {
  return {
    active: true,
    runId: "resource-run",
    generation: 1,
    contextKey: "resource-context",
    expectedRemoteHead: "head",
    pending: true,
    canContinue: false,
    files: files.map(file => ({ summary: file, reviewed: false })),
  };
}

test("100 conflict summaries materialize only the selected file", async () => {
  const files = Array.from({ length: 100 }, (_, index) => summary(index));
  let current = snapshot(files);
  const listeners = new Set<(value: V4ConflictCoordinatorSnapshot) => void>();
  const materialized: string[] = [];
  const runtime = {
    get conflictSnapshot() { return current; },
    subscribeConflicts(listener: (value: V4ConflictCoordinatorSnapshot) => void) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async materializeConflict(fileId: string): Promise<V4ConflictMaterializedFile> {
      materialized.push(fileId);
      const file = files.find(candidate => candidate.fileId === fileId)!;
      return { generation: 1, summary: file, mode: "file", downgradeReason: "resource fixture" };
    },
    setConflictResolution() {}, markConflictReviewed() {}, continueConflictResolution() {}, cancelConflictResolution() {},
  };
  const app = { workspace: { getActiveFile: () => null } };
  const plugin = { app, settings: { ...DEFAULT_SETTINGS, conflictViewMode: "unified" as const }, v4Runtime: runtime, persistData: async () => undefined };
  const view = new V4ConflictResolutionView(new WorkspaceLeaf(app), plugin as never);

  await view.onOpen();
  await flush();
  assert.deepEqual(materialized, ["f-0"]);

  view.contentEl.findByText("note-50.md")?.onclick?.();
  await flush();
  assert.deepEqual(materialized, ["f-0", "f-50"]);
  assert.equal(new Set(materialized).size, 2);

  current = { active: false, pending: false, canContinue: false, files: [] };
  for (const listener of [...listeners]) listener(current);
  await view.onClose();
});

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

async function materializeConflict(base: string, remote: string, local: string): Promise<V4ConflictMaterializedFile> {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("note.md", { bytes: enc(base), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = new MemoryVault();
  localVault.files.set("note.md", { bytes: enc(local), mtime: 3 });
  const localIndex = structuredClone(remoteIndex) as V4LocalIndex;
  localIndex.deviceId = "local";

  remoteVault.files.set("note.md", { bytes: enc(remote), mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config, conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 2 }] });

  let result: V4ConflictMaterializedFile | undefined;
  await new V4SyncSession({
    github,
    vault: localVault,
    index: localIndex,
    config,
    conflictPolicy: "ask",
    abortChangePercent: 0,
    resolveConflictBatch: async (request: V4ConflictBatchRequest) => {
      result = await request.materialize(request.files[0].fileId, request.generation);
      return {
        runId: request.runId,
        generation: request.generation,
        files: request.files.map(file => ({ fileId: file.fileId, fingerprint: file.fingerprint, kind: "use-remote" as const })),
      };
    },
  }).sync({ operation: "normal", allowThresholdOverride: false });
  assert.ok(result);
  return result;
}

test("40001-line text conflict safely downgrades to file-level resolution", async () => {
  const base = "x\n".repeat(40_001);
  const result = await materializeConflict(base, `REMOTE\n${base}`, `LOCAL\n${base}`);
  assert.equal(result.mode, "file");
  assert.match(result.downgradeReason ?? "", /40000|line/iu);
});

function repeatedBudgetDocument(prefix: string): string {
  let output = "";
  for (let block = 0; block < 9; block++) {
    output += `${prefix}-${block}\n`.repeat(500);
    output += `anchor-${block}\n`;
  }
  return output;
}

test("multi-gap repeated-line conflict exceeding total DP budget downgrades without allocation blowup", async () => {
  const base = repeatedBudgetDocument("base");
  const local = repeatedBudgetDocument("local");
  const remote = repeatedBudgetDocument("remote");
  const result = await materializeConflict(base, remote, local);
  assert.equal(result.mode, "file");
  assert.match(result.downgradeReason ?? "", /budget/iu);
});
