import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex, type V4IndexFileRecord, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { assertV4PathLayoutCompatible, V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { coalesceV4Changes } from "../../src/lib/v4/sync-coordinator";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { sha256Hex } from "../../src/lib/bytes";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";

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
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();
  commitMessages: string[] = [];
  lastEntries: GitHubCreateTreeEntry[] = [];
  readRefs: Array<string | undefined> = [];
  readPaths: string[] = [];
  treeReads: string[] = [];
  async getFileBytes(path: string, ref?: string) {
    this.readRefs.push(ref);
    this.readPaths.push(path);
    const commit = ref ? this.commits.get(ref) : undefined;
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path);
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }; }
  async getTreeAt(treeSha: string) {
    this.treeReads.push(treeSha);
    const tree = this.trees.get(treeSha) ?? new Map();
    return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: `tree-blob-${index}`, size: bytes.byteLength, url: "" })) };
  }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    this.lastEntries = entries;
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha: tree, parents, message }); this.commitMessages.push(message); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); await this.createGitRef(sha); }
}

function config(): V4RemoteConfig { return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" }; }

function indexRecordByPath(index: V4LocalIndex, path: string): V4IndexFileRecord {
  const record = Object.values(index.shards).flatMap(shard => Object.values(shard.records)).find(candidate => !candidate.deleted && candidate.path === path);
  assert.ok(record, `missing index record for ${path}`);
  return record;
}

test("v4 rejects legacy encrypted layout except for Force Push migration", () => {
  const legacy = { formatVersion: 4 as const, mode: "encrypted" as const, repoId: "o/r#main" };
  const desired = { ...legacy, pathLayout: "opaque-stable-v1" as const };
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "normal"), /Force Push/iu);
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "forcePull"), /Force Push/iu);
  assert.doesNotThrow(() => assertV4PathLayoutCompatible(legacy, desired, "forcePush"));
});

test("v4 rejects legacy encrypted normal sync and Force Pull before vault or content writes", async () => {
  const github = new MemoryGitHub();
  github.ref = { ref: "refs/heads/main", sha: "legacy", type: "commit" };
  github.files.set(V4_CONFIG_PATH, enc(JSON.stringify({
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  })));
  const vault = new MemoryVault();
  vault.files.set("local.md", { bytes: enc("must remain untouched"), mtime: 1 });
  const desired: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });

  for (const operation of ["normal", "forcePull"] as const) {
    const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
    const session = new V4SyncSession({ github, vault, index, config: desired, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 });
    github.readPaths.length = 0;
    await assert.rejects(() => session.sync({ operation, allowThresholdOverride: false }), /Force Push/iu);
    assert.deepEqual(github.readPaths, [V4_CONFIG_PATH]);
    assert.deepEqual(vault.operations, []);
    assert.equal(github.commitMessages.length, 0);
  }
});

test("v4 validates the remote layout even when the commit SHA matches the local index", async () => {
  const github = new MemoryGitHub();
  github.ref = { ref: "refs/heads/main", sha: "legacy", type: "commit" };
  github.files.set(V4_CONFIG_PATH, enc(JSON.stringify({
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  })));
  const vault = new MemoryVault();
  vault.files.set("local.md", { bytes: enc("must remain untouched"), mtime: 1 });
  const desired: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  index.remoteCommitSha = "legacy";

  await assert.rejects(
    () => new V4SyncSession({ github, vault, index, config: desired, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false }),
    /Force Push/iu,
  );
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH]);
  assert.deepEqual(vault.operations, []);
  assert.equal(github.commitMessages.length, 0);
});

test("v4 history rejects a legacy encrypted path layout", async () => {
  const legacy: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  assert.throws(() => new V4HistoryService({
    config: legacy,
    keyring: keys,
    github: {
      async listCommits() { return []; },
      async getFileBytes() { return null; },
      async getGitCommit() { throw new Error("not reached"); },
      async getTreeAt() { throw new Error("not reached"); },
      async getBlob() { throw new Error("not reached"); },
    },
  }), /Force Push/iu);
});

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

