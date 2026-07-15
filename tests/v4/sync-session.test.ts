import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex, type V4IndexFileRecord, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { assertV4PathLayoutCompatible, V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { coalesceV4Changes, type V4QueuedChange } from "../../src/lib/v4/sync-coordinator";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { sha256Hex } from "../../src/lib/bytes";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";

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

test("v4 encrypted matching-SHA sync authenticates the remote head before publishing with a derived key", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("secret.md", { bytes: enc("key A content"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keyA = await deriveV4Keyring({ passphrase: "key-a", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const keyB = await deriveV4Keyring({ passphrase: "key-b", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keyA, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  vault.files.set("secret.md", { bytes: enc("modified under key B"), mtime: 2 });
  vault.operations.length = 0;
  const before = { ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size, messages: github.commitMessages.length };

  await assert.rejects(
    () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keyB, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "secret.md", mtime: 2 }] }),
    /decrypt|authentication|passphrase/iu,
  );

  assert.deepEqual({ ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size, messages: github.commitMessages.length }, before);
  assert.equal(vault.operations.some(operation => operation.startsWith("write:") || operation.startsWith("delete:")), false);
  assert.equal(dec(vault.files.get("secret.md")!.bytes), "modified under key B");
});

test("v4 Force Push cannot overwrite an encrypted remote without authenticating its head", async () => {
  const github = new MemoryGitHub();
  const encryptedVault = new MemoryVault();
  encryptedVault.files.set("secret.md", { bytes: enc("encrypted"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "key-a", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const encryptedIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "encrypted", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault: encryptedVault, index: encryptedIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: false });
  const plaintextVault = new MemoryVault();
  plaintextVault.files.set("replacement.md", { bytes: enc("plaintext"), mtime: 2 });
  const plaintextIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "plaintext", mode: "plaintext", pathLayout: "plaintext-v1" });
  const before = { ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size };

  await assert.rejects(
    () => new V4SyncSession({ github, vault: plaintextVault, index: plaintextIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: true }),
    /decrypt|passphrase|authentication/iu,
  );

  assert.deepEqual({ ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size }, before);
  assert.equal(plaintextVault.operations.some(operation => operation.startsWith("write:") || operation.startsWith("delete:")), false);
});

test("v4 encrypted correct-key matching-SHA no-op reads only config and authenticated head", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("secret.md", { bytes: enc("secret"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "correct", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 });
  await session.sync({ operation: "forcePush", allowThresholdOverride: false });
  github.readPaths.length = 0;
  github.treeReads.length = 0;
  vault.operations.length = 0;

  const result = await session.sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(result.mode, "noop");
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH, V4_HEAD_PATH]);
  assert.deepEqual(github.treeReads, []);
  assert.deepEqual(vault.operations, []);

  const bucket = Object.keys(index.shards)[0];
  const cachedRecord = Object.values(index.shards[bucket].records)[0];
  const originalFileId = cachedRecord.fileId;
  index.shards[bucket].hash = "stale-local-hash";
  cachedRecord.fileId = "stale-local-identity";
  const commitsBeforeRecovery = github.commits.size;
  github.readPaths.length = 0;

  const recovered = await session.sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(recovered.mode, "noop");
  assert.equal(github.commits.size, commitsBeforeRecovery);
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH, V4_HEAD_PATH, `.obsidian-github-sync-v4/index/${bucket}.enc`]);
  assert.equal(indexRecordByPath(index, "secret.md").fileId, originalFileId);
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

test("v4 encrypted chunked rename reuses identity and parts without uploading content", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const content = new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1);
  content[0] = 17;
  content[content.length - 1] = 29;
  vault.files.set("large.bin", { bytes: content, mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const before = structuredClone(indexRecordByPath(index, "large.bin"));
  assert.equal(before.storage, "chunked");
  const file = vault.files.get("large.bin")!;
  vault.files.delete("large.bin");
  vault.files.set("renamed.bin", { ...file, mtime: 2 });

  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "large.bin", path: "renamed.bin", mtime: 2 }] });

  const after = indexRecordByPath(index, "renamed.bin");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
  assert.deepEqual(after.partPaths, before.partPaths);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/parts/")), false);
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(await sha256Hex(target.files.get("renamed.bin")!.bytes), await sha256Hex(content));
});

