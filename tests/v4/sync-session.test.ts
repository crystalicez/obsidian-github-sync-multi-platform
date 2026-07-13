import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  operations: string[] = [];
  listCount = 0;
  async listFiles() { this.listCount++; return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { this.operations.push(`read:${path}`); return new Uint8Array(this.files.get(path)!.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.operations.push(`write:${path}`); this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() }); }
  async delete(path: string) { this.operations.push(`delete:${path}`); this.files.delete(path); }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[] }>();
  commitMessages: string[] = [];
  lastEntries: GitHubCreateTreeEntry[] = [];
  async getFileBytes(path: string) { const value = this.files.get(path); return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null; }
  async getGitRefOrNull() { return this.ref; }
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents }; }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    this.lastEntries = entries;
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha: tree, parents }); this.commitMessages.push(message); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); await this.createGitRef(sha); }
}

function config(): V4RemoteConfig { return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" }; }

test("v4 session force-pushes one atomic commit, no-ops unchanged, and force-pulls", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  source.files.set("a.md", { bytes: enc("one"), mtime: 1 });
  source.files.set("asset.bin", { bytes: new Uint8Array([1, 2]), mtime: 2 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d1", mode: "plaintext" });
  const session = new V4SyncSession({ github, vault: source, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  const pushed = await session.sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(pushed.changedFiles, 2);
  assert.equal(github.commitMessages.length, 1);
  assert.equal(dec(github.files.get("a.md")!), "one");
  const noop = await session.sync({ operation: "normal", allowThresholdOverride: false });
  assert.equal(noop.changedFiles, 0);
  assert.equal(github.commitMessages.length, 1);

  const target = new MemoryVault();
  target.files.set("old.md", { bytes: enc("old"), mtime: 1 });
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d2", mode: "plaintext" });
  const pulled = await new V4SyncSession({ github, vault: target, index: targetIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(pulled.changedFiles, 3);
  assert.equal(dec(target.files.get("a.md")!.bytes), "one");
  assert.equal(target.files.has("old.md"), false);
});

test("v4 force push initializes an empty vault instead of returning a no-op", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(result.changedFiles, 0);
  assert.equal(github.commitMessages.length, 1);
  assert.ok(github.files.has(".obsidian-github-sync-v4/config.json"));
  assert.ok(github.files.has(".obsidian-github-sync-v4/head"));
});

test("v4 cutover refuses legacy force pull and encrypted force push onto populated history", async () => {
  const github = new MemoryGitHub();
  github.ref = { ref: "refs/heads/main", sha: "legacy", type: "commit" };
  github.files.set("legacy.md", enc("plaintext history"));
  const vault = new MemoryVault();
  const plaintextIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  await assert.rejects(
    () => new V4SyncSession({ github, vault, index: plaintextIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false }),
    /Force Push is required/u,
  );
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const encryptedIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted" });
  await assert.rejects(
    () => new V4SyncSession({ github, vault, index: encryptedIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false }),
    /new empty repository or branch/u,
  );
});

test("v4 normal sync pulls before it publishes independent local changes", async () => {
  const github = new MemoryGitHub();
  const first = new MemoryVault();
  first.files.set("local.md", { bytes: enc("base"), mtime: 1 });
  first.files.set("remote.md", { bytes: enc("base"), mtime: 1 });
  const firstIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "a", mode: "plaintext" });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });

  const second = new MemoryVault();
  second.files = new Map([...first.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]));
  const secondIndex = structuredClone(firstIndex);
  secondIndex.deviceId = "b";
  first.files.set("remote.md", { bytes: enc("from remote"), mtime: 2 });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });
  second.files.set("local.md", { bytes: enc("from local"), mtime: 2 });
  const session = new V4SyncSession({ github, vault: second, index: secondIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  await session.sync({ operation: "normal", allowThresholdOverride: false });
  assert.ok(second.operations.indexOf("write:remote.md") < github.commitMessages.length + second.operations.length);
  assert.equal(dec(second.files.get("remote.md")!.bytes), "from remote");
  assert.equal(dec(github.files.get("local.md")!), "from local");
});

test("v4 session blocks operations over the configured modification percentage", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("a.md", { bytes: enc("a"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 10 });
  await assert.rejects(() => session.sync({ operation: "forcePush", allowThresholdOverride: false }), /change guard blocked/i);
  await session.sync({ operation: "forcePush", allowThresholdOverride: true });
});

test("v4 local event sync reads and stats only the changed path", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  for (let index = 0; index < 100; index++) vault.files.set(`n${index}.md`, { bytes: enc(`v${index}`), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  await session.sync({ operation: "forcePush", allowThresholdOverride: false });
  vault.operations.length = 0;
  vault.listCount = 0;
  vault.files.set("n42.md", { bytes: enc("changed"), mtime: 2 });
  await session.sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "n42.md", mtime: 2 }] });
  assert.equal(vault.listCount, 0);
  assert.deepEqual(vault.operations.filter(item => item.startsWith("read:")), ["read:n42.md"]);
  assert.equal(github.lastEntries.filter(entry => entry.path.includes("/index/")).length, 1);
});

test("v4 encrypted force push packs a large small-file batch and force pull restores it", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  for (let index = 0; index < 64; index++) source.files.set(`Folder/private-${index}.md`, { bytes: enc(`secret-${index}`), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "a", mode: "encrypted" });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  const packPaths = [...github.files.keys()].filter(path => path.includes("/packs/"));
  assert.equal(packPaths.length, 1);
  assert.equal([...github.files.keys()].some(path => path.includes("private-")), false);

  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "b", mode: "encrypted" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get("Folder/private-42.md")!.bytes), "secret-42");
});

test("v4 ignore scope stops tracking a path without treating it as a remote deletion", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("keep.md", { bytes: enc("keep"), mtime: 1 });
  vault.files.set("ignored.md", { bytes: enc("preserve remotely"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  vault.files.delete("ignored.md");
  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0, includePath: path => path !== "ignored.md" }).sync({ operation: "normal", allowThresholdOverride: false });
  assert.equal(result.changedFiles, 0);
  assert.equal(dec(github.files.get("ignored.md")!), "preserve remotely");
});
