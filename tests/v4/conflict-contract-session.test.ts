import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  operations: string[] = [];

  async listFiles() {
    return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime }));
  }
  async stat(path: string) {
    const file = this.files.get(path);
    return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null;
  }
  async read(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local file: ${path}`);
    return new Uint8Array(file.bytes);
  }
  async write(path: string, bytes: Uint8Array, mtime?: number) {
    this.operations.push(`write:${path}`);
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() });
  }
  async trash(path: string) {
    this.operations.push(`trash:${path}`);
    this.files.delete(path);
  }
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
    const value = this.commits.get(sha);
    if (!value) throw new Error(`Missing commit ${sha}`);
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message };
  }
  async getTreeAt(treeSha: string) {
    const tree = this.trees.get(treeSha) ?? new Map<string, Uint8Array>();
    return {
      sha: treeSha,
      url: "",
      truncated: false,
      tree: [...tree.entries()].map(([path, bytes], index) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: `tree-blob-${index}`,
        size: bytes.byteLength,
        url: "",
      })),
    };
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) {
      if (entry.sha === null) tree.delete(entry.path);
      else tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    }
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha, parents, message });
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

function records(index: V4LocalIndex) {
  return Object.values(index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
}

function recordAt(index: V4LocalIndex, path: string) {
  const record = records(index).find(candidate => candidate.path === path);
  assert.ok(record, `missing record ${path}`);
  return record;
}

function paths(index: V4LocalIndex): string[] {
  return records(index).map(record => record.path).sort();
}

function cloneVault(source: MemoryVault): MemoryVault {
  const target = new MemoryVault();
  target.files = new Map([...source.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]));
  return target;
}

async function baseFixture(path = "shared.md") {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set(path, { bytes: enc("base\n"), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = cloneVault(remoteVault);
  const localIndex = structuredClone(remoteIndex);
  localIndex.deviceId = "local";
  return { github, remoteVault, remoteIndex, localVault, localIndex, originalFileId: recordAt(remoteIndex, path).fileId };
}

function session(github: MemoryGitHub, vault: MemoryVault, index: V4LocalIndex, now = () => 424242) {
  return new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0, now });
}

test("copy policy keeps local edit canonical and preserves one remote conflict copy", async () => {
  const fixture = await baseFixture();
  fixture.remoteVault.files.set("shared.md", { bytes: enc("remote\n"), mtime: 2 });
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "shared.md", mtime: 2 }] });

  fixture.localVault.files.set("shared.md", { bytes: enc("local\n"), mtime: 3 });
  await session(fixture.github, fixture.localVault, fixture.localIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "shared.md", mtime: 3 }] });

  const copyPath = "shared.conflict-remote-local-424242.md";
  assert.deepEqual([...fixture.localVault.files.keys()].sort(), [copyPath, "shared.md"]);
  assert.deepEqual(fixture.localVault.files.get("shared.md")?.bytes, enc("local\n"));
  assert.deepEqual(fixture.localVault.files.get(copyPath)?.bytes, enc("remote\n"));
  assert.equal(recordAt(fixture.localIndex, "shared.md").fileId, fixture.originalFileId);
  assert.notEqual(recordAt(fixture.localIndex, copyPath).fileId, fixture.originalFileId);
});

test("copy policy keeps stale local old path canonical when remote renamed the same identity", async () => {
  const fixture = await baseFixture("old.md");
  fixture.remoteVault.files.delete("old.md");
  fixture.remoteVault.files.set("new.md", { bytes: enc("base\n"), mtime: 2 });
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 2 }] });

  fixture.localVault.files.set("old.md", { bytes: enc("stale-local\n"), mtime: 3 });
  await session(fixture.github, fixture.localVault, fixture.localIndex, () => 515151)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "old.md", mtime: 3 }] });

  const copyPath = "new.conflict-remote-local-515151.md";
  assert.deepEqual([...fixture.localVault.files.keys()].sort(), [copyPath, "old.md"]);
  assert.deepEqual(fixture.localVault.files.get("old.md")?.bytes, enc("stale-local\n"));
  assert.deepEqual(fixture.localVault.files.get(copyPath)?.bytes, enc("base\n"));
  assert.equal(recordAt(fixture.localIndex, "old.md").fileId, fixture.originalFileId);
  assert.notEqual(recordAt(fixture.localIndex, copyPath).fileId, fixture.originalFileId);
});

test("remote delete versus stale local edit keeps local canonical without a meaningless copy", async () => {
  const fixture = await baseFixture();
  fixture.remoteVault.files.delete("shared.md");
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "shared.md", mtime: 2 }] });

  fixture.localVault.files.set("shared.md", { bytes: enc("local-after-delete\n"), mtime: 3 });
  await session(fixture.github, fixture.localVault, fixture.localIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "shared.md", mtime: 3 }] });

  assert.deepEqual([...fixture.localVault.files.keys()], ["shared.md"]);
  assert.deepEqual(fixture.localVault.files.get("shared.md")?.bytes, enc("local-after-delete\n"));
  assert.equal(recordAt(fixture.localIndex, "shared.md").fileId, fixture.originalFileId);
});

test("local delete versus remote edit keeps canonical deletion and preserves remote as a copy", async () => {
  const fixture = await baseFixture();
  fixture.remoteVault.files.set("shared.md", { bytes: enc("remote-after-local-delete\n"), mtime: 2 });
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "shared.md", mtime: 2 }] });

  fixture.localVault.files.delete("shared.md");
  await session(fixture.github, fixture.localVault, fixture.localIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "shared.md", mtime: 3 }] });

  const copyPath = "shared.conflict-remote-local-424242.md";
  assert.deepEqual([...fixture.localVault.files.keys()], [copyPath]);
  assert.deepEqual(fixture.localVault.files.get(copyPath)?.bytes, enc("remote-after-local-delete\n"));
  assert.notEqual(recordAt(fixture.localIndex, copyPath).fileId, fixture.originalFileId);
  assert.equal(paths(fixture.localIndex).includes("shared.md"), false);
});

test("occupied conflict-copy path is never overwritten silently", async () => {
  const fixture = await baseFixture();
  fixture.remoteVault.files.set("shared.md", { bytes: enc("remote\n"), mtime: 2 });
  await session(fixture.github, fixture.remoteVault, fixture.remoteIndex)
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "shared.md", mtime: 2 }] });

  const copyPath = "shared.conflict-remote-local-424242.md";
  fixture.localVault.files.set("shared.md", { bytes: enc("local\n"), mtime: 3 });
  fixture.localVault.files.set(copyPath, { bytes: enc("user-owned\n"), mtime: 3 });
  const remoteHeadBefore = fixture.github.ref?.sha;

  await assert.rejects(
    session(fixture.github, fixture.localVault, fixture.localIndex)
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [
        { type: "modify", path: "shared.md", mtime: 3 },
        { type: "modify", path: copyPath, mtime: 3 },
      ] }),
    /local target changed|collision/i,
  );

  assert.deepEqual(fixture.localVault.files.get(copyPath)?.bytes, enc("user-owned\n"));
  assert.equal(fixture.github.ref?.sha, remoteHeadBefore);
});