test("v4 encrypted packed-member rename reuses its pack and remains previewable", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  for (let index = 0; index < 64; index++) vault.files.set(`Folder/private-${index}.md`, { bytes: enc(`secret-${index}`), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const before = structuredClone(indexRecordByPath(index, "Folder/private-42.md"));
  assert.equal(before.storage, "pack");
  const file = vault.files.get("Folder/private-42.md")!;
  vault.files.delete("Folder/private-42.md");
  vault.files.set("Folder/renamed-42.md", { ...file, mtime: 2 });

  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "Folder/private-42.md", path: "Folder/renamed-42.md", mtime: 2 }] });

  const after = indexRecordByPath(index, "Folder/renamed-42.md");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
  assert.equal(after.packId, before.packId);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/packs/")), false);
  const tip = github.ref!.sha;
  const published = github.commits.get(tip)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const blobPaths = new Map<string, { treeSha: string; path: string }>();
  const history = new V4HistoryService({
    config: encryptedConfig,
    keyring: keys,
    github: {
      async listCommits() { return []; },
      async getFileBytes(path: string, ref?: string) { return github.getFileBytes(path, ref); },
      async getGitCommit(sha: string) { return github.getGitCommit(sha); },
      async getTreeAt(treeSha: string) {
        const tree = github.trees.get(treeSha) ?? new Map();
        return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => {
          const sha = `preview-${treeSha}-${index}`;
          blobPaths.set(sha, { treeSha, path });
          return { path, mode: "100644", type: "blob" as const, sha, size: bytes.byteLength, url: "" };
        }) };
      },
      async getBlob(sha: string) { const blob = blobPaths.get(sha)!; return new Uint8Array(github.trees.get(blob.treeSha)!.get(blob.path)!); },
    },
  });
  const commit = { sha: tip, message: published.message, authorName: "A", authoredAt: "", parentShas: published.parents, source: "plugin" as const, journalId };
  const change = (await history.getCommitChanges(commit)).find(candidate => candidate.path === "Folder/renamed-42.md")!;
  assert.equal(change.kind, "rename");
  const preview = await history.previewChange(commit, change);
  assert.equal(preview.kind, "text");
  if (preview.kind === "text") assert.equal(preview.text, "secret-42");
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

test("v4 delete then recreate in one debounce window creates a new encrypted identity atomically", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("same.md", { bytes: enc("old content"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const before = { ...indexRecordByPath(index, "same.md") };
  vault.files.set("same.md", { bytes: enc("new content"), mtime: 2 });

  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: coalesceV4Changes([
      { type: "delete", path: "same.md", mtime: 1 },
      { type: "modify", path: "same.md", mtime: 2 },
    ]),
  });

  const after = indexRecordByPath(index, "same.md");
  assert.notEqual(after.fileId, before.fileId);
  assert.notEqual(after.remotePath, before.remotePath);
  assert.equal(github.files.has(before.remotePath), false);
  assert.equal(github.files.has(after.remotePath), true);
  const tip = github.ref!.sha;
  const published = github.commits.get(tip)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const changes = await new V4HistoryService({
    config: encryptedConfig,
    keyring: keys,
    github: {
      async listCommits() { return []; },
      async getFileBytes(path: string, ref?: string) { return github.getFileBytes(path, ref); },
      async getGitCommit() { throw new Error("not reached"); },
      async getTreeAt() { throw new Error("not reached"); },
      async getBlob() { throw new Error("not reached"); },
    },
  }).getCommitChanges({ sha: tip, message: published.message, authorName: "A", authoredAt: "", parentShas: published.parents, source: "plugin", journalId });
  assert.deepEqual(changes.map(change => ({ kind: change.kind, fileId: change.fileId, path: change.path })), [
    { kind: "delete", fileId: before.fileId, path: "same.md" },
    { kind: "create", fileId: after.fileId, path: "same.md" },
  ]);
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get("same.md")!.bytes), "new content");
});