test("v4 session validates only the config when the remote commit is unchanged", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("a.md", { bytes: enc("one"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d1", mode: "plaintext" });
  const session = new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  await session.sync({ operation: "forcePush", allowThresholdOverride: false });

  github.readRefs.length = 0;
  github.readPaths.length = 0;
  await session.sync({ operation: "normal", allowThresholdOverride: false });

  assert.deepEqual(github.readRefs, [github.ref!.sha]);
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH]);
  assert.deepEqual(github.treeReads, []);
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
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
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

test("v4 encrypted pack round trips through force pull and version-history preview", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  for (let index = 0; index < 64; index++) source.files.set(`Folder/private-${index}.md`, { bytes: enc(`secret-${index}`), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "a", mode: "encrypted" });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  const packPaths = [...github.files.keys()].filter(path => path.includes("/packs/"));
  assert.equal(packPaths.length, 1);
  assert.equal([...github.files.keys()].some(path => path.includes("private-")), false);

  const commitSha = github.ref!.sha;
  const published = github.commits.get(commitSha)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const blobPaths = new Map<string, string>();
  const history = new V4HistoryService({
    config: encryptedConfig,
    keyring: keys,
    github: {
      async listCommits() { return []; },
      async getFileBytes(path: string, ref?: string) { return github.getFileBytes(path, ref); },
      async getGitCommit(sha: string) { return github.getGitCommit(sha); },
      async getTreeAt(treeSha: string) {
        const tree = github.trees.get(treeSha) ?? new Map();
        return {
          sha: treeSha,
          url: "",
          truncated: false,
          tree: [...tree.entries()].map(([path, bytes], index) => {
            const sha = `history-blob-${index}`;
            blobPaths.set(sha, path);
            return { path, mode: "100644", type: "blob" as const, sha, size: bytes.byteLength, url: "" };
          }),
        };
      },
      async getBlob(sha: string) { return new Uint8Array(github.trees.get(published.treeSha)!.get(blobPaths.get(sha)!)!); },
    },
  });
  const historyCommit = {
    sha: commitSha,
    message: published.message,
    authorName: "A",
    authoredAt: "",
    parentShas: published.parents,
    source: "plugin" as const,
    journalId,
  };
  const packedChange = (await history.getCommitChanges(historyCommit)).find(change => change.path === "Folder/private-42.md")!;
  const preview = await history.previewChange(historyCommit, packedChange);
  assert.equal(preview.kind, "text");
  assert.equal(preview.text, "secret-42");

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

test("v4 merge policy reads the common base commit and publishes a clean three-way merge", async () => {
  const github = new MemoryGitHub();
  const first = new MemoryVault();
  first.files.set("merge.md", { bytes: enc("one\ntwo\nthree"), mtime: 1 });
  const firstIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "a", mode: "plaintext" });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "merge", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });

  const second = new MemoryVault();
  second.files.set("merge.md", { bytes: enc("one\ntwo\nthree"), mtime: 1 });
  const secondIndex = structuredClone(firstIndex);
  secondIndex.deviceId = "b";

  first.files.set("merge.md", { bytes: enc("ONE\ntwo\nthree"), mtime: 2 });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "merge", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });
  second.files.set("merge.md", { bytes: enc("one\ntwo\nTHREE"), mtime: 3 });
  await new V4SyncSession({ github, vault: second, index: secondIndex, config: config(), conflictPolicy: "merge", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(dec(second.files.get("merge.md")!.bytes), "ONE\ntwo\nTHREE");
  assert.equal(dec(github.files.get("merge.md")!), "ONE\ntwo\nTHREE");
  assert.equal([...second.files.keys()].some(path => path.includes(".conflict-")), false);
});

