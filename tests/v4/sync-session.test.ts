import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import type { V4JournalChange } from "../../src/lib/v4/history-journal";
import { createEmptyV4LocalIndex, type V4IndexFileRecord, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { assertV4PathLayoutCompatible, V4ChangeGuardError, V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { coalesceV4Changes, type V4QueuedChange } from "../../src/lib/v4/sync-coordinator";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { decryptV4Payload, deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { sha256Hex } from "../../src/lib/bytes";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
import type { V4SyncProgressPatch } from "../../src/lib/v4/progress";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function phases(events: V4SyncProgressPatch[]): string[] {
  return events.flatMap(event => event.phase ? [event.phase] : []);
}

function assertOrderedPhases(events: V4SyncProgressPatch[], expected: string[]): void {
  const actual = phases(events);
  let cursor = -1;
  for (const phase of expected) {
    cursor = actual.indexOf(phase, cursor + 1);
    assert.notEqual(cursor, -1, `missing ordered phase ${phase}: ${actual.join(", ")}`);
  }
}

function lastDirectional(events: V4SyncProgressPatch[], direction: "pull" | "push") {
  return [...events].reverse().find(event => event[direction])?.[direction];
}

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

async function divergedConflictFixture(conflictPaths: string[], ordinaryPullPaths: string[] = []) {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  for (const path of [...conflictPaths, ...ordinaryPullPaths]) {
    remoteVault.files.set(path, { bytes: enc(`base:${path}`), mtime: 1 });
  }
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localVault = new MemoryVault();
  localVault.files = new Map([...remoteVault.files].map(([path, file]) => [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }]));
  const localIndex = structuredClone(remoteIndex);
  localIndex.deviceId = "local";
  for (const path of [...conflictPaths, ...ordinaryPullPaths]) {
    remoteVault.files.set(path, { bytes: enc(`remote:${path}`), mtime: 2 });
  }
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [...conflictPaths, ...ordinaryPullPaths].map(path => ({ type: "modify" as const, path, mtime: 2 })),
    });
  for (const path of conflictPaths) localVault.files.set(path, { bytes: enc(`local:${path}`), mtime: 3 });
  localVault.operations.length = 0;
  return { github, localVault, localIndex };
}

async function unknownBaseFixture(mode: "plaintext" | "encrypted", localContent: string | null) {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 });
  const remoteConfig: V4RemoteConfig = mode === "plaintext"
    ? config()
    : {
        formatVersion: V4_FORMAT_VERSION,
        mode: "encrypted",
        repoId: "o/r#main",
        pathLayout: "opaque-stable-v1",
        algorithm: "AES-GCM",
        kdf: "PBKDF2-SHA-256",
        kdfParams: { iterations: 10, salt: "c2FsdA" },
      };
  const keyring = mode === "encrypted"
    ? await deriveV4Keyring({ passphrase: "correct", repoId: "o/r#main", salt: enc("salt"), iterations: 10 })
    : undefined;
  const remoteIndex = createEmptyV4LocalIndex({
    repoId: "o/r#main",
    deviceId: "remote",
    mode,
    pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
  });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: remoteConfig, keyring, conflictPolicy: "newer", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  const remoteRecord = { ...indexRecordByPath(remoteIndex, "note.md") };
  const bucket = remoteRecord.pathId.slice(0, 2);
  const index = structuredClone(remoteIndex);
  index.deviceId = "recovering";
  index.shards[bucket].hash = "inconsistent-local-cache";
  const vault = new MemoryVault();
  if (localContent !== null) vault.files.set("note.md", { bytes: enc(localContent), mtime: localContent === "remote-newer" ? 20 : 10 });
  const remoteBytes = new Uint8Array(github.files.get(remoteRecord.remotePath)!);
  return { github, vault, index, remoteConfig, keyring, remoteRecord, remoteBytes };
}

async function queuedUnknownBaseFixture(
  mode: "plaintext" | "encrypted",
  remoteFiles: Array<[path: string, content: string]>,
  localFiles: Array<[path: string, content: string]>,
) {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  for (const [path, content] of remoteFiles) remoteVault.files.set(path, { bytes: enc(content), mtime: 20 });
  const remoteConfig: V4RemoteConfig = mode === "plaintext"
    ? config()
    : {
        formatVersion: V4_FORMAT_VERSION,
        mode: "encrypted",
        repoId: "o/r#main",
        pathLayout: "opaque-stable-v1",
        algorithm: "AES-GCM",
        kdf: "PBKDF2-SHA-256",
        kdfParams: { iterations: 10, salt: "c2FsdA" },
      };
  const keyring = mode === "encrypted"
    ? await deriveV4Keyring({ passphrase: "correct", repoId: "o/r#main", salt: enc("salt"), iterations: 10 })
    : undefined;
  const remoteIndex = createEmptyV4LocalIndex({
    repoId: "o/r#main",
    deviceId: "remote",
    mode,
    pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
  });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: remoteConfig, keyring, conflictPolicy: "newer", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  const remoteRecords = Object.fromEntries(remoteFiles.map(([path]) => [path, { ...indexRecordByPath(remoteIndex, path) }]));
  const index = structuredClone(remoteIndex);
  index.deviceId = "recovering";
  index.shards[Object.keys(index.shards)[0]].hash = "inconsistent-local-cache";
  const vault = new MemoryVault();
  for (const [path, content] of localFiles) vault.files.set(path, { bytes: enc(content), mtime: 30 });
  return { mode, github, vault, index, remoteConfig, keyring, remoteRecords };
}

type QueuedUnknownBaseFixture = Awaited<ReturnType<typeof queuedUnknownBaseFixture>>;

async function latestJournalChanges(fixture: QueuedUnknownBaseFixture): Promise<V4JournalChange[]> {
  const tip = fixture.github.ref!.sha;
  const published = fixture.github.commits.get(tip)!;
  const journalId = /^obsidian-sync-v4:(.+)$/u.exec(published.message)![1];
  const encrypted = fixture.mode === "encrypted";
  const path = `${V4_ROOT}/journals/${journalId}/000000.${encrypted ? "enc" : "json"}`;
  const stored = fixture.github.files.get(path)!;
  const bytes = encrypted
    ? await decryptV4Payload(fixture.keyring!.journalKey, stored, { kind: "journal", aad: `${fixture.remoteConfig.repoId}:${journalId}:0` })
    : stored;
  return (JSON.parse(dec(bytes)) as { changes: V4JournalChange[] }).changes;
}