test("v4 delete recreate then rename in one debounce window keeps the identity discontinuity", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("A.md", { bytes: enc("old content"), mtime: 1 });
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const session = () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy" as const, abortChangePercent: 0 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const before = { ...indexRecordByPath(index, "A.md") };
  vault.files.delete("A.md");
  vault.files.set("B.md", { bytes: enc("new content"), mtime: 3 });

  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: coalesceV4Changes([
    { type: "delete", path: "A.md", mtime: 1 },
    { type: "modify", path: "A.md", mtime: 2 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 3 },
  ]) });

  const after = indexRecordByPath(index, "B.md");
  assert.notEqual(after.fileId, before.fileId);
  assert.notEqual(after.remotePath, before.remotePath);
  assert.equal(github.files.has(before.remotePath), false);
  assert.equal(github.files.has(after.remotePath), true);
  const tip = github.ref!.sha;
  const published = github.commits.get(tip)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const changes = await new V4HistoryService({ config: encryptedConfig, keyring: keys, github: {
    async listCommits() { return []; }, async getFileBytes(path: string, ref?: string) { return github.getFileBytes(path, ref); },
    async getGitCommit() { throw new Error("not reached"); }, async getTreeAt() { throw new Error("not reached"); }, async getBlob() { throw new Error("not reached"); },
  } }).getCommitChanges({ sha: tip, message: published.message, authorName: "A", authoredAt: "", parentShas: published.parents, source: "plugin", journalId });
  assert.deepEqual(changes.map(change => ({ kind: change.kind, fileId: change.fileId, path: change.path })), [
    { kind: "delete", fileId: before.fileId, path: "A.md" },
    { kind: "create", fileId: after.fileId, path: "B.md" },
  ]);
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get("B.md")!.bytes), "new content");
  assert.equal(target.files.has("A.md"), false);
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
  const legacyPathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, "PrivateFolder/note.md");
  const orphanPathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, "PrivateFolder/orphan.md");
  const legacyRecord: V4IndexFileRecord = {
    path: "PrivateFolder/note.md",
    pathId: legacyPathId,
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
    pathId: orphanPathId,
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
    shardHashes: { [legacyPathId.slice(0, 2)]: "legacy-shard", [orphanPathId.slice(0, 2)]: "orphan-shard" },
    updatedAt: 1,
    deviceId: "old",
  };
  const legacyFiles = await buildV4RemoteMetadata({ config: legacyConfig, head: legacyHead, records: [legacyRecord, orphanRecord], keyring: keys });
  legacyFiles.push({ path: legacyRecord.remotePath, bytes: await encryptV4Payload(keys.contentKey, plaintext, { kind: "content", aad: `${legacyRecord.pathId}:legacy-v` }) });
  legacyFiles.push({ path: orphanRecord.remotePath, bytes: await encryptV4Payload(keys.contentKey, orphanPlaintext, { kind: "content", aad: `${orphanRecord.pathId}:legacy-v` }) });
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-v", files: legacyFiles });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  assert.equal(index.remoteCommitSha, undefined);
  assert.deepEqual(index.shards, {});
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
  assert.equal(github.files.has(legacyRecord.remotePath), false);
  assert.equal(github.files.has(orphanRecord.remotePath), false);
  const migrated = indexRecordByPath(index, legacyRecord.path);
  assert.equal(migrated.fileId, legacyRecord.fileId);
  assert.notEqual(migrated.remoteVersion, legacyRecord.remoteVersion);
  assert.notEqual(migrated.remotePath, legacyRecord.remotePath);
  assert.equal(migrated.encryptedPath, migrated.remotePath);
  assert.match(migrated.remotePath, /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.equal(Object.values(index.shards).flatMap(shard => Object.values(shard.records)).some(record => record.remoteVersion === "legacy-v" || record.remotePath.includes("PrivateFolder")), false);
  assert.equal(github.lastEntries.some(entry => entry.path === legacyRecord.remotePath && entry.sha === null), true);
  assert.equal(github.lastEntries.some(entry => entry.path === orphanRecord.remotePath && entry.sha === null), true);
  assert.equal(github.lastEntries.some(entry => entry.path === V4_CONFIG_PATH && entry.sha !== null), true);
  assert.equal(github.lastEntries.some(entry => entry.path === V4_HEAD_PATH && entry.sha !== null), true);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/index/") && entry.sha !== null), true);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/journals/") && entry.sha !== null), true);
  const tip = github.ref!.sha;
  const published = github.commits.get(tip)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const journal = await new V4HistoryService({ config: desiredConfig, keyring: keys, github: {
    async listCommits() { return []; }, async getFileBytes(path: string, ref?: string) { return github.getFileBytes(path, ref); },
    async getGitCommit() { throw new Error("not reached"); }, async getTreeAt() { throw new Error("not reached"); }, async getBlob() { throw new Error("not reached"); },
  } }).getCommitChanges({ sha: tip, message: published.message, authorName: "A", authoredAt: "", parentShas: published.parents, source: "plugin", journalId });
  const migratedChange = journal.find(change => change.path === legacyRecord.path)!;
  assert.equal(migratedChange.fileId, legacyRecord.fileId);
  assert.equal(migratedChange.before, undefined);
  assert.equal(migratedChange.after?.remotePath, migrated.remotePath);
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: desiredConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get(legacyRecord.path)!.bytes), "legacy secret");
  const pulled = indexRecordByPath(targetIndex, legacyRecord.path);
  assert.equal(pulled.fileId, legacyRecord.fileId);
  assert.equal(pulled.remotePath, migrated.remotePath);
  assert.equal(pulled.remoteVersion, migrated.remoteVersion);
  assert.equal(Object.values(targetIndex.shards).flatMap(shard => Object.values(shard.records)).some(record => record.remoteVersion === "legacy-v" || record.remotePath.includes("PrivateFolder")), false);
});