test("v4 full rescan handles nested folder rename and delete events", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("Folder/a.md", { bytes: enc("a"), mtime: 1 });
  vault.files.set("Folder/Nested/b.md", { bytes: enc("b"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = () => new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const a = vault.files.get("Folder/a.md")!;
  const b = vault.files.get("Folder/Nested/b.md")!;
  vault.files.delete("Folder/a.md");
  vault.files.delete("Folder/Nested/b.md");
  vault.files.set("Renamed/a.md", { ...a, mtime: 2 });
  vault.files.set("Renamed/Nested/b.md", { ...b, mtime: 2 });
  vault.listCount = 0;
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rescan", mtime: 2 }] });
  assert.ok(vault.listCount > 0);
  assert.equal(github.files.has("Folder/a.md"), false);
  assert.equal(dec(github.files.get("Renamed/Nested/b.md")!), "b");

  vault.files.delete("Renamed/a.md");
  vault.files.delete("Renamed/Nested/b.md");
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rescan", mtime: 3 }] });
  assert.equal(github.files.has("Renamed/a.md"), false);
  assert.equal(github.files.has("Renamed/Nested/b.md"), false);
});

test("v4 nested folder rename preserves descendant fileId and opaque remotePath", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("A/Nested/note.md", { bytes: enc("secret"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const before = indexRecordByPath(index, "A/Nested/note.md");
  const file = vault.files.get("A/Nested/note.md")!;
  vault.files.delete("A/Nested/note.md");
  vault.files.set("B/Nested/note.md", { ...file, mtime: 2 });
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderRename", oldPath: "A", path: "B", mtime: 2 }],
  });

  const after = indexRecordByPath(index, "B/Nested/note.md");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
});

test("v4 content-preserving rename writes metadata and journal without uploading a new content blob", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("old.md", { bytes: enc("secret"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const oldRecord = indexRecordByPath(index, "old.md");
  const oldRemotePath = oldRecord.remotePath;
  const file = vault.files.get("old.md")!;
  vault.files.delete("old.md");
  vault.files.set("new.md", { ...file, mtime: 2 });
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 2 }],
  });

  const renamed = indexRecordByPath(index, "new.md");
  assert.equal(renamed.remotePath, oldRemotePath);
  assert.notEqual(renamed.pathId, oldRecord.pathId);
  assert.equal(github.lastEntries.some(entry => entry.path === oldRemotePath), false);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/index/")), true);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/journals/")), true);
});