async function forcePullQueuedFixture(fixture: QueuedUnknownBaseFixture) {
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({
    repoId: "o/r#main",
    deviceId: "verifier",
    mode: fixture.mode,
    pathLayout: fixture.mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
  });
  await new V4SyncSession({ github: fixture.github, vault, index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "newer", abortChangePercent: 0 })
    .sync({ operation: "forcePull", allowThresholdOverride: false });
  return { vault, index };
}

for (const mode of ["plaintext", "encrypted"] as const) {
  test(`v4 ${mode} unknown-base sync resolves stale local content through conflict policy without overwriting remote`, async () => {
    const fixture = await unknownBaseFixture(mode, "local-stale");
    const commitBefore = fixture.github.ref!.sha;
    const commitsBefore = fixture.github.commits.size;

    const result = await new V4SyncSession({
      github: fixture.github,
      vault: fixture.vault,
      index: fixture.index,
      config: fixture.remoteConfig,
      keyring: fixture.keyring,
      conflictPolicy: "newer",
      abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false });

    assert.equal(result.mode, "pull");
    assert.equal(dec(fixture.vault.files.get("note.md")!.bytes), "remote-newer");
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.equal(fixture.github.commits.size, commitsBefore);
    assert.deepEqual(fixture.github.files.get(fixture.remoteRecord.remotePath), fixture.remoteBytes);
    assert.equal(indexRecordByPath(fixture.index, "note.md").fileId, fixture.remoteRecord.fileId);

    const verifierVault = new MemoryVault();
    const verifierIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "verifier", mode, pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1" });
    await new V4SyncSession({ github: fixture.github, vault: verifierVault, index: verifierIndex, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "newer", abortChangePercent: 0 })
      .sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.equal(dec(verifierVault.files.get("note.md")!.bytes), "remote-newer");
  });

  test(`v4 ${mode} unknown-base sync no-ops identical content and preserves current remote identity`, async () => {
    const fixture = await unknownBaseFixture(mode, "remote-newer");
    const commitBefore = fixture.github.ref!.sha;
    const commitsBefore = fixture.github.commits.size;

    const result = await new V4SyncSession({
      github: fixture.github,
      vault: fixture.vault,
      index: fixture.index,
      config: fixture.remoteConfig,
      keyring: fixture.keyring,
      conflictPolicy: "newer",
      abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false });

    assert.equal(result.mode, "noop");
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.equal(fixture.github.commits.size, commitsBefore);
    assert.deepEqual(fixture.github.files.get(fixture.remoteRecord.remotePath), fixture.remoteBytes);
    assert.equal(indexRecordByPath(fixture.index, "note.md").fileId, fixture.remoteRecord.fileId);
  });

  test(`v4 ${mode} unknown-base sync pulls current remote content into an empty vault`, async () => {
    const fixture = await unknownBaseFixture(mode, null);
    const commitBefore = fixture.github.ref!.sha;
    const commitsBefore = fixture.github.commits.size;

    const result = await new V4SyncSession({
      github: fixture.github,
      vault: fixture.vault,
      index: fixture.index,
      config: fixture.remoteConfig,
      keyring: fixture.keyring,
      conflictPolicy: "newer",
      abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false });

    assert.equal(result.mode, "pull");
    assert.equal(dec(fixture.vault.files.get("note.md")!.bytes), "remote-newer");
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.equal(fixture.github.commits.size, commitsBefore);
    assert.deepEqual(fixture.github.files.get(fixture.remoteRecord.remotePath), fixture.remoteBytes);
    assert.equal(indexRecordByPath(fixture.index, "note.md").fileId, fixture.remoteRecord.fileId);
  });
}

test("v4 plaintext unknown-base sync pulls remote state before publishing a distinct local-only path", async () => {
  const fixture = await unknownBaseFixture("plaintext", null);
  fixture.vault.files.set("local-only.md", { bytes: enc("local-only"), mtime: 10 });
  const commitBefore = fixture.github.ref!.sha;

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.vault,
    index: fixture.index,
    config: fixture.remoteConfig,
    conflictPolicy: "newer",
    abortChangePercent: 0,
  }).sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(result.mode, "pull-push");
  assert.notEqual(fixture.github.ref!.sha, commitBefore);
  assert.equal(dec(fixture.vault.files.get("note.md")!.bytes), "remote-newer");
  assert.equal(dec(fixture.github.files.get("note.md")!), "remote-newer");
  assert.equal(dec(fixture.github.files.get("local-only.md")!), "local-only");
  assert.equal(indexRecordByPath(fixture.index, "note.md").fileId, fixture.remoteRecord.fileId);

  const verifierVault = new MemoryVault();
  const verifierIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "verifier", mode: "plaintext" });
  await new V4SyncSession({ github: fixture.github, vault: verifierVault, index: verifierIndex, config: config(), conflictPolicy: "newer", abortChangePercent: 0 })
    .sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(verifierVault.files.get("note.md")!.bytes), "remote-newer");
  assert.equal(dec(verifierVault.files.get("local-only.md")!.bytes), "local-only");
});