async function legacyMigrationEventFixture(input: { remotePath: string; localPath: string; remoteContent: string; localContent?: string; fileId: string }) {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set(input.localPath, { bytes: enc(input.localContent ?? input.remoteContent), mtime: 2 });
  const legacyConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const pathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, input.remotePath);
  const folder = input.remotePath.split("/").slice(0, -1).join("/");
  const legacyObjectPath = `.obsidian-github-sync-v4/data/${folder ? `${folder}/` : ""}legacy.enc`;
  const remoteBytes = enc(input.remoteContent);
  const legacyRecord: V4IndexFileRecord = {
    path: input.remotePath, pathId, fileId: input.fileId, plaintextSha256: await sha256Hex(remoteBytes), size: remoteBytes.byteLength, mtime: 1,
    remoteVersion: "legacy-v", remotePath: legacyObjectPath, storage: "single",
  };
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "legacy-v", shardHashes: { [pathId.slice(0, 2)]: "legacy-shard" }, updatedAt: 1, deviceId: "old" };
  const files = await buildV4RemoteMetadata({ config: legacyConfig, head, records: [legacyRecord], keyring: keys });
  files.push({ path: legacyObjectPath, bytes: await encryptV4Payload(keys.contentKey, remoteBytes, { kind: "content", aad: `${pathId}:legacy-v` }) });
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-v", files });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  return { github, vault, legacyConfig, desiredConfig, keys, legacyRecord, index };
}