test("v4 confirmed Force Push migrates legacy encrypted paths in one commit", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const plaintext = enc("legacy secret");
  const orphanPlaintext = enc("remote only");
  vault.files.set("PrivateFolder/note.md", { bytes: plaintext, mtime: 1 });
  const legacyConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const legacyRecord: V4IndexFileRecord = {
    path: "PrivateFolder/note.md",
    pathId: "aa".padEnd(64, "0"),
    fileId: "stable-file",
    plaintextSha256: await sha256Hex(plaintext),
    size: plaintext.byteLength,
    mtime: 1,
    remoteVersion: "legacy-v",
    remotePath: ".obsidian-github-sync-v4/data/PrivateFolder/legacy.enc",
    storage: "single",
  };
  const orphanRecord: V4IndexFileRecord = {
    path: "PrivateFolder/orphan.md",
    pathId: "ab".padEnd(64, "0"),
    fileId: "orphan-file",
    plaintextSha256: await sha256Hex(orphanPlaintext),
    size: orphanPlaintext.byteLength,
    mtime: 1,
    remoteVersion: "legacy-v",
    remotePath: ".obsidian-github-sync-v4/data/PrivateFolder/orphan.enc",
    storage: "single",
  };
  const legacyHead: V4RemoteHead = {
    formatVersion: 4,
    mode: "encrypted",
    epoch: 1,
    generation: 1,
    journalId: "legacy-v",
    shardHashes: { aa: "legacy-shard", ab: "orphan-shard" },
    updatedAt: 1,
    deviceId: "old",
  };
  const legacyFiles = await buildV4RemoteMetadata({ config: legacyConfig, head: legacyHead, records: [legacyRecord, orphanRecord], keyring: keys });
  legacyFiles.push({ path: legacyRecord.remotePath, bytes: await encryptV4Payload(keys.contentKey, plaintext, { kind: "content", aad: `${legacyRecord.pathId}:legacy-v` }) });
  legacyFiles.push({ path: orphanRecord.remotePath, bytes: await encryptV4Payload(keys.contentKey, orphanPlaintext, { kind: "content", aad: `${orphanRecord.pathId}:legacy-v` }) });
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-v", files: legacyFiles });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  index.remoteCommitSha = github.ref!.sha;
  index.epoch = legacyHead.epoch;
  index.generation = legacyHead.generation;
  index.shardHashes = { ...legacyHead.shardHashes };
  index.shards.aa = { hash: "legacy-shard", records: { [legacyRecord.pathId]: legacyRecord } };
  index.shards.ab = { hash: "orphan-shard", records: { [orphanRecord.pathId]: orphanRecord } };
  const legacyEncryptedSession = new V4SyncSession({ github, vault, index, config: desiredConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 60 });
  github.commitMessages.length = 0;

  await assert.rejects(() => legacyEncryptedSession.sync({ operation: "forcePush", allowThresholdOverride: false }), /change guard blocked/iu);
  assert.equal(github.commitMessages.length, 0);
  const result = await legacyEncryptedSession.sync({ operation: "forcePush", allowThresholdOverride: true });

  assert.equal(result.mode, "force-push");
  assert.equal(result.changedFiles, 2);
  assert.equal(github.commitMessages.length, 1);
  assert.equal([...github.files.keys()].some(path => path.includes("PrivateFolder")), false);
  assert.equal([...github.files.keys()].some(path => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(path)), true);
});

test("v4 legacy migration refuses to delete encrypted records excluded by sync scope", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const plaintext = enc("legacy secret");
  vault.files.set("Excluded/note.md", { bytes: plaintext, mtime: 1 });
  const legacyConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const record: V4IndexFileRecord = { path: "Excluded/note.md", pathId: "aa".padEnd(64, "0"), fileId: "excluded-file", plaintextSha256: await sha256Hex(plaintext), size: plaintext.byteLength, mtime: 1, remoteVersion: "legacy-v", remotePath: ".obsidian-github-sync-v4/data/Excluded/note.enc", storage: "single" };
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "legacy-v", shardHashes: { aa: "legacy-shard" }, updatedAt: 1, deviceId: "old" };
  const files = await buildV4RemoteMetadata({ config: legacyConfig, head, records: [record], keyring: keys });
  files.push({ path: record.remotePath, bytes: await encryptV4Payload(keys.contentKey, plaintext, { kind: "content", aad: `${record.pathId}:legacy-v` }) });
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-v", files });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  github.commitMessages.length = 0;

  await assert.rejects(
    () => new V4SyncSession({ github, vault, index, config: desiredConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0, includePath: path => !path.startsWith("Excluded/") }).sync({ operation: "forcePush", allowThresholdOverride: true }),
    /excluded by sync scope/iu,
  );
  assert.equal(github.commitMessages.length, 0);
  assert.equal(github.files.has(record.remotePath), true);
});