for (const mode of ["plaintext", "encrypted"] as const) {
  test(`v4 ${mode} unknown-base queued delete removes the remote identity, object, and journal entry`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["note.md", "delete-me"]], []);
    const before = fixture.remoteRecords["note.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "newer", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "note.md", mtime: 30 }] });

    assert.equal(result.mode, "push");
    assert.equal(fixture.github.files.has(before.remotePath), false);
    assert.equal(Object.values(fixture.index.shards).flatMap(shard => Object.values(shard.records)).some(record => record.fileId === before.fileId), false);
    const changes = await latestJournalChanges(fixture);
    assert.deepEqual(changes.map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path, hasBefore: !!change.before, hasAfter: !!change.after })), [
      { fileId: before.fileId, kind: "delete", path: "note.md", hasBefore: true, hasAfter: false },
    ]);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("note.md"), false);
  });

  test(`v4 ${mode} unknown-base queued same-path replacement deletes the old identity and publishes one new record`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["note.md", "old-content"]], [["note.md", "replacement-content"]]);
    const before = fixture.remoteRecords["note.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "newer", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "replace", oldPath: "note.md", path: "note.md", mtime: 30 }] });

    assert.equal(result.mode, "push");
    const finalRecords = Object.values(fixture.index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
    assert.equal(finalRecords.length, 1);
    assert.equal(finalRecords[0].path, "note.md");
    assert.notEqual(finalRecords[0].fileId, before.fileId);
    if (mode === "encrypted") assert.equal(fixture.github.files.has(before.remotePath), false);
    const changes = await latestJournalChanges(fixture);
    const deleted = changes.find(change => change.fileId === before.fileId)!;
    const created = changes.find(change => change.fileId === finalRecords[0].fileId)!;
    assert.deepEqual({ kind: deleted.kind, path: deleted.path, hasBefore: !!deleted.before, hasAfter: !!deleted.after }, { kind: "delete", path: "note.md", hasBefore: true, hasAfter: false });
    assert.deepEqual({ kind: created.kind, path: created.path, hasBefore: !!created.before, hasAfter: !!created.after }, { kind: "create", path: "note.md", hasBefore: false, hasAfter: true });
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(dec(pulled.vault.files.get("note.md")!.bytes), "replacement-content");
    assert.equal(indexRecordByPath(pulled.index, "note.md").fileId, finalRecords[0].fileId);
  });

  test(`v4 ${mode} unknown-base queued file rename preserves identity without conflict fallback`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["old.md", "rename-content"]], [["new.md", "rename-content"]]);
    const before = fixture.remoteRecords["old.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "ask", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 30 }] });

    assert.equal(result.mode, "push");
    const after = indexRecordByPath(fixture.index, "new.md");
    assert.equal(after.fileId, before.fileId);
    if (mode === "encrypted") assert.equal(after.remotePath, before.remotePath);
    else assert.equal(fixture.github.files.has("old.md"), false);
    const changes = await latestJournalChanges(fixture);
    assert.deepEqual(changes.map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path, previousPath: change.previousPath })), [
      { fileId: before.fileId, kind: "rename", path: "new.md", previousPath: "old.md" },
    ]);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("old.md"), false);
    assert.equal(dec(pulled.vault.files.get("new.md")!.bytes), "rename-content");
    assert.equal(indexRecordByPath(pulled.index, "new.md").fileId, before.fileId);
  });

  test(`v4 ${mode} unknown-base queued rename still conflicts when local content diverges`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["old.md", "remote-newer"]], [["new.md", "local-stale"]]);
    fixture.vault.files.get("new.md")!.mtime = 10;
    const before = fixture.remoteRecords["old.md"];
    const commitBefore = fixture.github.ref!.sha;

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "newer", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 30 }] });

    assert.equal(result.mode, "pull");
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.equal(fixture.vault.files.has("new.md"), false);
    assert.equal(dec(fixture.vault.files.get("old.md")!.bytes), "remote-newer");
    assert.equal(indexRecordByPath(fixture.index, "old.md").fileId, before.fileId);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("new.md"), false);
    assert.equal(dec(pulled.vault.files.get("old.md")!.bytes), "remote-newer");
  });

  test(`v4 ${mode} unknown-base queued chained folder rename preserves descendant identities without conflicts`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode,
      [["Folder/a.md", "a-content"], ["Folder/sub/b.md", "b-content"]],
      [["Moved/a.md", "a-content"], ["Moved/sub/b.md", "b-content"]]);
    const beforeA = fixture.remoteRecords["Folder/a.md"];
    const beforeB = fixture.remoteRecords["Folder/sub/b.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "ask", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [
        { type: "folderRename", oldPath: "Folder", path: "Middle", mtime: 29 },
        { type: "folderRename", oldPath: "Middle", path: "Moved", mtime: 30 },
      ] });

    assert.equal(result.mode, "push");
    const afterA = indexRecordByPath(fixture.index, "Moved/a.md");
    const afterB = indexRecordByPath(fixture.index, "Moved/sub/b.md");
    assert.equal(afterA.fileId, beforeA.fileId);
    assert.equal(afterB.fileId, beforeB.fileId);
    if (mode === "encrypted") {
      assert.equal(afterA.remotePath, beforeA.remotePath);
      assert.equal(afterB.remotePath, beforeB.remotePath);
    } else {
      assert.equal(fixture.github.files.has("Folder/a.md"), false);
      assert.equal(fixture.github.files.has("Folder/sub/b.md"), false);
    }
    const changes = (await latestJournalChanges(fixture)).map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path, previousPath: change.previousPath }))
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(changes, [
      { fileId: beforeA.fileId, kind: "rename", path: "Moved/a.md", previousPath: "Folder/a.md" },
      { fileId: beforeB.fileId, kind: "rename", path: "Moved/sub/b.md", previousPath: "Folder/sub/b.md" },
    ]);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("Folder/a.md"), false);
    assert.equal(pulled.vault.files.has("Folder/sub/b.md"), false);
    assert.equal(dec(pulled.vault.files.get("Moved/a.md")!.bytes), "a-content");
    assert.equal(dec(pulled.vault.files.get("Moved/sub/b.md")!.bytes), "b-content");
    assert.equal(indexRecordByPath(pulled.index, "Moved/a.md").fileId, beforeA.fileId);
    assert.equal(indexRecordByPath(pulled.index, "Moved/sub/b.md").fileId, beforeB.fileId);
  });

  test(`v4 ${mode} unknown-base queued folder rename then delete removes every terminal identity`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode,
      [["Folder/a.md", "a-content"], ["Folder/sub/b.md", "b-content"]],
      []);
    const beforeA = fixture.remoteRecords["Folder/a.md"];
    const beforeB = fixture.remoteRecords["Folder/sub/b.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "ask", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [
        { type: "folderRename", oldPath: "Folder", path: "Moved", mtime: 29 },
        { type: "folderDelete", path: "Moved", mtime: 30 },
      ] });

    assert.equal(result.mode, "push");
    const finalRecords = Object.values(fixture.index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
    assert.deepEqual(finalRecords, []);
    assert.equal(fixture.github.files.has(beforeA.remotePath), false);
    assert.equal(fixture.github.files.has(beforeB.remotePath), false);
    const changes = (await latestJournalChanges(fixture)).map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path, hasBefore: !!change.before, hasAfter: !!change.after }))
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(changes, [
      { fileId: beforeA.fileId, kind: "delete", path: "Folder/a.md", hasBefore: true, hasAfter: false },
      { fileId: beforeB.fileId, kind: "delete", path: "Folder/sub/b.md", hasBefore: true, hasAfter: false },
    ]);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.deepEqual([...pulled.vault.files.keys()], []);
  });

  test(`v4 ${mode} unknown-base queued folder rename then descendant delete preserves the surviving identity`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode,
      [["Folder/a.md", "delete-me"], ["Folder/sub/b.md", "keep-me"]],
      [["Moved/sub/b.md", "keep-me"]]);
    const beforeA = fixture.remoteRecords["Folder/a.md"];
    const beforeB = fixture.remoteRecords["Folder/sub/b.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "ask", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [
        { type: "folderRename", oldPath: "Folder", path: "Moved", mtime: 29 },
        { type: "delete", path: "Moved/a.md", mtime: 30 },
      ] });

    assert.equal(result.mode, "push");
    assert.equal(fixture.github.files.has(beforeA.remotePath), false);
    const afterB = indexRecordByPath(fixture.index, "Moved/sub/b.md");
    assert.equal(afterB.fileId, beforeB.fileId);
    if (mode === "encrypted") assert.equal(afterB.remotePath, beforeB.remotePath);
    else assert.equal(fixture.github.files.has(beforeB.remotePath), false);
    const changes = (await latestJournalChanges(fixture)).map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path, previousPath: change.previousPath }))
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(changes, [
      { fileId: beforeA.fileId, kind: "delete", path: "Folder/a.md", previousPath: undefined },
      { fileId: beforeB.fileId, kind: "rename", path: "Moved/sub/b.md", previousPath: "Folder/sub/b.md" },
    ]);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("Folder/a.md"), false);
    assert.equal(pulled.vault.files.has("Folder/sub/b.md"), false);
    assert.equal(pulled.vault.files.has("Moved/a.md"), false);
    assert.equal(dec(pulled.vault.files.get("Moved/sub/b.md")!.bytes), "keep-me");
    assert.equal(indexRecordByPath(pulled.index, "Moved/sub/b.md").fileId, beforeB.fileId);
  });

  test(`v4 ${mode} unknown-base queued folder rename then descendant replacement deletes the old identity`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode,
      [["Folder/a.md", "old-content"], ["Folder/sub/b.md", "keep-me"]],
      [["Moved/a.md", "replacement-content"], ["Moved/sub/b.md", "keep-me"]]);
    const beforeA = fixture.remoteRecords["Folder/a.md"];
    const beforeB = fixture.remoteRecords["Folder/sub/b.md"];

    const result = await new V4SyncSession({ github: fixture.github, vault: fixture.vault, index: fixture.index, config: fixture.remoteConfig, keyring: fixture.keyring, conflictPolicy: "ask", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [
        { type: "folderRename", oldPath: "Folder", path: "Moved", mtime: 29 },
        { type: "replace", oldPath: "Moved/a.md", path: "Moved/a.md", mtime: 30 },
      ] });

    assert.equal(result.mode, "push");
    assert.equal(fixture.github.files.has(beforeA.remotePath), false);
    const afterA = indexRecordByPath(fixture.index, "Moved/a.md");
    const afterB = indexRecordByPath(fixture.index, "Moved/sub/b.md");
    assert.notEqual(afterA.fileId, beforeA.fileId);
    assert.equal(afterB.fileId, beforeB.fileId);
    const changes = await latestJournalChanges(fixture);
    const deleted = changes.find(change => change.fileId === beforeA.fileId)!;
    const created = changes.find(change => change.fileId === afterA.fileId)!;
    const renamed = changes.find(change => change.fileId === beforeB.fileId)!;
    assert.deepEqual({ kind: deleted.kind, path: deleted.path, hasBefore: !!deleted.before, hasAfter: !!deleted.after }, { kind: "delete", path: "Folder/a.md", hasBefore: true, hasAfter: false });
    assert.deepEqual({ kind: created.kind, path: created.path, hasBefore: !!created.before, hasAfter: !!created.after }, { kind: "create", path: "Moved/a.md", hasBefore: false, hasAfter: true });
    assert.deepEqual({ kind: renamed.kind, path: renamed.path, previousPath: renamed.previousPath }, { kind: "rename", path: "Moved/sub/b.md", previousPath: "Folder/sub/b.md" });
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(pulled.vault.files.has("Folder/a.md"), false);
    assert.equal(pulled.vault.files.has("Folder/sub/b.md"), false);
    assert.equal(dec(pulled.vault.files.get("Moved/a.md")!.bytes), "replacement-content");
    assert.equal(dec(pulled.vault.files.get("Moved/sub/b.md")!.bytes), "keep-me");
    assert.equal(indexRecordByPath(pulled.index, "Moved/a.md").fileId, afterA.fileId);
    assert.equal(indexRecordByPath(pulled.index, "Moved/sub/b.md").fileId, beforeB.fileId);
  });

  test(`v4 ${mode} unknown-base coalesced file rename cycle invokes conflict policy without overwriting remote`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["A.md", "remote-newer"]], [["A.md", "local-stale"]]);
    fixture.vault.files.get("A.md")!.mtime = 10;
    const before = fixture.remoteRecords["A.md"];
    const remoteObjectBefore = new Uint8Array(fixture.github.files.get(before.remotePath)!);
    const commitBefore = fixture.github.ref!.sha;
    const commitsBefore = fixture.github.commits.size;
    const journalPathsBefore = [...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort();
    const changes = coalesceV4Changes([
      { type: "rename", oldPath: "A.md", path: "B.md", mtime: 29 },
      { type: "rename", oldPath: "B.md", path: "A.md", mtime: 30 },
    ]);
    assert.deepEqual(changes, [{ type: "rename", oldPath: "A.md", path: "A.md", mtime: 30 }]);
    const asked: Array<{ path: string; localMtime: number; remoteMtime: number }> = [];

    const result = await new V4SyncSession({
      github: fixture.github,
      vault: fixture.vault,
      index: fixture.index,
      config: fixture.remoteConfig,
      keyring: fixture.keyring,
      conflictPolicy: "ask",
      askConflict: async input => { asked.push(input); return { action: "use-remote" }; },
      abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false, changes });

    assert.equal(result.mode, "pull");
    assert.deepEqual(asked, [{ path: "A.md", localMtime: 10, remoteMtime: 20 }]);
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.equal(fixture.github.commits.size, commitsBefore);
    assert.deepEqual([...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort(), journalPathsBefore);
    assert.deepEqual(fixture.github.files.get(before.remotePath), remoteObjectBefore);
    assert.equal(dec(fixture.vault.files.get("A.md")!.bytes), "remote-newer");
    assert.equal(indexRecordByPath(fixture.index, "A.md").fileId, before.fileId);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(dec(pulled.vault.files.get("A.md")!.bytes), "remote-newer");
    assert.equal(indexRecordByPath(pulled.index, "A.md").fileId, before.fileId);
  });

  test(`v4 ${mode} unknown-base unchanged file rename cycle no-ops and preserves identity`, async () => {
    const fixture = await queuedUnknownBaseFixture(mode, [["A.md", "same-content"]], [["A.md", "same-content"]]);
    const before = fixture.remoteRecords["A.md"];
    const remoteObjectBefore = new Uint8Array(fixture.github.files.get(before.remotePath)!);
    const commitBefore = fixture.github.ref!.sha;
    const journalPathsBefore = [...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort();
    const changes = coalesceV4Changes([
      { type: "rename", oldPath: "A.md", path: "B.md", mtime: 29 },
      { type: "rename", oldPath: "B.md", path: "A.md", mtime: 30 },
    ]);

    const result = await new V4SyncSession({
      github: fixture.github,
      vault: fixture.vault,
      index: fixture.index,
      config: fixture.remoteConfig,
      keyring: fixture.keyring,
      conflictPolicy: "ask",
      askConflict: async () => { throw new Error("unchanged rename cycle must not conflict"); },
      abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false, changes });

    assert.equal(result.mode, "noop");
    assert.equal(fixture.github.ref!.sha, commitBefore);
    assert.deepEqual([...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort(), journalPathsBefore);
    assert.deepEqual(fixture.github.files.get(before.remotePath), remoteObjectBefore);
    assert.equal(indexRecordByPath(fixture.index, "A.md").fileId, before.fileId);
    const pulled = await forcePullQueuedFixture(fixture);
    assert.equal(dec(pulled.vault.files.get("A.md")!.bytes), "same-content");
    assert.equal(indexRecordByPath(pulled.index, "A.md").fileId, before.fileId);
  });
}

test("v4 encrypted unknown-base folder rename cycle applies conflict policy to surviving descendants", async () => {
  const fixture = await queuedUnknownBaseFixture("encrypted",
    [["A/divergent.md", "remote-newer"], ["A/sub/unchanged.md", "same-content"]],
    [["A/divergent.md", "local-stale"], ["A/sub/unchanged.md", "same-content"]]);
  fixture.vault.files.get("A/divergent.md")!.mtime = 10;
  const divergentBefore = fixture.remoteRecords["A/divergent.md"];
  const unchangedBefore = fixture.remoteRecords["A/sub/unchanged.md"];
  const divergentObjectBefore = new Uint8Array(fixture.github.files.get(divergentBefore.remotePath)!);
  const unchangedObjectBefore = new Uint8Array(fixture.github.files.get(unchangedBefore.remotePath)!);
  const commitBefore = fixture.github.ref!.sha;
  const commitsBefore = fixture.github.commits.size;
  const journalPathsBefore = [...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort();
  const changes = coalesceV4Changes([
    { type: "folderRename", oldPath: "A", path: "B", mtime: 29 },
    { type: "folderRename", oldPath: "B", path: "A", mtime: 30 },
  ]);
  assert.deepEqual(changes, [
    { type: "folderRename", oldPath: "A", path: "B", mtime: 29 },
    { type: "folderRename", oldPath: "B", path: "A", mtime: 30 },
  ]);
  const asked: string[] = [];

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.vault,
    index: fixture.index,
    config: fixture.remoteConfig,
    keyring: fixture.keyring,
    conflictPolicy: "ask",
    askConflict: async input => { asked.push(input.path); return { action: "use-remote" }; },
    abortChangePercent: 0,
  }).sync({ operation: "normal", allowThresholdOverride: false, changes });

  assert.equal(result.mode, "pull");
  assert.deepEqual(asked, ["A/divergent.md"]);
  assert.equal(fixture.github.ref!.sha, commitBefore);
  assert.equal(fixture.github.commits.size, commitsBefore);
  assert.deepEqual([...fixture.github.files.keys()].filter(path => path.startsWith(`${V4_ROOT}/journals/`)).sort(), journalPathsBefore);
  assert.deepEqual(fixture.github.files.get(divergentBefore.remotePath), divergentObjectBefore);
  assert.deepEqual(fixture.github.files.get(unchangedBefore.remotePath), unchangedObjectBefore);
  assert.equal(dec(fixture.vault.files.get("A/divergent.md")!.bytes), "remote-newer");
  assert.equal(dec(fixture.vault.files.get("A/sub/unchanged.md")!.bytes), "same-content");
  assert.equal(indexRecordByPath(fixture.index, "A/divergent.md").fileId, divergentBefore.fileId);
  assert.equal(indexRecordByPath(fixture.index, "A/sub/unchanged.md").fileId, unchangedBefore.fileId);
  const pulled = await forcePullQueuedFixture(fixture);
  assert.equal(dec(pulled.vault.files.get("A/divergent.md")!.bytes), "remote-newer");
  assert.equal(dec(pulled.vault.files.get("A/sub/unchanged.md")!.bytes), "same-content");
  assert.equal(indexRecordByPath(pulled.index, "A/divergent.md").fileId, divergentBefore.fileId);
  assert.equal(indexRecordByPath(pulled.index, "A/sub/unchanged.md").fileId, unchangedBefore.fileId);
});

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
  const forcePushEvents: V4SyncProgressPatch[] = [];
  const session = new V4SyncSession({
    github,
    vault: source,
    index,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => {
      forcePushEvents.push(structuredClone(event));
      throw new Error("progress callback failure must be isolated");
    },
  });
  const pushed = await session.sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(pushed.changedFiles, 2);
  assert.equal(github.commitMessages.length, 1);
  assert.equal(dec(github.files.get("a.md")!), "one");
  assert.equal(forcePushEvents.some(event => (event.pull?.completed ?? 0) > 0), false);
  assert.equal(forcePushEvents.some(event => event.currentDirection === "pull"), false);
  assert.equal(forcePushEvents.some(event => (event.push?.total ?? 0) > 0), true);
  assert.deepEqual(lastDirectional(forcePushEvents, "push"), { completed: 2, total: 2 });
  const noChangeEvents: V4SyncProgressPatch[] = [];
  const noChangeSession = new V4SyncSession({
    github,
    vault: source,
    index,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => noChangeEvents.push(structuredClone(event)),
  });
  const noop = await noChangeSession.sync({ operation: "normal", allowThresholdOverride: false });
  assert.equal(noop.changedFiles, 0);
  assert.equal(github.commitMessages.length, 1);
  assert.equal(noChangeEvents.at(-1)?.phase, "planning");
  assert.deepEqual(lastDirectional(noChangeEvents, "pull"), { completed: 0, total: 0 });
  assert.deepEqual(lastDirectional(noChangeEvents, "push"), { completed: 0, total: 0 });

  const target = new MemoryVault();
  target.files.set("old.md", { bytes: enc("old"), mtime: 1 });
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d2", mode: "plaintext" });
  const forcePullEvents: V4SyncProgressPatch[] = [];
  const pulled = await new V4SyncSession({
    github,
    vault: target,
    index: targetIndex,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => forcePullEvents.push(structuredClone(event)),
  }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(pulled.changedFiles, 3);
  assert.equal(dec(target.files.get("a.md")!.bytes), "one");
  assert.equal(target.files.has("old.md"), false);
  assert.equal(forcePullEvents.some(event => (event.push?.completed ?? 0) > 0), false);
  assert.equal(forcePullEvents.some(event => event.currentDirection === "push"), false);
  assert.equal(forcePullEvents.some(event => (event.pull?.total ?? 0) > 0), true);
  assert.deepEqual(lastDirectional(forcePullEvents, "pull"), { completed: 3, total: 3 });
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
  const events: V4SyncProgressPatch[] = [];
  const session = new V4SyncSession({
    github,
    vault: second,
    index: secondIndex,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => events.push(structuredClone(event)),
  });
  const result = await session.sync({ operation: "normal", allowThresholdOverride: false });
  assert.equal(result.mode, "pull-push");
  assertOrderedPhases(events, [
    "checking-remote", "scanning-local", "hashing", "planning",
    "downloading", "applying", "uploading", "committing",
  ]);
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 1, total: 1 });
  assert.deepEqual(lastDirectional(events, "push"), { completed: 1, total: 1 });
  assert.equal(events.some(event => event.currentPath === "remote.md" && event.currentDirection === "pull"), true);
  assert.equal(events.some(event => event.currentPath === "local.md" && event.currentDirection === "push"), true);
  assert.ok(second.operations.indexOf("write:remote.md") < github.commitMessages.length + second.operations.length);
  assert.equal(dec(second.files.get("remote.md")!.bytes), "from remote");
  assert.equal(dec(github.files.get("local.md")!), "from local");
});