async function assertMigratedEventPull(
  fixture: Awaited<ReturnType<typeof legacyMigrationEventFixture>>,
  expected: { path: string; content: string; fileId: string },
) {
  const migrated = indexRecordByPath(fixture.index, expected.path);
  assert.equal(migrated.fileId, expected.fileId);
  assert.notEqual(migrated.remotePath, fixture.legacyRecord.remotePath);
  assert.notEqual(migrated.remoteVersion, fixture.legacyRecord.remoteVersion);
  assert.equal(migrated.encryptedPath, migrated.remotePath);
  assert.match(migrated.remotePath, /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.equal(Object.values(fixture.index.shards).flatMap(shard => Object.values(shard.records)).some(record => record.remoteVersion === "legacy-v" || record.remotePath === fixture.legacyRecord.remotePath), false);
  assert.equal(fixture.github.files.has(fixture.legacyRecord.remotePath), false);
  assert.equal(fixture.github.lastEntries.some(entry => entry.path === fixture.legacyRecord.remotePath && entry.sha === null), true);
  assert.equal(fixture.github.lastEntries.some(entry => entry.path === migrated.remotePath && entry.sha !== null), true);
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await new V4SyncSession({ github: fixture.github, vault: target, index: targetIndex, config: fixture.desiredConfig, keyring: fixture.keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get(expected.path)!.bytes), expected.content);
  if (expected.path !== fixture.legacyRecord.path) assert.equal(target.files.has(fixture.legacyRecord.path), false);
  const pulled = indexRecordByPath(targetIndex, expected.path);
  assert.equal(pulled.fileId, expected.fileId);
  assert.equal(pulled.remotePath, migrated.remotePath);
  assert.equal(pulled.remoteVersion, migrated.remoteVersion);
  assert.equal(Object.values(targetIndex.shards).flatMap(shard => Object.values(shard.records)).some(record => record.remoteVersion === "legacy-v" || record.remotePath === fixture.legacyRecord.remotePath), false);
}

test("v4 legacy migration queued replacement creates a new opaque identity", async () => {
  const fixture = await legacyMigrationEventFixture({ remotePath: "same.md", localPath: "same.md", remoteContent: "old", localContent: "new", fileId: "legacy-replaced" });
  const changes = coalesceV4Changes([
    { type: "delete", path: "same.md", mtime: 1 },
    { type: "modify", path: "same.md", mtime: 2 },
  ]);

  await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.desiredConfig, keyring: fixture.keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: true, changes });

  const migrated = indexRecordByPath(fixture.index, "same.md");
  assert.notEqual(migrated.fileId, fixture.legacyRecord.fileId);
  await assertMigratedEventPull(fixture, { path: "same.md", content: "new", fileId: migrated.fileId });
});

test("v4 legacy migration queued file rename preserves the authenticated identity", async () => {
  const fixture = await legacyMigrationEventFixture({ remotePath: "Old/note.md", localPath: "New/note.md", remoteContent: "renamed", fileId: "legacy-renamed" });
  const changes: V4QueuedChange[] = [{ type: "rename", oldPath: "Old/note.md", path: "New/note.md", mtime: 2 }];

  await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.desiredConfig, keyring: fixture.keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: true, changes: coalesceV4Changes(changes) });

  await assertMigratedEventPull(fixture, { path: "New/note.md", content: "renamed", fileId: fixture.legacyRecord.fileId });
});

test("v4 legacy migration queued chained nested folder renames preserve descendant identity", async () => {
  const fixture = await legacyMigrationEventFixture({ remotePath: "A/N/note.md", localPath: "C/M/N/note.md", remoteContent: "nested", fileId: "legacy-nested" });
  const changes: V4QueuedChange[] = [
    { type: "folderRename", oldPath: "A", path: "B", mtime: 2 },
    { type: "folderRename", oldPath: "B", path: "C", mtime: 3 },
    { type: "folderRename", oldPath: "C/N", path: "C/M/N", mtime: 4 },
  ];

  await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.desiredConfig, keyring: fixture.keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: true, changes: coalesceV4Changes(changes) });

  await assertMigratedEventPull(fixture, { path: "C/M/N/note.md", content: "nested", fileId: fixture.legacyRecord.fileId });
});