test("v4 chained nested folder renames preserve descendant fileId and opaque remotePath", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("A/N/x.md", { bytes: enc("secret"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const before = indexRecordByPath(index, "A/N/x.md");
  const file = vault.files.get("A/N/x.md")!;
  vault.files.delete("A/N/x.md");
  vault.files.set("C/M/x.md", { ...file, mtime: 2 });
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: coalesceV4Changes([
      { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
      { type: "folderRename", oldPath: "B/N", path: "B/M", mtime: 2 },
      { type: "folderRename", oldPath: "B", path: "C", mtime: 3 },
    ]),
  });

  const after = indexRecordByPath(index, "C/M/x.md");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
});

test("v4 nested folder delete removes descendants from the final state", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("Folder/a.md", { bytes: enc("a"), mtime: 1 });
  vault.files.set("Folder/Nested/b.md", { bytes: enc("b"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = () => new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  vault.files.delete("Folder/a.md");
  vault.files.delete("Folder/Nested/b.md");
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderDelete", path: "Folder", mtime: 2 }],
  });

  assert.equal(github.files.has("Folder/a.md"), false);
  assert.equal(github.files.has("Folder/Nested/b.md"), false);
  assert.equal(Object.values(index.shards).flatMap(shard => Object.values(shard.records)).some(record => record.path.startsWith("Folder/")), false);
});

test("v4 stale device reconciles a direct GitHub edit after a newer plugin commit", async () => {
  const github = new MemoryGitHub();
  const first = new MemoryVault();
  first.files.set("external.md", { bytes: enc("base"), mtime: 1 });
  first.files.set("plugin.md", { bytes: enc("base"), mtime: 1 });
  const firstIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "a", mode: "plaintext" });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });

  const staleVault = new MemoryVault();
  staleVault.files = new Map([...first.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]));
  const staleIndex = structuredClone(firstIndex);
  staleIndex.deviceId = "stale";

  first.files.set("plugin.md", { bytes: enc("plugin gen2"), mtime: 2 });
  await new V4SyncSession({ github, vault: first, index: firstIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });

  const pluginTip = github.ref!.sha;
  const pluginTree = github.commits.get(pluginTip)!.treeSha;
  const externalTree = new Map(github.trees.get(pluginTree));
  externalTree.set("external.md", enc("edited on GitHub"));
  github.trees.set("tree-external", externalTree);
  github.commits.set("commit-external", { treeSha: "tree-external", parents: [pluginTip], message: "Edit external.md on GitHub" });
  github.ref = { ref: "refs/heads/main", sha: "commit-external", type: "commit" };
  github.files = new Map(externalTree);

  await new V4SyncSession({ github, vault: staleVault, index: staleIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(dec(staleVault.files.get("plugin.md")!.bytes), "plugin gen2");
  assert.equal(dec(staleVault.files.get("external.md")!.bytes), "edited on GitHub");
  assert.ok(github.treeReads.includes("tree-external"));
});

test("v4 no-op reuses all 256 unchanged local index shards", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const shardHashes: Record<string, string> = {};
  for (let value = 0; value < 256; value++) {
    const bucket = value.toString(16).padStart(2, "0");
    const path = `notes/${bucket}.md`;
    const pathId = `${bucket}${"0".repeat(62)}`;
    const record = { path, pathId, fileId: `file-${bucket}`, plaintextSha256: `hash-${bucket}`, size: 1, mtime: 1, remoteVersion: "j1", remotePath: path, storage: "single" as const };
    const hash = `shard-${bucket}`;
    shardHashes[bucket] = hash;
    index.shardHashes[bucket] = hash;
    index.shards[bucket] = { hash, records: { [pathId]: record } };
    vault.files.set(path, { bytes: enc("x"), mtime: 1 });
  }
  index.remoteCommitSha = "commit-previous";
  index.epoch = 1;
  index.generation = 1;
  const head: V4RemoteHead = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 1, journalId: "j1", shardHashes, updatedAt: 1, deviceId: "other" };
  const tree = new Map<string, Uint8Array>([
    [V4_CONFIG_PATH, enc(JSON.stringify(config()))],
    [V4_HEAD_PATH, enc(JSON.stringify(head))],
  ]);
  github.trees.set("tree-noop", tree);
  github.commits.set("commit-noop", { treeSha: "tree-noop", parents: [], message: "obsidian-sync-v4:j1" });
  github.ref = { ref: "refs/heads/main", sha: "commit-noop", type: "commit" };
  github.files = new Map(tree);

  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(result.mode, "noop");
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH, V4_HEAD_PATH]);
  assert.equal(vault.operations.length, 0);
});