for (const resolution of ["use-remote", "use-local"] as const) {
  test(`v4 conflict progress keeps totals unknown then finalizes ${resolution} before transfer`, async () => {
    const github = new MemoryGitHub();
    const remoteVault = new MemoryVault();
    remoteVault.files.set("conflict.md", { bytes: enc("base"), mtime: 1 });
    const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
    await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "forcePush", allowThresholdOverride: false });

    const localVault = new MemoryVault();
    localVault.files.set("conflict.md", { bytes: enc("base"), mtime: 1 });
    const localIndex = structuredClone(remoteIndex);
    localIndex.deviceId = "local";
    remoteVault.files.set("conflict.md", { bytes: enc("remote"), mtime: 2 });
    await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 2 }] });
    localVault.files.set("conflict.md", { bytes: enc("local"), mtime: 3 });

    const events: V4SyncProgressPatch[] = [];
    const result = await new V4SyncSession({
      github,
      vault: localVault,
      index: localIndex,
      config: config(),
      conflictPolicy: "ask",
      abortChangePercent: 0,
      onProgress: event => events.push(structuredClone(event)),
      askConflict: async input => {
        assert.equal(input.path, "conflict.md");
        const resolving = [...events].reverse().find(event => event.phase === "resolving-conflicts");
        assert.ok(resolving);
        assert.equal(resolving.currentPath, "conflict.md");
        assert.equal(resolving.pull?.total, undefined);
        assert.equal(resolving.push?.total, undefined);
        return { action: resolution };
      },
    }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

    assert.equal(events.some(event => event.phase === "resolving-conflicts" && event.currentPath === "conflict.md"), true);
    const resolvingIndex = events.findIndex(event => event.phase === "resolving-conflicts");
    if (resolution === "use-remote") {
      assert.equal(result.mode, "pull");
      const exactIndex = events.findIndex((event, index) => index > resolvingIndex && event.pull?.total === 1);
      const applyingIndex = events.findIndex((event, index) => index > resolvingIndex && event.phase === "applying");
      assert.ok(exactIndex > resolvingIndex && exactIndex < applyingIndex);
      assert.deepEqual(lastDirectional(events, "pull"), { completed: 1, total: 1 });
      assert.deepEqual(lastDirectional(events, "push"), { completed: 0, total: 0 });
    } else {
      assert.equal(result.mode, "push");
      const exactIndex = events.findIndex((event, index) => index > resolvingIndex && event.push?.total === 1);
      const preparationIndex = events.findIndex((event, index) => index > resolvingIndex && event.phase === "hashing" && event.currentPath === "conflict.md");
      assert.ok(exactIndex > resolvingIndex && exactIndex < preparationIndex);
      assert.deepEqual(lastDirectional(events, "pull"), { completed: 0, total: 0 });
      assert.deepEqual(lastDirectional(events, "push"), { completed: 1, total: 1 });
    }
  });
}