test("v4 confirmed migration accepts legacy packed records with retained loose encryptedPath", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const plaintext = enc("legacy packed secret");
  vault.files.set("Legacy/note.md", { bytes: plaintext, mtime: 1 });
  const legacyConfig: V4RemoteConfig = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const codec = new (await import("../../src/lib/v4/storage-codec")).V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const loose = await codec.prepare("Legacy/note.md", plaintext, "legacy-packed-v", 1, "legacy-packed-file");
  const packed = await codec.preparePack("legacy-pack", [{ record: loose.record, plaintext }]);
  const retainedLegacyLoosePath = ".obsidian-github-sync-v4/data/Legacy/retained.enc";
  const legacyRecord: V4IndexFileRecord = { path: "Legacy/note.md", ...packed.records[0], encryptedPath: retainedLegacyLoosePath };
  const bucket = legacyRecord.pathId.slice(0, 2);
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "legacy-packed-v", shardHashes: { [bucket]: "legacy-pack-shard" }, updatedAt: 1, deviceId: "old" };
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-packed-v", files: [{ path: retainedLegacyLoosePath, bytes: loose.files[0].bytes }, packed.file, ...await buildV4RemoteMetadata({ config: legacyConfig, head, records: [legacyRecord], keyring: keys })] });
  assert.deepEqual(await codec.read(legacyRecord, async path => (await github.getFileBytes(path, github.ref!.sha))!.bytes), plaintext);
  const oldPackPath = legacyRecord.remotePath;
  const oldLoosePath = legacyRecord.encryptedPath!;
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });

  const result = await new V4SyncSession({ github, vault, index, config: desiredConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePush", allowThresholdOverride: true });

  assert.equal(result.mode, "force-push");
  assert.equal(github.files.has(oldPackPath), false);
  assert.equal(github.files.has(oldLoosePath), false);
  assert.equal(JSON.parse(dec(github.files.get(V4_CONFIG_PATH)!)).pathLayout, "opaque-stable-v1");
  const migrated = indexRecordByPath(index, "Legacy/note.md");
  assert.match(migrated.remotePath, /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.equal(dec(await codec.read(migrated, async path => (await github.getFileBytes(path, github.ref!.sha))!.bytes)), "legacy packed secret");
});

test("v4 legacy migration refuses to delete encrypted records excluded by sync scope", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const plaintext = enc("legacy secret");
  vault.files.set("Excluded/note.md", { bytes: plaintext, mtime: 1 });
  const legacyConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const pathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, "Excluded/note.md");
  const record: V4IndexFileRecord = { path: "Excluded/note.md", pathId, fileId: "excluded-file", plaintextSha256: await sha256Hex(plaintext), size: plaintext.byteLength, mtime: 1, remoteVersion: "legacy-v", remotePath: ".obsidian-github-sync-v4/data/Excluded/note.enc", storage: "single" };
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "legacy-v", shardHashes: { [pathId.slice(0, 2)]: "legacy-shard" }, updatedAt: 1, deviceId: "old" };
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
  for (let value = 0; Object.keys(shardHashes).length < 256; value++) {
    const path = `notes/${value}.md`;
    const pathId = await sha256Hex(enc(`path:${path}`));
    const bucket = pathId.slice(0, 2);
    if (shardHashes[bucket]) continue;
    const record = { path, pathId, fileId: `file-${bucket}`, plaintextSha256: `hash-${bucket}`, size: 1, mtime: 1, remoteVersion: "j1", remotePath: path, storage: "single" as const };
    const hash = `shard-${bucket}`;
    shardHashes[bucket] = hash;
    index.shardHashes[bucket] = hash;
    index.shards[bucket] = { bucket, hash, records: { [pathId]: record } };
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

test("v4 authenticated remote duplicate fileIds are rejected before normal or Force Pull mutation", async () => {
  const github = new MemoryGitHub();
  const encryptedConfig: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const firstPathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, "one.md");
  const secondPathId = await (await import("../../src/lib/v4/paths")).pathIdForV4Path(keys.pathKey, "two.md");
  const remotePath = await (await import("../../src/lib/v4/paths")).opaqueV4ObjectPath(keys.pathKey, "duplicate-id");
  const records: V4IndexFileRecord[] = [
    { path: "one.md", pathId: firstPathId, fileId: "duplicate-id", plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v", remotePath, storage: "single" },
    { path: "two.md", pathId: secondPathId, fileId: "duplicate-id", plaintextSha256: "b".repeat(64), size: 1, mtime: 1, remoteVersion: "v", remotePath, storage: "single" },
  ];
  const shardHashes = Object.fromEntries([...new Set(records.map(record => record.pathId.slice(0, 2)))].map(bucket => [bucket, `hash-${bucket}`]));
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "malicious", shardHashes, updatedAt: 1, deviceId: "attacker" };
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:malicious", files: await buildV4RemoteMetadata({ config: encryptedConfig, head, records, keyring: keys }) });
  const before = { ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size };

  for (const operation of ["normal", "forcePull"] as const) {
    const vault = new MemoryVault();
    vault.files.set("keep.md", { bytes: enc("keep"), mtime: 1 });
    const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: operation, mode: "encrypted", pathLayout: "opaque-stable-v1" });
    await assert.rejects(
      () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation, allowThresholdOverride: false }),
      /duplicate.*file.*id/iu,
    );
    assert.deepEqual(vault.operations, []);
    assert.equal(dec(vault.files.get("keep.md")!.bytes), "keep");
    assert.deepEqual({ ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size }, before);
  }
});