test("v4 resolves every conflict and exact total before an ordinary pull mutates the vault", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"], ["ordinary.md"]);
  const prompt = deferred<{ action: "use-remote" }>();
  const events: V4SyncProgressPatch[] = [];
  let promptPending = false;
  const run = new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    onProgress: event => events.push(structuredClone(event)),
    askConflict: async input => {
      assert.equal(input.path, "conflict.md");
      promptPending = true;
      return prompt.promise;
    },
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

  for (let tick = 0; !promptPending && tick < 50; tick++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(promptPending, true);
  const operationsBeforeDecision = [...fixture.localVault.operations];
  const eventsBeforeDecision = events.map(event => structuredClone(event));
  prompt.resolve({ action: "use-remote" });
  const result = await run;

  assert.deepEqual(operationsBeforeDecision.filter(operation => /^(?:write|delete):/u.test(operation)), []);
  assert.equal(eventsBeforeDecision.some(event => event.phase === "downloading" || event.phase === "applying"), false);
  assert.equal(eventsBeforeDecision.some(event => (event.pull?.completed ?? 0) > 0), false);
  const exactIndex = events.findIndex(event => event.phase === "resolving-conflicts"
    && event.pull?.completed === 0 && event.pull.total === 2
    && event.push?.completed === 0 && event.push.total === 0);
  const firstTransferIndex = events.findIndex(event => event.phase === "downloading" || event.phase === "applying");
  assert.ok(exactIndex >= 0 && exactIndex < firstTransferIndex, `exact=${exactIndex}, transfer=${firstTransferIndex}`);
  assert.equal(result.mode, "pull");
  assert.equal(result.pulledFiles, 2);
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 2, total: 2 });
  assert.equal(dec(fixture.localVault.files.get("ordinary.md")!.bytes), "remote:ordinary.md");
  assert.equal(dec(fixture.localVault.files.get("conflict.md")!.bytes), "remote:conflict.md");
});

test("v4 keep-local-copy-remote counts the cached conflict copy as one pull and two pushes", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"]);
  const events: V4SyncProgressPatch[] = [];
  const timeline: Array<{ kind: "progress"; event: V4SyncProgressPatch } | { kind: "write"; path: string }> = [];
  const write = fixture.localVault.write.bind(fixture.localVault);
  fixture.localVault.write = async (path, data, mtime) => {
    timeline.push({ kind: "write", path });
    await write(path, data, mtime);
  };

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    now: () => 100,
    onProgress: event => {
      const copy = structuredClone(event);
      events.push(copy);
      timeline.push({ kind: "progress", event: copy });
    },
    askConflict: async () => ({ action: "keep-local-copy-remote" }),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

  const copyPath = [...fixture.localVault.files.keys()].find(path => path.includes(".conflict-remote-"));
  assert.equal(copyPath, "conflict.conflict-remote-local-100.md");
  const exactIndex = timeline.findIndex(item => item.kind === "progress"
    && item.event.phase === "resolving-conflicts"
    && item.event.pull?.completed === 0 && item.event.pull.total === 1
    && item.event.push?.completed === 0 && item.event.push.total === 2);
  const writeIndex = timeline.findIndex(item => item.kind === "write" && item.path === copyPath);
  const completionIndex = timeline.findIndex(item => item.kind === "progress"
    && item.event.currentPath === copyPath && item.event.pull?.completed === 1);
  assert.ok(exactIndex >= 0 && exactIndex < writeIndex && writeIndex < completionIndex, `exact=${exactIndex}, write=${writeIndex}, completion=${completionIndex}`);
  assert.equal(events.some(event => event.phase === "applying" && event.currentPath === copyPath && event.currentDirection === "pull"), true);
  assert.equal(events.some(event => event.phase === "downloading" && event.currentPath === copyPath), false);
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 1, total: 1 });
  assert.deepEqual(lastDirectional(events, "push"), { completed: 2, total: 2 });
  assert.equal(result.pulledFiles, 1);
  assert.equal(result.pushedFiles, 2);
  assert.equal(dec(fixture.localVault.files.get("conflict.md")!.bytes), "local:conflict.md");
  assert.equal(dec(fixture.localVault.files.get(copyPath!)!.bytes), "remote:conflict.md");
  assert.equal(dec(fixture.github.files.get("conflict.md")!), "local:conflict.md");
  assert.equal(dec(fixture.github.files.get(copyPath!)!), "remote:conflict.md");
});