test("v4 authenticated remote duplicate paths and fabricated pathIds reject before normal or Force Pull mutation", async () => {
  const encryptedConfig: V4RemoteConfig = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const paths = await import("../../src/lib/v4/paths");
  const record = async (path: string, pathId: string, fileId: string): Promise<V4IndexFileRecord> => ({
    path, pathId, fileId, plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v",
    remotePath: await paths.opaqueV4ObjectPath(keys.pathKey, fileId), storage: "single",
  });
  const duplicatePathId = await paths.pathIdForV4Path(keys.pathKey, "duplicate.md");
  const cases = [
    { name: "duplicate path", records: [await record("duplicate.md", duplicatePathId, "first"), await record("duplicate.md", "fe".repeat(32), "second")] },
    { name: "fabricated pathId", records: [await record("fabricated.md", "fd".repeat(32), "only")] },
  ];

  for (const scenario of cases) {
    const github = new MemoryGitHub();
    const shardHashes = Object.fromEntries([...new Set(scenario.records.map(item => item.pathId.slice(0, 2)))].map(bucket => [bucket, `hash-${bucket}`]));
    const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "malicious", shardHashes, updatedAt: 1, deviceId: "attacker" };
    await publishV4TreeChanges(github, { message: "obsidian-sync-v4:malicious", files: await buildV4RemoteMetadata({ config: encryptedConfig, head, records: scenario.records, keyring: keys }) });
    const before = { ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size };
    for (const operation of ["normal", "forcePull"] as const) {
      const vault = new MemoryVault();
      vault.files.set("keep.md", { bytes: enc("keep"), mtime: 1 });
      const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: `${scenario.name}-${operation}`, mode: "encrypted", pathLayout: "opaque-stable-v1" });
      await assert.rejects(
        () => new V4SyncSession({ github, vault, index, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation, allowThresholdOverride: false }),
        /duplicate.*path|path.*id|logical path/iu,
      );
      assert.deepEqual(vault.operations, []);
      assert.deepEqual({ ref: github.ref!.sha, blobs: github.blobs.size, trees: github.trees.size, commits: github.commits.size }, before);
    }
  }
});