test("v4 keep-local-copy-remote leaves pull incomplete with applying context when the copy write fails", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"]);
  const events: V4SyncProgressPatch[] = [];
  const write = fixture.localVault.write.bind(fixture.localVault);
  fixture.localVault.write = async (path, data, mtime) => {
    if (path.includes(".conflict-remote-")) throw new Error("copy write failed");
    await write(path, data, mtime);
  };

  await assert.rejects(
    () => new V4SyncSession({
      github: fixture.github,
      vault: fixture.localVault,
      index: fixture.localIndex,
      config: config(),
      conflictPolicy: "ask",
      abortChangePercent: 0,
      now: () => 100,
      onProgress: event => events.push(structuredClone(event)),
      askConflict: async () => ({ action: "keep-local-copy-remote" }),
    }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] }),
    /copy write failed/iu,
  );

  assert.equal(events.at(-1)?.phase, "applying");
  assert.equal(events.at(-1)?.currentPath, "conflict.conflict-remote-local-100.md");
  assert.equal(events.at(-1)?.currentDirection, "pull");
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 0, total: 1 });
});

test("v4 defers a merged local write until every conflict decision and exact total are final", async () => {
  const fixture = await divergedConflictFixture(["A.md", "B.md"]);
  const secondDecision = deferred<{ action: "use-local" }>();
  const events: V4SyncProgressPatch[] = [];
  const timeline: Array<{ kind: "progress"; event: V4SyncProgressPatch } | { kind: "write"; path: string }> = [];
  const write = fixture.localVault.write.bind(fixture.localVault);
  fixture.localVault.write = async (path, data, mtime) => {
    timeline.push({ kind: "write", path });
    await write(path, data, mtime);
  };
  let secondPromptPending = false;
  const run = new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    onProgress: event => {
      const copy = structuredClone(event);
      events.push(copy);
      timeline.push({ kind: "progress", event: copy });
    },
    askConflict: async input => {
      if (input.path === "A.md") return { action: "merged", mergedBytes: enc("merged:A.md") };
      secondPromptPending = true;
      return secondDecision.promise;
    },
  }).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: ["A.md", "B.md"].map(path => ({ type: "modify" as const, path, mtime: 3 })),
  });

  for (let tick = 0; !secondPromptPending && tick < 50; tick++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(secondPromptPending, true);
  const writesBeforeFinalDecision = timeline.filter(item => item.kind === "write").map(item => item.path);
  secondDecision.resolve({ action: "use-local" });
  const result = await run;

  assert.deepEqual(writesBeforeFinalDecision, []);
  const exactIndex = timeline.findIndex(item => item.kind === "progress"
    && item.event.phase === "resolving-conflicts"
    && item.event.pull?.total === 0 && item.event.push?.total === 2);
  const mergedWriteIndex = timeline.findIndex(item => item.kind === "write" && item.path === "A.md");
  assert.ok(exactIndex >= 0 && exactIndex < mergedWriteIndex, `exact=${exactIndex}, write=${mergedWriteIndex}`);
  assert.equal(events.some(event => event.phase === "applying" && event.currentPath === "A.md"), true);
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 0, total: 0 });
  assert.deepEqual(lastDirectional(events, "push"), { completed: 2, total: 2 });
  assert.equal(result.pushedFiles, 2);
  assert.equal(dec(fixture.localVault.files.get("A.md")!.bytes), "merged:A.md");
  assert.equal(dec(fixture.github.files.get("A.md")!), "merged:A.md");
});

test("v4 failed pull progress retains the active logical path", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  source.files.set("broken.md", { bytes: enc("remote"), mtime: 1 });
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "source", mode: "plaintext" });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  github.files.delete("broken.md");
  github.trees.get(github.commits.get(github.ref!.sha)!.treeSha)!.delete("broken.md");

  const events: V4SyncProgressPatch[] = [];
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "plaintext" });
  await assert.rejects(
    () => new V4SyncSession({
      github,
      vault: target,
      index: targetIndex,
      config: config(),
      conflictPolicy: "copy",
      abortChangePercent: 0,
      onProgress: event => events.push(structuredClone(event)),
    }).sync({ operation: "forcePull", allowThresholdOverride: false }),
    /Missing V4 remote object/iu,
  );
  assert.equal(events.at(-1)?.phase, "downloading");
  assert.equal(events.at(-1)?.currentPath, "broken.md");
  assert.equal(events.at(-1)?.currentDirection, "pull");
  assert.deepEqual(lastDirectional(events, "pull"), { completed: 0, total: 1 });
});

test("v4 session blocks operations over the configured modification percentage", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("a.md", { bytes: enc("a"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const events: V4SyncProgressPatch[] = [];
  const session = new V4SyncSession({
    github,
    vault,
    index,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 10,
    onProgress: event => events.push(structuredClone(event)),
  });
  await assert.rejects(() => session.sync({ operation: "forcePush", allowThresholdOverride: false }), /change guard blocked/i);
  assert.equal(events.at(-1)?.phase, "blocked");
  await session.sync({ operation: "forcePush", allowThresholdOverride: true });
});

test("v4 known-base scoped change guard measures only the in-scope population", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("in-scope.md", { bytes: enc("before"), mtime: 1 });
  for (let file = 0; file < 999; file++) vault.files.set(`excluded-${file}.md`, { bytes: enc(`excluded-${file}`), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  const commitBefore = github.ref!.sha;
  vault.files.set("in-scope.md", { bytes: enc("after"), mtime: 2 });

  await assert.rejects(
    () => new V4SyncSession({
      github,
      vault,
      index,
      config: config(),
      conflictPolicy: "copy",
      abortChangePercent: 10,
      includePath: path => path === "in-scope.md",
    }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "in-scope.md", mtime: 2 }] }),
    (error: unknown) => error instanceof V4ChangeGuardError && error.changePercent === 100 && error.thresholdPercent === 10,
  );
  assert.equal(github.ref!.sha, commitBefore);
  assert.equal(dec(github.files.get("in-scope.md")!), "before");
  assert.equal(dec(github.files.get("excluded-998.md")!), "excluded-998");
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
  const events: V4SyncProgressPatch[] = [];
  await new V4SyncSession({
    github,
    vault: source,
    index: sourceIndex,
    config: encryptedConfig,
    keyring: keys,
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => events.push(structuredClone(event)),
  }).sync({ operation: "forcePush", allowThresholdOverride: false });
  const packPaths = [...github.files.keys()].filter(path => path.includes("/packs/"));
  assert.equal(packPaths.length, 1);
  assert.equal([...github.files.keys()].some(path => path.includes("private-")), false);
  assert.deepEqual(lastDirectional(events, "push"), { completed: 64, total: 64 });
  assert.equal(Math.max(...events.map(event => event.push?.completed ?? 0)), 64);
  assert.equal(new Set(events.filter(event => event.phase === "uploading").map(event => event.currentPath).filter(Boolean)).size, 64);

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
  const initialEvents: V4SyncProgressPatch[] = [];
  const session = (events?: V4SyncProgressPatch[]) => new V4SyncSession({
    github,
    vault,
    index,
    config: encryptedConfig,
    keyring: keys,
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    onProgress: events ? event => events.push(structuredClone(event)) : undefined,
  });
  await session(initialEvents).sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.deepEqual(lastDirectional(initialEvents, "push"), { completed: 1, total: 1 });
  assert.equal(Math.max(...initialEvents.map(event => event.push?.completed ?? 0)), 1);
  const before = structuredClone(indexRecordByPath(index, "large.bin"));
  assert.equal(before.storage, "chunked");
  const file = vault.files.get("large.bin")!;
  vault.files.delete("large.bin");
  vault.files.set("renamed.bin", { ...file, mtime: 2 });

  const renameEvents: V4SyncProgressPatch[] = [];
  await session(renameEvents).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "large.bin", path: "renamed.bin", mtime: 2 }] });

  const after = indexRecordByPath(index, "renamed.bin");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
  assert.deepEqual(after.partPaths, before.partPaths);
  assert.equal(github.lastEntries.some(entry => entry.path.includes("/parts/")), false);
  assert.deepEqual(lastDirectional(renameEvents, "push"), { completed: 1, total: 1 });
  assert.equal(Math.max(...renameEvents.map(event => event.push?.completed ?? 0)), 1);
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
  const session = (events?: V4SyncProgressPatch[]) => new V4SyncSession({
    github,
    vault,
    index,
    config: encryptedConfig,
    keyring: keys,
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    onProgress: events ? event => events.push(structuredClone(event)) : undefined,
  });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const oldRecord = indexRecordByPath(index, "old.md");
  const oldRemotePath = oldRecord.remotePath;
  const file = vault.files.get("old.md")!;
  vault.files.delete("old.md");
  vault.files.set("new.md", { ...file, mtime: 2 });
  const events: V4SyncProgressPatch[] = [];
  await session(events).sync({
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
  assert.deepEqual(lastDirectional(events, "push"), { completed: 1, total: 1 });
  assert.equal(Math.max(...events.map(event => event.push?.completed ?? 0)), 1);
  assert.equal(events.some(event => event.phase === "uploading" && event.currentPath === "new.md"), false);
});

test("v4 deletion progress completes one logical push without a content upload", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("delete.md", { bytes: enc("delete me"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });
  vault.files.delete("delete.md");
  const events: V4SyncProgressPatch[] = [];

  await new V4SyncSession({
    github,
    vault,
    index,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    onProgress: event => events.push(structuredClone(event)),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "delete.md", mtime: 2 }] });

  assert.deepEqual(lastDirectional(events, "push"), { completed: 1, total: 1 });
  assert.equal(Math.max(...events.map(event => event.push?.completed ?? 0)), 1);
  assert.equal(events.some(event => event.phase === "uploading" && event.currentPath === "delete.md"), false);
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
  const events: V4SyncProgressPatch[] = [];
  const legacyEncryptedSession = new V4SyncSession({
    github,
    vault,
    index,
    config: desiredConfig,
    keyring: keys,
    conflictPolicy: "copy",
    abortChangePercent: 60,
    onProgress: event => events.push(structuredClone(event)),
  });
  github.commitMessages.length = 0;

  await assert.rejects(() => legacyEncryptedSession.sync({ operation: "forcePush", allowThresholdOverride: false }), /change guard blocked/iu);
  assert.equal(github.commitMessages.length, 0);
  events.length = 0;
  const result = await legacyEncryptedSession.sync({ operation: "forcePush", allowThresholdOverride: true });

  assert.equal(result.mode, "force-push");
  assert.equal(result.changedFiles, 2);
  assert.deepEqual(lastDirectional(events, "push"), { completed: 2, total: 2 });
  assert.equal(Math.max(...events.map(event => event.push?.completed ?? 0)), 2);
  const orphanCompletion = events.find(event => event.currentPath === orphanRecord.path && event.currentDirection === "push" && event.push?.completed === 1);
  assert.ok(orphanCompletion);
  assert.deepEqual(orphanCompletion.push, { completed: 1, total: 2 });
  assert.notEqual(orphanCompletion.phase, "uploading");
  assert.equal(events.some(event => event.phase === "uploading" && event.currentPath === orphanRecord.path), false);
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
