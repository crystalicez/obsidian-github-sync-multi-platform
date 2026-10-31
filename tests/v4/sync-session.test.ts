import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import type { V4JournalChange } from "../../src/lib/v4/history-journal";
import { createEmptyV4LocalIndex, type V4IndexFileRecord, type V4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index";
import { assertV4PathLayoutCompatible, V4ChangeGuardError, V4RemoteObjectMissingError, V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";
import { coalesceV4Changes, type V4QueuedChange } from "../../src/lib/v4/sync-coordinator";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, V4_ROOT, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { decryptV4Payload, deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
import { sha256Hex } from "../../src/lib/bytes";
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity";
import { buildV4RemoteMetadata, decodeV4RemoteHead } from "../../src/lib/v4/remote-index";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
import type { V4SyncProgressPatch } from "../../src/lib/v4/progress";
import { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, type V4ContentHandle, type V4ContentSource } from "../../src/lib/v4/content-source";
import { planV4PackGroups } from "../../src/lib/v4/pack-planner";
import { waitForCondition } from "../helpers/wait-for";
import { V4SourceChangedError } from "../../src/lib/v4/object-stream";
import { createV4StagingStore, type V4StageRef } from "../../src/lib/v4/staging-store";
import { V4LocalTargetChangedError } from "../../src/lib/v4/local-io";
import { createV4RecoveryStore, type V4RecoveryStore } from "../../src/lib/v4/recovery-store";

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
  private stageChunks = new Map<string, Uint8Array[]>();
  staging = createV4StagingStore({
    root: "private/stage",
    wholeBufferCeilingBytes: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES,
    backend: {
      boundedAppend: true,
      write: async (path, bytes) => { this.stageChunks.set(path, [new Uint8Array(bytes)]); },
      append: async (path, bytes) => { (this.stageChunks.get(path) ?? []).push(new Uint8Array(bytes)); },
      remove: async path => { this.stageChunks.delete(path); },
      openSource: async (path, size) => {
        const owner = this;
        return { size, async *chunks(chunkBytes: number) {
          for (const stored of owner.stageChunks.get(path) ?? []) {
            for (let offset = 0; offset < stored.byteLength; offset += chunkBytes) yield stored.subarray(offset, Math.min(stored.byteLength, offset + chunkBytes));
          }
        } };
      },
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
    },
    randomId: () => `stage${this.stageChunks.size + 1}`,
  });
  async listFiles() { this.listCount++; return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { this.operations.push(`read:${path}`); return new Uint8Array(this.files.get(path)!.bytes); }
  async openContentSource(handle: V4ContentHandle): Promise<V4ContentSource> {
    if (handle.kind !== "vault") throw new Error("MemoryVault only opens vault handles.");
    const file = this.files.get(handle.path);
    if (!file) throw new Error(`Missing local file: ${handle.path}`);
    return {
      size: file.bytes.byteLength,
      async *chunks(chunkBytes: number) {
        for (let offset = 0; offset < file.bytes.byteLength; offset += chunkBytes) {
          yield file.bytes.subarray(offset, Math.min(file.bytes.byteLength, offset + chunkBytes));
        }
      },
    };
  }
  async commitStage({ stage, path }: { stage: V4StageRef; path: string }) {
    const source = await this.staging.open(stage);
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of source.chunks(4 * 1024 * 1024)) { chunks.push(new Uint8Array(chunk)); total += chunk.byteLength; }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.operations.push(`commit-stage:${path}`);
    this.files.set(path, { bytes, mtime: stage.mtime });
    await this.staging.remove(stage);
  }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.operations.push(`write:${path}`); this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() }); }
  async delete(path: string) { this.operations.push(`delete:${path}`); this.files.delete(path); }
  async trash(path: string) { this.operations.push(`trash:${path}`); this.files.delete(path); }
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
    return value ? { bytes: new Uint8Array(value), sha: computeV4GitBlobSha1(value) } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }; }
  async getTreeAt(treeSha: string) {
    this.treeReads.push(treeSha);
    const tree = this.trees.get(treeSha) ?? new Map();
    return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: computeV4GitBlobSha1(bytes), size: bytes.byteLength, url: "" })) };
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

test("v4 separate delete then same-path recreate publishes a readable object to stale peer", async () => {
  const github = new MemoryGitHub();
  const aVault = new MemoryVault();
  const aIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "device-a", mode: "plaintext" });
  const bVault = new MemoryVault();
  const bIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "device-b", mode: "plaintext" });
  const a = new V4SyncSession({ github, vault: aVault, index: aIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  const b = new V4SyncSession({ github, vault: bVault, index: bIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  aVault.files.set("Notes/reborn.md", { bytes: enc("generation-one\n"), mtime: 1 });
  await a.sync({ operation: "forcePush", allowThresholdOverride: false });
  await b.sync({ operation: "forcePull", allowThresholdOverride: false });
  const previousId = indexRecordByPath(aIndex, "Notes/reborn.md").fileId;
  aVault.files.delete("Notes/reborn.md");
  await a.sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "Notes/reborn.md", mtime: 2 }] });
  assert.equal(github.files.has("Notes/reborn.md"), false);
  aVault.files.set("Notes/reborn.md", { bytes: enc("generation-two\n"), mtime: 3 });
  await a.sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "Notes/reborn.md", mtime: 3 }] });
  const record = indexRecordByPath(aIndex, "Notes/reborn.md");
  assert.notEqual(record.fileId, previousId);
  assert.deepEqual(github.files.get("Notes/reborn.md"), enc("generation-two\n"), "latest git tree must actually contain recreated content");
  await b.sync({ operation: "normal", allowThresholdOverride: false });
  assert.deepEqual(bVault.files.get("Notes/reborn.md")?.bytes, enc("generation-two\n"));
  assert.equal(indexRecordByPath(bIndex, "Notes/reborn.md").fileId, record.fileId);
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
  assert.equal(target.operations.includes("trash:old.md"), true);
  assert.equal(target.operations.some(operation => operation === "delete:old.md"), false);
  assert.equal(forcePullEvents.some(event => (event.push?.completed ?? 0) > 0), false);
  assert.equal(forcePullEvents.some(event => event.currentDirection === "push"), false);
  assert.equal(forcePullEvents.some(event => (event.pull?.total ?? 0) > 0), true);
  assert.deepEqual(lastDirectional(forcePullEvents, "pull"), { completed: 3, total: 3 });
});

test("v4 normal pull routes remote deletion through local trash semantics", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "source", mode: "plaintext" });
  source.files.set("remote-delete.md", { bytes: enc("one"), mtime: 1 });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "plaintext" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePull", allowThresholdOverride: false });
  target.operations.length = 0;

  source.files.delete("remote-delete.md");
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: "remote-delete.md" }] });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(target.files.has("remote-delete.md"), false);
  assert.deepEqual(target.operations.filter(operation => /^(?:trash|delete):remote-delete\.md$/u.test(operation)), ["trash:remote-delete.md"]);
});

test("v4 normal pull routes rename cleanup through local trash semantics", async () => {
  const github = new MemoryGitHub();
  const source = new MemoryVault();
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "source", mode: "plaintext" });
  source.files.set("old-name.md", { bytes: enc("rename-me"), mtime: 1 });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "target", mode: "plaintext" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePull", allowThresholdOverride: false });
  target.operations.length = 0;

  // A staged native pull can preserve bytes yet acquire this device-specific mtime.
  target.files.get("old-name.md")!.mtime = 5_000;
  const original = source.files.get("old-name.md")!;
  source.files.delete("old-name.md");
  source.files.set("new-name.md", { ...original, mtime: 2 });
  await new V4SyncSession({ github, vault: source, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old-name.md", path: "new-name.md", mtime: 2 }] });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(target.files.has("old-name.md"), false);
  assert.equal(dec(target.files.get("new-name.md")!.bytes), "rename-me");
  assert.deepEqual(target.operations.filter(operation => /^(?:trash|delete):old-name\.md$/u.test(operation)), ["trash:old-name.md"]);
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
  assert.equal(vault.operations.some(operation => operation.startsWith("write:") || operation.startsWith("delete:") || operation.startsWith("trash:")), false);
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
  assert.equal(plaintextVault.operations.some(operation => operation.startsWith("write:") || operation.startsWith("delete:") || operation.startsWith("trash:")), false);
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

  await waitForCondition(() => promptPending, "ordinary pull conflict prompt");
  assert.equal(promptPending, true);
  const operationsBeforeDecision = [...fixture.localVault.operations];
  const eventsBeforeDecision = events.map(event => structuredClone(event));
  prompt.resolve({ action: "use-remote" });
  const result = await run;

  assert.deepEqual(operationsBeforeDecision.filter(operation => /^(?:write|delete|trash):/u.test(operation)), []);
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

  await waitForCondition(() => secondPromptPending, "second conflict prompt");
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
  const missingRecord = Object.values(sourceIndex.shards).flatMap(shard => Object.values(shard.records))
    .find(record => record.path === "broken.md");
  assert.ok(missingRecord, "source index must still reference the published blob");
  const expectedCommit = github.ref!.sha;
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
    (error: unknown) => {
      assert.ok(error instanceof V4RemoteObjectMissingError);
      assert.equal(error.remotePath, "broken.md");
      assert.equal(error.remoteCommitSha, expectedCommit);
      assert.equal(error.fileId, missingRecord.fileId);
      assert.equal(error.remoteVersion, missingRecord.remoteVersion);
      assert.equal(error.storage, "single");
      assert.match(error.message, /Missing V4 remote object.*broken\.md/iu);
      return true;
    },
  );
  assert.equal(target.files.size, 0, "failure must not write any unverified remote bytes");
  assert.equal(targetIndex.remoteCommitSha, undefined, "failure must not advance the local base SHA");
  assert.ok(github.readRefs.includes(expectedCommit), "missing read must be pinned to the published immutable commit");
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

  // Real Git commits use forty hexadecimal characters. Pin a valid immutable
  // test ref so this regression exercises the production cache gate.
  const syntheticSha = github.ref!.sha;
  const commitSha = "a".repeat(40);
  github.commits.set(commitSha, github.commits.get(syntheticSha)!);
  github.commits.delete(syntheticSha);
  github.ref!.sha = commitSha;
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

  const actualGetFileBytes = github.getFileBytes.bind(github);
  let packDownloads = 0;
  github.getFileBytes = async (path, ref) => {
    if (path === packPaths[0]) packDownloads++;
    return actualGetFileBytes(path, ref);
  };
  const target = new MemoryVault();
  const targetIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "b", mode: "encrypted" });
  await new V4SyncSession({ github, vault: target, index: targetIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(dec(target.files.get("Folder/private-42.md")!.bytes), "secret-42");
  assert.equal(packDownloads, 1, "shared encrypted pack must be downloaded once per immutable commit per Sync session");
  assert.equal(target.files.size, 64);
  // No cached ciphertext may survive into the next session.
  const secondTarget = new MemoryVault();
  const secondIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "c", mode: "encrypted" });
  await new V4SyncSession({ github, vault: secondTarget, index: secondIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(packDownloads, 2);
  assert.equal(dec(secondTarget.files.get("Folder/private-42.md")!.bytes), "secret-42");
  // A pack larger than the cache budget must not be retained, but all
  // authenticated per-file downloads still succeed without cache.
  const boundedTarget = new MemoryVault();
  const boundedIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted" });
  await new V4SyncSession({ github, vault: boundedTarget, index: boundedIndex, config: encryptedConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0, resourceLimits: { maxCacheBytes: 1 } }).sync({ operation: "forcePull", allowThresholdOverride: false });
  assert.equal(packDownloads, 66, "over-budget pack must be re-read instead of exceeding the cache limit");
  assert.equal(boundedTarget.files.size, 64);
  assert.equal(dec(boundedTarget.files.get("Folder/private-42.md")!.bytes), "secret-42");
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

test("D192/D193 Force Push refuses incomplete, mismatched and unsafe Git tree entries before moving the ref", async () => {
  for (const scenario of ["missing-completeness", "wrong-tree", "symlink", "duplicate", "unsafe-path"] as const) {
    const github = new MemoryGitHub()
    const vault = new MemoryVault()
    vault.files.set("existing.md", { bytes: enc("keep"), mtime: 1 })
    const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "writer", mode: "plaintext" })
    const session = () => new V4SyncSession({
      github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    })
    await session().sync({ operation: "forcePush", allowThresholdOverride: false })
    const previousCommit = github.ref!.sha
    const existingContent = new Uint8Array(vault.files.get("existing.md")!.bytes)
    vault.files.set("new.md", { bytes: enc("new local file"), mtime: 2 })
    const getTree = github.getTreeAt.bind(github)
    github.getTreeAt = async (sha: string) => {
      const response = await getTree(sha)
      if (scenario === "wrong-tree") return { ...response, sha: "other-tree" }
      if (scenario === "missing-completeness") {
        const { truncated: _ignored, ...withoutCompleteness } = response
        return withoutCompleteness as typeof response
      }
      const entries = [...response.tree]
      const pos = entries.findIndex(entry => entry.path === "existing.md")
      assert.notEqual(pos, -1)
      const node = entries[pos]!
      if (scenario === "symlink") entries[pos] = { ...node, mode: "120000" }
      if (scenario === "duplicate") entries.push({ ...node })
      if (scenario === "unsafe-path") entries[pos] = { ...node, path: "../outside.md" }
      return { ...response, tree: entries }
    }
    vault.operations.length = 0
    await assert.rejects(
      () => session().sync({ operation: "forcePush", allowThresholdOverride: false }),
      /GitHub tree.*(incomplete|mismatch|unsafe)/i,
      scenario,
    )
    assert.equal(github.ref?.sha, previousCommit, "Never publish from incomplete Git tree evidence")
    assert.deepEqual(vault.files.get("existing.md")?.bytes, existingContent)
    assert.ok(!vault.operations.some(operation => /^(write:|trash:|delete:|commit-stage:)/u.test(operation)))
  }
})

test("D192 plaintext external GitHub reconciliation cannot treat partial Git evidence as file deletion", async () => {
  for (const scenario of ["missing-blob", "missing-completeness", "wrong-tree"] as const) {
    const github = new MemoryGitHub()
    const vault = new MemoryVault()
    vault.files.set("tracked.md", { bytes: enc("local baseline"), mtime: 1 })
    const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "device-a", mode: "plaintext" })
    await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "forcePush", allowThresholdOverride: false })
    const pinnedIndex = structuredClone(index)
    const originalContents = new Uint8Array(vault.files.get("tracked.md")!.bytes)
    const originalCommit = github.ref!.sha
    const externalTree = new Map(github.trees.get(github.commits.get(originalCommit)!.treeSha)!)
    externalTree.set("tracked.md", enc("edited externally"))
    github.trees.set("tree-d192-external", externalTree)
    github.commits.set("commit-d192-external", {
      treeSha: "tree-d192-external", parents: [originalCommit], message: "Direct GitHub edit",
    })
    github.ref = { ref: "refs/heads/main", sha: "commit-d192-external", type: "commit" }
    github.files = new Map(externalTree)
    const originalReadFile = github.getFileBytes.bind(github)
    github.getFileBytes = async (path: string, ref?: string) =>
      scenario === "missing-blob" && path === "tracked.md" && ref === "commit-d192-external"
        ? null : originalReadFile(path, ref)
    const originalReadTree = github.getTreeAt.bind(github)
    github.getTreeAt = async (sha: string) => {
      const response = await originalReadTree(sha)
      if (sha !== "tree-d192-external") return response
      if (scenario === "wrong-tree") return { ...response, sha: "tree-forged" }
      if (scenario === "missing-completeness") {
        const { truncated: _ignored, ...withoutCompleteness } = response
        return withoutCompleteness as typeof response
      }
      return response
    }
    const commitCount = github.commits.size
    vault.operations.length = 0
    await assert.rejects(
      () => new V4SyncSession({
        github, vault, index: pinnedIndex, config: config(),
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false }),
      /external.*(incomplete|mismatch|missing)|GitHub.*(tree|blob).*unsafe/i,
      scenario,
    )
    assert.deepEqual(vault.files.get("tracked.md")?.bytes, originalContents, scenario)
    assert.deepEqual(vault.operations, [], "Never mutate vault after incomplete external Git evidence")
    assert.equal(github.ref?.sha, "commit-d192-external", "Never publish a remote change")
    assert.equal(github.commits.size, commitCount, "No new remote commit")
  }
})

test("D195 identical local and external GitHub edits must repair stale remote metadata instead of no-op", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  vault.files.set("shared.md", { bytes: enc("initial"), mtime: 1 })
  vault.files.set("untouched.md", { bytes: enc("unchanged"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "writer", mode: "plaintext" })
  const session = () => new V4SyncSession({
    github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  })
  await session().sync({ operation: "forcePush", allowThresholdOverride: false })
  const parent = github.ref!.sha
  const unchangedRecord = structuredClone(indexRecordByPath(index, "untouched.md"))
  const externalTree = new Map(github.trees.get(github.commits.get(parent)!.treeSha)!)
  externalTree.set("shared.md", enc("same edit"))
  github.trees.set("tree-d195-external", externalTree)
  github.commits.set("commit-d195-external", {
    treeSha: "tree-d195-external", parents: [parent], message: "Direct GitHub edit",
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d195-external", type: "commit" }
  github.files = new Map(externalTree)
  vault.files.set("shared.md", { bytes: enc("same edit"), mtime: 2 })
  vault.operations.length = 0
  const result = await session().sync({ operation: "normal", allowThresholdOverride: false })
  assert.notEqual(result.mode, "noop", "Remote index must be repaired even when both file contents match")
  assert.notEqual(github.ref?.sha, "commit-d195-external", "Publish one metadata repair commit")
  assert.equal(dec(vault.files.get("shared.md")!.bytes), "same edit")
  assert.ok(!vault.operations.some(operation => /^(write:|trash:|delete:|commit-stage:)/u.test(operation)),
    "Metadata repair must not mutate local files")
  assert.equal(indexRecordByPath(index, "shared.md").plaintextSha256, await sha256Hex(enc("same edit")))
  assert.deepEqual(indexRecordByPath(index, "untouched.md"), unchangedRecord,
    "Unchanged remote files must keep their version, hash and mtime")
  const repairedHead = JSON.parse(dec(github.files.get(V4_HEAD_PATH)!)) as V4RemoteHead
  const repairedJournal = JSON.parse(dec(github.files.get(`${V4_ROOT}/journals/${repairedHead.journalId}/000000.json`)!))
  assert.ok(repairedJournal.changes.some((change: { path: string; kind: string; after?: { plaintextSha256?: string } }) =>
    change.path === "shared.md" && change.kind === "modify"
    && change.after?.plaintextSha256 === indexRecordByPath(index, "shared.md").plaintextSha256),
  "History must record the external edit even if local bytes already match")

  const restored = new MemoryVault()
  const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
  await new V4SyncSession({
    github, vault: restored, index: restoredIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePull", allowThresholdOverride: false })
  assert.equal(dec(restored.files.get("shared.md")!.bytes), "same edit",
    "Fresh device must restore the edited content from the repaired Git metadata")

  const repairedCommit = github.ref!.sha
  const unchangedExternalTree = new Map(github.trees.get(github.commits.get(repairedCommit)!.treeSha)!)
  github.trees.set("tree-d195-no-content-change", unchangedExternalTree)
  github.commits.set("commit-d195-no-content-change", {
    treeSha: "tree-d195-no-content-change", parents: [repairedCommit], message: "GitHub message-only commit",
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d195-no-content-change", type: "commit" }
  github.files = new Map(unchangedExternalTree)
  const unchangedResult = await session().sync({ operation: "normal", allowThresholdOverride: false })
  assert.equal(unchangedResult.mode, "noop", "No metadata repair is needed for a message-only external commit")
  assert.equal(github.ref?.sha, "commit-d195-no-content-change", "Do not publish an unnecessary repair commit")
  assert.equal(index.remoteCommitSha, "commit-d195-no-content-change")
})

test("D195 matching local and external deletions still publish the remote metadata tombstone", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  vault.files.set("removed.md", { bytes: enc("was here"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "writer", mode: "plaintext" })
  const session = () => new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
  await session().sync({ operation: "forcePush", allowThresholdOverride: false })
  const base = github.ref!.sha
  const tree = new Map(github.trees.get(github.commits.get(base)!.treeSha)!)
  tree.delete("removed.md")
  github.trees.set("tree-d195-delete", tree)
  github.commits.set("commit-d195-delete", {
    treeSha: "tree-d195-delete", parents: [base], message: "Delete file on GitHub",
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d195-delete", type: "commit" }
  github.files = new Map(tree)
  vault.files.delete("removed.md")
  vault.operations.length = 0

  const result = await session().sync({ operation: "normal", allowThresholdOverride: false })
  assert.notEqual(result.mode, "noop")
  assert.notEqual(github.ref?.sha, "commit-d195-delete")
  assert.ok(!Object.values(index.shards).some(shard => Object.values(shard.records).some(record => record.path === "removed.md")))
  assert.ok(!vault.operations.some(op => /^(write:|trash:|delete:|commit-stage:)/u.test(op)))
  const head = JSON.parse(dec(github.files.get(V4_HEAD_PATH)!)) as V4RemoteHead
  const journal = JSON.parse(dec(github.files.get(`${V4_ROOT}/journals/${head.journalId}/000000.json`)!))
  assert.ok(journal.changes.some((change: { path: string; kind: string }) =>
    change.path === "removed.md" && change.kind === "delete"))
  const restored = new MemoryVault()
  const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
  await new V4SyncSession({
    github, vault: restored, index: restoredIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePull", allowThresholdOverride: false })
  assert.equal(restored.files.has("removed.md"), false)
})

test("D196 mixed GitHub edits and local Push/Pull preserve every external history entry", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  for (const path of ["matching.md", "remote.md", "removed.md", "local.md", "unchanged.md"]) {
    vault.files.set(path, { bytes: enc(`base:${path}`), mtime: 1 })
  }
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "writer", mode: "plaintext" })
  const makeSession = () => new V4SyncSession({
    github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  })
  await makeSession().sync({ operation: "forcePush", allowThresholdOverride: false })
  const parent = github.ref!.sha
  const unchangedRecord = structuredClone(indexRecordByPath(index, "unchanged.md"))
  const tree = new Map(github.trees.get(github.commits.get(parent)!.treeSha)!)
  tree.set("matching.md", enc("same content on both devices"))
  tree.set("remote.md", enc("GitHub edit"))
  tree.delete("removed.md")
  github.trees.set("tree-d196-mixed", tree)
  github.commits.set("commit-d196-mixed", {
    treeSha: "tree-d196-mixed", parents: [parent], message: "Direct GitHub mixed edit",
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d196-mixed", type: "commit" }
  github.files = new Map(tree)
  vault.files.set("matching.md", { bytes: enc("same content on both devices"), mtime: 2 })
  vault.files.set("local.md", { bytes: enc("local change"), mtime: 2 })
  vault.files.delete("removed.md")
  vault.operations.length = 0

  const result = await makeSession().sync({ operation: "normal", allowThresholdOverride: false })
  assert.equal(result.mode, "pull-push")
  assert.equal(dec(vault.files.get("remote.md")!.bytes), "GitHub edit")
  assert.equal(dec(github.files.get("local.md")!), "local change")
  assert.equal(dec(vault.files.get("matching.md")!.bytes), "same content on both devices")
  assert.equal(github.files.has("removed.md"), false)
  assert.deepEqual(indexRecordByPath(index, "unchanged.md"), unchangedRecord)
  const head = JSON.parse(dec(github.files.get(V4_HEAD_PATH)!)) as V4RemoteHead
  const journal = JSON.parse(dec(github.files.get(`${V4_ROOT}/journals/${head.journalId}/000000.json`)!)) as {
    changes: V4JournalChange[]
  }
  const changes = journal.changes
  assert.deepEqual(changes.map(change => [change.path, change.kind]).sort((a, b) => a[0]!.localeCompare(b[0]!)), [
    ["local.md", "modify"], ["matching.md", "modify"], ["remote.md", "modify"], ["removed.md", "delete"],
  ], "Every committed external edit and independent local push needs exactly one history entry")
  for (const [path, content] of [
    ["matching.md", "same content on both devices"], ["remote.md", "GitHub edit"], ["local.md", "local change"],
  ]) {
    const change = changes.find(item => item.path === path)!
    assert.equal(change.after?.plaintextSha256, await sha256Hex(enc(content)))
    assert.ok(change.before, `Missing historical base for ${path}`)
  }
  assert.equal(changes.find(change => change.path === "removed.md")?.after, undefined)
  assert.ok(changes.find(change => change.path === "removed.md")?.before)

  const restoredVault = new MemoryVault()
  const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new-device", mode: "plaintext" })
  await new V4SyncSession({
    github, vault: restoredVault, index: restoredIndex, config: config(),
    conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePull", allowThresholdOverride: false })
  assert.equal(dec(restoredVault.files.get("matching.md")!.bytes), "same content on both devices")
  assert.equal(dec(restoredVault.files.get("remote.md")!.bytes), "GitHub edit")
  assert.equal(dec(restoredVault.files.get("local.md")!.bytes), "local change")
  assert.equal(restoredVault.files.has("removed.md"), false)
})

test("D196 external edit resolved by local-wins conflict has one final history version", async () => {
  const github = new MemoryGitHub()
  const vault = new MemoryVault()
  vault.files.set("conflicted.md", { bytes: enc("base"), mtime: 1 })
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "writer", mode: "plaintext" })
  const session = () => new V4SyncSession({
    github, vault, index, config: config(), conflictPolicy: "newer", abortChangePercent: 0, now: () => 50,
  })
  await session().sync({ operation: "forcePush", allowThresholdOverride: false })
  const baseCommit = github.ref!.sha
  const externalTree = new Map(github.trees.get(github.commits.get(baseCommit)!.treeSha)!)
  externalTree.set("conflicted.md", enc("from GitHub"))
  github.trees.set("tree-d196-conflict", externalTree)
  github.commits.set("commit-d196-conflict", {
    treeSha: "tree-d196-conflict", parents: [baseCommit], message: "GitHub edit conflicts with local",
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d196-conflict", type: "commit" }
  github.files = new Map(externalTree)
  vault.files.set("conflicted.md", { bytes: enc("from local"), mtime: 100 })
  const result = await session().sync({ operation: "normal", allowThresholdOverride: false })
  assert.equal(result.mode, "push")
  assert.equal(dec(github.files.get("conflicted.md")!), "from local")
  const head = JSON.parse(dec(github.files.get(V4_HEAD_PATH)!)) as V4RemoteHead
  const journal = JSON.parse(dec(github.files.get(`${V4_ROOT}/journals/${head.journalId}/000000.json`)!)) as {
    changes: V4JournalChange[]
  }
  const entries = journal.changes.filter(change => change.path === "conflicted.md")
  assert.equal(entries.length, 1, "One logical file must have a single final journal version")
  assert.equal(entries[0]!.kind, "modify")
  assert.equal(entries[0]!.before?.plaintextSha256, await sha256Hex(enc("base")))
  assert.equal(entries[0]!.after?.plaintextSha256, await sha256Hex(enc("from local")))
  assert.equal(indexRecordByPath(index, "conflicted.md").plaintextSha256, await sha256Hex(enc("from local")))
})

test("D197 a first-time device detects a direct GitHub edit before trusting remote metadata", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const fixture = await unknownBaseFixture(mode, null)
    const { github, remoteConfig, keyring } = fixture
    const parent = github.ref!.sha
    const tree = new Map(github.trees.get(github.commits.get(parent)!.treeSha)!)
    tree.set("foreign.md", enc("added outside the plugin"))
    github.trees.set(`tree-d197-${mode}`, tree)
    github.commits.set(`commit-d197-${mode}`, {
      treeSha: `tree-d197-${mode}`, parents: [parent], message: github.commits.get(parent)!.message,
    })
    github.ref = { ref: "refs/heads/main", sha: `commit-d197-${mode}`, type: "commit" }
    github.files = new Map(tree)
    const firstIndex = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "first-time", mode,
      pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    })
    const firstVault = new MemoryVault()
    const session = new V4SyncSession({
      github, vault: firstVault, index: firstIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session.sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, `commit-d197-${mode}`)
      assert.equal(firstIndex.remoteCommitSha, undefined)
      assert.deepEqual(firstVault.operations, [])
    } else {
      const result = await session.sync({ operation: "normal", allowThresholdOverride: false })
      assert.notEqual(result.mode, "noop")
      assert.equal(dec(firstVault.files.get("foreign.md")!.bytes), "added outside the plugin")
      assert.equal(dec(firstVault.files.get("note.md")!.bytes), "remote-newer")
      assert.notEqual(github.ref?.sha, `commit-d197-${mode}`)
      const verifiedVault = new MemoryVault()
      const verifiedIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: verifiedVault, index: verifiedIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(verifiedVault.files.get("foreign.md")!.bytes), "added outside the plugin")
    }
  }
})

test("D197 a first-time device accepts an authentic multi-generation plugin tip", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, index: writerIndex, remoteConfig, keyring } = await unknownBaseFixture(mode, null)
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
    writerVault.files.set("second.md", { bytes: enc("added by plugin"), mtime: 30 })
    writerIndex.deviceId = "writer"
    const first = github.ref!.sha
    await new V4SyncSession({
      github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false })
    const latest = github.ref!.sha
    assert.notEqual(latest, first)
    const index = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "first-time", mode,
      pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    })
    const vault = new MemoryVault()
    await new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false })
    assert.equal(dec(vault.files.get("note.md")!.bytes), "remote-newer")
    assert.equal(dec(vault.files.get("second.md")!.bytes), "added by plugin")
    assert.equal(github.ref?.sha, latest, "First-time trusted Pull must not mutate the branch")
    assert.equal(index.remoteCommitSha, latest)
  }
})

test("D197 a missing parent HEAD is not enough to trust a forged generation-one encrypted tip", async () => {
  const { github, remoteConfig, keyring } = await unknownBaseFixture("encrypted", null)
  const initial = github.ref!.sha
  const initialTree = github.trees.get(github.commits.get(initial)!.treeSha)!
  const headless = new Map(initialTree)
  headless.delete(V4_HEAD_PATH)
  headless.set("foreign.md", enc("out-of-band"))
  github.trees.set("tree-d197-headless", headless)
  github.commits.set("commit-d197-headless", {
    treeSha: "tree-d197-headless", parents: [initial], message: "Remove V4 HEAD",
  })
  const forged = new Map(initialTree)
  forged.set("foreign.md", enc("out-of-band"))
  github.trees.set("tree-d197-forged-gen1", forged)
  github.commits.set("commit-d197-forged-gen1", {
    treeSha: "tree-d197-forged-gen1", parents: ["commit-d197-headless"],
    message: github.commits.get(initial)!.message,
  })
  github.ref = { ref: "refs/heads/main", sha: "commit-d197-forged-gen1", type: "commit" }
  github.files = new Map(forged)
  const index = createEmptyV4LocalIndex({
    repoId: "o/r#main", deviceId: "first-time", mode: "encrypted", pathLayout: "opaque-stable-v1",
  })
  const vault = new MemoryVault()
  await assert.rejects(
    () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false }),
    /External GitHub changes touched an encrypted V4 branch/u,
  )
  assert.equal(github.ref?.sha, "commit-d197-forged-gen1")
  assert.equal(index.remoteCommitSha, undefined)
  assert.deepEqual(vault.operations, [])
})

test("D197 first-time Restore accepts a generation-one V4 commit on an empty-repository bootstrap", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, remoteConfig, keyring } = await unknownBaseFixture(mode, null)
    const pluginSha = github.ref!.sha
    github.trees.set("tree-d197-bootstrap", new Map([
      [".obsidian-github-sync-v4/bootstrap", enc("obsidian-github-sync-v4\n")],
    ]))
    github.commits.set("commit-d197-bootstrap", {
      treeSha: "tree-d197-bootstrap", parents: [], message: "obsidian-sync-v4:bootstrap",
    })
    github.commits.get(pluginSha)!.parents = ["commit-d197-bootstrap"]
    const index = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "new-device", mode,
      pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    })
    const vault = new MemoryVault()
    await new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false })
    assert.equal(dec(vault.files.get("note.md")!.bytes), "remote-newer")
    assert.equal(index.remoteCommitSha, pluginSha)
    assert.equal(github.ref?.sha, pluginSha)
  }
})

test("D198 a plugin-shaped tip cannot hide an out-of-band immediate parent commit", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const fixture = await unknownBaseFixture(mode, "remote-newer")
    const { github, vault, index, remoteConfig, keyring } = fixture
    const baseline = github.ref!.sha
    const writerIndex = structuredClone(index)
    writerIndex.shards[Object.keys(writerIndex.shards)[0]!]!.hash =
      writerIndex.shardHashes[Object.keys(writerIndex.shards)[0]!]!
    writerIndex.deviceId = "writer"
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("plugin-written update"), mtime: 50 })
    await new V4SyncSession({
      github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false })
    const pluginTip = github.ref!.sha
    const pluginCommit = github.commits.get(pluginTip)!
    assert.equal(pluginCommit.parents[0], baseline)
    const externalTree = new Map(github.trees.get(github.commits.get(baseline)!.treeSha)!)
    externalTree.set("foreign.md", enc("direct GitHub edit between plugin commits"))
    github.trees.set(`tree-d198-external-${mode}`, externalTree)
    github.commits.set(`commit-d198-external-${mode}`, {
      treeSha: `tree-d198-external-${mode}`, parents: [baseline],
      message: mode === "encrypted" ? github.commits.get(baseline)!.message : "Edit on GitHub directly",
    })
    const tipTree = new Map(github.trees.get(pluginCommit.treeSha)!)
    tipTree.set("foreign.md", enc("direct GitHub edit between plugin commits"))
    github.trees.set(`tree-d198-tip-${mode}`, tipTree)
    pluginCommit.treeSha = `tree-d198-tip-${mode}`
    pluginCommit.parents = [`commit-d198-external-${mode}`]
    github.files = new Map(tipTree)
    vault.operations.length = 0

    const session = new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session.sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, pluginTip)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [], "Unknown encrypted ancestry must not mutate the local vault")
    } else {
      await session.sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get("foreign.md")!.bytes), "direct GitHub edit between plugin commits")
      assert.ok(vault.files.has("note.md"), "The existing note remains available under conflict policy")
      assert.equal(dec(github.files.get("foreign.md")!), "direct GitHub edit between plugin commits")
      const restored = new MemoryVault()
      const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: restored, index: restoredIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(restored.files.get("foreign.md")!.bytes), "direct GitHub edit between plugin commits")
    }
  }
})

test("D198 a stale device accepts two consecutive genuine plugin advances", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, index, remoteConfig, keyring } = await unknownBaseFixture(mode, null)
    const staleIndex = structuredClone(index)
    const writerIndex = structuredClone(index)
    const bucket = Object.keys(writerIndex.shards)[0]!
    writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
    for (const [i, content] of ["plugin generation 2", "plugin generation 3"].entries()) {
      writerVault.files.set("note.md", { bytes: enc(content), mtime: 50 + i * 50 })
      await new V4SyncSession({
        github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false })
    }
    const tip = github.ref!.sha
    const staleVault = new MemoryVault()
    await new V4SyncSession({
      github, vault: staleVault, index: staleIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false })
    assert.equal(dec(staleVault.files.get("note.md")!.bytes), "plugin generation 3")
    assert.equal(staleIndex.remoteCommitSha, tip)
    assert.equal(github.ref?.sha, tip, "No extra remote commit on a trusted Force Pull")
  }
})

test("D199 detects an external ancestor hidden three plugin commits behind the tip", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture(mode, "remote-newer")
    const baseline = github.ref!.sha
    const writerIndex = structuredClone(index)
    const bucket = Object.keys(writerIndex.shards)[0]!
    writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
    const writerVault = new MemoryVault()
    const pluginShas: string[] = []
    for (const [step, content] of ["generation two", "generation three", "generation four"].entries()) {
      writerVault.files.set("note.md", { bytes: enc(content), mtime: 50 + step * 50 })
      await new V4SyncSession({
        github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false })
      pluginShas.push(github.ref!.sha)
    }
    assert.equal(github.commits.get(pluginShas[0]!)!.parents[0], baseline)
    const foreignText = "direct GitHub content before generation two"
    const externalTree = new Map(github.trees.get(github.commits.get(baseline)!.treeSha)!)
    externalTree.set("foreign.md", enc(foreignText))
    github.trees.set(`tree-d199-external-${mode}`, externalTree)
    github.commits.set(`commit-d199-external-${mode}`, {
      treeSha: `tree-d199-external-${mode}`, parents: [baseline], message: "Edited directly in GitHub",
    })
    github.commits.get(pluginShas[0]!)!.parents = [`commit-d199-external-${mode}`]
    for (const sha of pluginShas) {
      const commit = github.commits.get(sha)!
      const tree = new Map(github.trees.get(commit.treeSha)!)
      tree.set("foreign.md", enc(foreignText))
      github.trees.set(`tree-d199-${mode}-${sha}`, tree)
      commit.treeSha = `tree-d199-${mode}-${sha}`
    }
    const tip = pluginShas[pluginShas.length - 1]!
    github.files = new Map(github.trees.get(github.commits.get(tip)!.treeSha)!)
    vault.operations.length = 0
    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(() => session().sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u)
      assert.equal(github.ref?.sha, tip)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [], "Encrypted Sync must not mutate the vault on a concealed ancestor")
    } else {
      await session().sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get("foreign.md")!.bytes), foreignText)
      assert.equal(dec(github.files.get("foreign.md")!), foreignText)
      const freshVault = new MemoryVault()
      const freshIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: freshVault, index: freshIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(freshVault.files.get("foreign.md")!.bytes), foreignText)
    }
  }
})

test("D200 encrypted first-time ancestry audit accepts 128, 129 and 257 valid generations", async () => {
  for (const count of [128, 129, 257]) {
    const { github, index: initialIndex, remoteConfig, keyring } = await unknownBaseFixture("encrypted", null)
    let previous = github.ref!.sha
    for (let generation = 2; generation <= count; generation++) {
      const head: V4RemoteHead = {
        formatVersion: V4_FORMAT_VERSION, mode: "encrypted", epoch: initialIndex.epoch,
        generation, journalId: `synthetic-${generation}`,
        shardHashes: { ...initialIndex.shardHashes }, updatedAt: generation, deviceId: "writer",
      }
      const files = await buildV4RemoteMetadata({
        config: remoteConfig, head, records: [], keyring, buckets: [],
      })
      const tree = new Map(github.trees.get(github.commits.get(previous)!.treeSha)!)
      tree.set(V4_HEAD_PATH, files.find(file => file.path === V4_HEAD_PATH)!.bytes)
      const treeSha = `tree-d199-history-${count}-${generation}`
      const sha = `commit-d199-history-${count}-${generation}`
      github.trees.set(treeSha, tree)
      github.commits.set(sha, { treeSha, parents: [previous], message: `obsidian-sync-v4:${head.journalId}` })
      previous = sha
    }
    github.ref = { ref: "refs/heads/main", sha: previous, type: "commit" }
    github.files = new Map(github.trees.get(github.commits.get(previous)!.treeSha)!)
    const index = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "first-time", mode: "encrypted", pathLayout: "opaque-stable-v1",
    })
    const vault = new MemoryVault()
    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    })
    await session().sync({ operation: "forcePull", allowThresholdOverride: false })
    assert.equal(dec(vault.files.get("note.md")!.bytes), "remote-newer")
    assert.equal(index.remoteCommitSha, previous)
    assert.equal(github.ref?.sha, previous, "Ancestry verification cannot move the remote branch")
  }
})

test("D200 detects an external commit beyond the former 128-generation limit", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, remoteConfig, keyring } = await unknownBaseFixture(mode, null)
    const baseSha = github.ref!.sha
    let previous = baseSha
    const generationCount = 140
    const pluginShas: string[] = []
    const baseHead = await decodeV4RemoteHead(github.files.get(V4_HEAD_PATH)!, remoteConfig, keyring)
    for (let generation = 2; generation <= generationCount; generation++) {
      const head: V4RemoteHead = {
        ...baseHead, generation, journalId: `deep-${generation}`, updatedAt: generation,
      }
      const files = await buildV4RemoteMetadata({ config: remoteConfig, head, records: [], keyring, buckets: [] })
      const tree = new Map(github.trees.get(github.commits.get(previous)!.treeSha)!)
      tree.set(V4_HEAD_PATH, files.find(file => file.path === V4_HEAD_PATH)!.bytes)
      const treeSha = `tree-d200-deep-${mode}-${generation}`
      const sha = `commit-d200-deep-${mode}-${generation}`
      github.trees.set(treeSha, tree)
      github.commits.set(sha, { treeSha, parents: [previous], message: `obsidian-sync-v4:${head.journalId}` })
      pluginShas.push(sha)
      previous = sha
    }
    const foreignText = "remote note added before all later plugin generations"
    const externalTree = new Map(github.trees.get(github.commits.get(baseSha)!.treeSha)!)
    externalTree.set("foreign.md", enc(foreignText))
    github.trees.set(`tree-d200-foreign-${mode}`, externalTree)
    github.commits.set(`commit-d200-foreign-${mode}`, {
      treeSha: `tree-d200-foreign-${mode}`, parents: [baseSha], message: "Direct GitHub edit",
    })
    github.commits.get(pluginShas[0]!)!.parents = [`commit-d200-foreign-${mode}`]
    for (const sha of pluginShas) {
      const commit = github.commits.get(sha)!
      const tree = new Map(github.trees.get(commit.treeSha)!)
      tree.set("foreign.md", enc(foreignText))
      github.trees.set(`tree-d200-with-foreign-${mode}-${sha}`, tree)
      commit.treeSha = `tree-d200-with-foreign-${mode}-${sha}`
    }
    github.ref = { ref: "refs/heads/main", sha: previous, type: "commit" }
    github.files = new Map(github.trees.get(github.commits.get(previous)!.treeSha)!)
    const index = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "new-device", mode,
      pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    })
    const vault = new MemoryVault()
    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session().sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, previous)
      assert.equal(index.remoteCommitSha, undefined)
      assert.deepEqual(vault.operations, [])
    } else {
      await session().sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get("foreign.md")!.bytes), foreignText)
      assert.equal(dec(github.files.get("foreign.md")!), foreignText)
      const restored = new MemoryVault()
      const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: restored, index: restoredIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(restored.files.get("foreign.md")!.bytes), foreignText)
    }
  }
})

test("D199 a single anchored plugin advance reads only the tip Git commit", async () => {
  const { github, index, remoteConfig } = await unknownBaseFixture("plaintext", null)
  const staleIndex = structuredClone(index)
  const writerIndex = structuredClone(index)
  const bucket = Object.keys(writerIndex.shards)[0]!
  writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
  const writerVault = new MemoryVault()
  writerVault.files.set("note.md", { bytes: enc("updated by writer"), mtime: 50 })
  await new V4SyncSession({
    github, vault: writerVault, index: writerIndex, config: remoteConfig,
    conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "normal", allowThresholdOverride: false })
  const tip = github.ref!.sha
  const commitReads: string[] = []
  const getCommit = github.getGitCommit.bind(github)
  github.getGitCommit = async (sha: string) => {
    commitReads.push(sha)
    return getCommit(sha)
  }
  const vault = new MemoryVault()
  await new V4SyncSession({
    github, vault, index: staleIndex, config: remoteConfig,
    conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePull", allowThresholdOverride: false })
  assert.equal(dec(vault.files.get("note.md")!.bytes), "updated by writer")
  assert.deepEqual(commitReads, [tip], "An anchored one-commit update must not traverse older Git commits")
})

test("D202 a first-time device detects a same-path blob edit hidden behind an unchanged V4 shard", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, index, remoteConfig, keyring } = await unknownBaseFixture(mode, null)
    const base = github.ref!.sha
    const writerIndex = structuredClone(index)
    const bucket = Object.keys(writerIndex.shards)[0]!
    writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
    writerVault.files.set("second.md", { bytes: enc("a legitimate addition"), mtime: 90 })
    await new V4SyncSession({
      github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false })
    const pluginTip = github.ref!.sha
    const tipCommit = github.commits.get(pluginTip)!
    assert.deepEqual(tipCommit.parents, [base])
    const baseHead = await decodeV4RemoteHead(github.trees.get(github.commits.get(base)!.treeSha)!.get(V4_HEAD_PATH)!, remoteConfig, keyring)
    const tipHead = await decodeV4RemoteHead(github.trees.get(tipCommit.treeSha)!.get(V4_HEAD_PATH)!, remoteConfig, keyring)
    const note = indexRecordByPath(writerIndex, "note.md")
    assert.equal(tipHead.shardHashes[note.pathId.slice(0, 2)], baseHead.shardHashes[note.pathId.slice(0, 2)])
    const tree = new Map(github.trees.get(tipCommit.treeSha)!)
    const original = tree.get(note.remotePath)!
    tree.set(note.remotePath, mode === "plaintext" ? enc("github-newer")
      : new Uint8Array(original.map((byte, i) => i === 0 ? byte ^ 1 : byte)))
    const treeSha = `tree-d202-first-${mode}`
    const commitSha = `commit-d202-first-${mode}`
    github.trees.set(treeSha, tree)
    github.commits.set(commitSha, { treeSha, parents: [base], message: tipCommit.message })
    github.ref = { ref: "refs/heads/main", sha: commitSha, type: "commit" }
    github.files = new Map(tree)
    const freshIndex = createEmptyV4LocalIndex({
      repoId: "o/r#main", deviceId: "fresh", mode,
      pathLayout: mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1",
    })
    const freshVault = new MemoryVault()
    const session = () => new V4SyncSession({
      github, vault: freshVault, index: freshIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session().sync({ operation: "forcePull", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, commitSha)
      assert.equal(freshIndex.remoteCommitSha, undefined)
      assert.deepEqual(freshVault.operations, [])
    } else {
      await session().sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(freshVault.files.get("note.md")!.bytes), "github-newer")
      assert.equal(dec(freshVault.files.get("second.md")!.bytes), "a legitimate addition")
    }
  }
})

test("D202 a plugin-shaped tip cannot silently replace an unchanged indexed Git blob", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture(mode, "remote-newer")
    const baseline = github.ref!.sha
    const bucket = Object.keys(index.shards)[0]!
    index.shards[bucket]!.hash = index.shardHashes[bucket]!
    const writerIndex = structuredClone(index)
    writerIndex.deviceId = "writer"
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
    writerVault.files.set("second.md", { bytes: enc("published by plugin"), mtime: 80 })
    await new V4SyncSession({
      github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false })
    const genuineTip = github.ref!.sha
    const genuineCommit = github.commits.get(genuineTip)!
    assert.deepEqual(genuineCommit.parents, [baseline])
    const indexedPath = indexRecordByPath(index, "note.md").remotePath
    const baselineBytes = github.trees.get(github.commits.get(baseline)!.treeSha)!.get(indexedPath)!
    const tipTree = new Map(github.trees.get(genuineCommit.treeSha)!)
    assert.deepEqual(tipTree.get(indexedPath), baselineBytes, "The real writer left the note unmodified")
    tipTree.set(indexedPath, mode === "plaintext"
      ? enc("github-newer")
      : new Uint8Array(baselineBytes.map((byte, i) => i === 0 ? byte ^ 1 : byte)))
    const treeSha = `tree-d202-replaced-${mode}`
    const tipSha = `commit-d202-replaced-${mode}`
    github.trees.set(treeSha, tipTree)
    github.commits.set(tipSha, { treeSha, parents: [baseline], message: genuineCommit.message })
    github.ref = { ref: "refs/heads/main", sha: tipSha, type: "commit" }
    github.files = new Map(tipTree)
    vault.operations.length = 0

    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring, conflictPolicy: "newer", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session().sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, tipSha)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [])
    } else {
      await session().sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get("note.md")!.bytes), "github-newer")
      assert.equal(dec(vault.files.get("second.md")!.bytes), "published by plugin")
      const restored = new MemoryVault()
      const freshIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "fresh", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: restored, index: freshIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(restored.files.get("note.md")!.bytes), "github-newer")
    }
  }
})

test("D202 a stale device checks its trusted base across two concealed plugin-shaped generations", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture(mode, "remote-newer")
    const baseline = github.ref!.sha
    const bucket = Object.keys(index.shards)[0]!
    index.shards[bucket]!.hash = index.shardHashes[bucket]!
    const writerIndex = structuredClone(index)
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
    const pluginCommits: string[] = []
    for (const [path, content] of [["second.md", "second plugin file"], ["third.md", "third plugin file"]] as const) {
      writerVault.files.set(path, { bytes: enc(content), mtime: 100 + pluginCommits.length })
      await new V4SyncSession({
        github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false })
      pluginCommits.push(github.ref!.sha)
    }
    assert.deepEqual(github.commits.get(pluginCommits[0]!)!.parents, [baseline])
    assert.deepEqual(github.commits.get(pluginCommits[1]!)!.parents, [pluginCommits[0]!])
    const physicalPath = indexRecordByPath(index, "note.md").remotePath
    const baselineBytes = github.trees.get(github.commits.get(baseline)!.treeSha)!.get(physicalPath)!
    const tamperedBytes = mode === "plaintext" ? enc("github-newer")
      : new Uint8Array(baselineBytes.map((byte, i) => i === 0 ? byte ^ 1 : byte))
    for (const [step, sha] of pluginCommits.entries()) {
      const commit = github.commits.get(sha)!
      const tree = new Map(github.trees.get(commit.treeSha)!)
      tree.set(physicalPath, tamperedBytes)
      const treeSha = `tree-d202-hidden-history-${mode}-${step}`
      github.trees.set(treeSha, tree)
      commit.treeSha = treeSha
    }
    const tip = pluginCommits[1]!
    github.files = new Map(github.trees.get(github.commits.get(tip)!.treeSha)!)
    assert.equal(computeV4GitBlobSha1(github.files.get(physicalPath)!),
      computeV4GitBlobSha1(github.trees.get(github.commits.get(pluginCommits[0]!)!.treeSha)!.get(physicalPath)!),
      "The latest parent and tip have the same forged blob; only the older trusted anchor reveals the edit")
    vault.operations.length = 0
    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "newer", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session().sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, tip)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [])
    } else {
      await session().sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get("note.md")!.bytes), "github-newer")
      assert.equal(dec(vault.files.get("second.md")!.bytes), "second plugin file")
      assert.equal(dec(vault.files.get("third.md")!.bytes), "third plugin file")
    }
  }
})

test("D201 a coherent V4 tip cannot hide an unindexed Git tree file", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture(mode, "remote-newer")
    const baseline = github.ref!.sha
    const writerIndex = structuredClone(index)
    const bucket = Object.keys(writerIndex.shards)[0]!
    writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
    const writerVault = new MemoryVault()
    writerVault.files.set("note.md", { bytes: enc("updated by real plugin"), mtime: 90 })
    await new V4SyncSession({
      github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false })
    const genuineTip = github.ref!.sha
    const genuineCommit = github.commits.get(genuineTip)!
    assert.deepEqual(genuineCommit.parents, [baseline])
    const forgedTree = new Map(github.trees.get(genuineCommit.treeSha)!)
    const unindexedPath = mode === "encrypted" ? "nested/unindexed.md" : "unindexed.md"
    forgedTree.set(unindexedPath, enc("written directly in GitHub"))
    const treeSha = `tree-d201-hidden-${mode}`
    const tipSha = `commit-d201-hidden-${mode}`
    github.trees.set(treeSha, forgedTree)
    github.commits.set(tipSha, {
      treeSha, parents: [baseline], message: genuineCommit.message,
    })
    github.ref = { ref: "refs/heads/main", sha: tipSha, type: "commit" }
    github.files = new Map(forgedTree)
    vault.operations.length = 0

    const session = () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session().sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.equal(github.ref?.sha, tipSha)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [])
    } else {
      await session().sync({ operation: "normal", allowThresholdOverride: false })
      assert.equal(dec(vault.files.get(unindexedPath)!.bytes), "written directly in GitHub")
      assert.equal(dec(github.files.get(unindexedPath)!), "written directly in GitHub")
      const restoredVault = new MemoryVault()
      const restoredIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "reader", mode: "plaintext" })
      await new V4SyncSession({
        github, vault: restoredVault, index: restoredIndex, config: remoteConfig,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "forcePull", allowThresholdOverride: false })
      assert.equal(dec(restoredVault.files.get(unindexedPath)!.bytes), "written directly in GitHub")
    }
    assert.equal(github.treeReads.filter(sha => sha === treeSha).length, 1, "A reconciled tip must not fetch the same tree twice")
  }
})

test("D201 encrypted Sync rejects a coherent tip missing an indexed opaque object", async () => {
  const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture("encrypted", "remote-newer")
  const baseline = github.ref!.sha
  const writerIndex = structuredClone(index)
  const bucket = Object.keys(writerIndex.shards)[0]!
  writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
  const writerVault = new MemoryVault()
  writerVault.files.set("note.md", { bytes: enc("remote-newer"), mtime: 20 })
  writerVault.files.set("second.md", { bytes: enc("published second note"), mtime: 80 })
  await new V4SyncSession({
    github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
    conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "normal", allowThresholdOverride: false })
  const published = github.ref!.sha
  assert.deepEqual(github.commits.get(published)!.parents, [baseline])
  const tipTree = new Map(github.trees.get(github.commits.get(published)!.treeSha)!)
  assert.ok(tipTree.delete(indexRecordByPath(writerIndex, "note.md").remotePath))
  const treeSha = "tree-d201-missing-encrypted"
  const tipSha = "commit-d201-missing-encrypted"
  github.trees.set(treeSha, tipTree)
  github.commits.set(tipSha, { treeSha, parents: [baseline], message: github.commits.get(published)!.message })
  github.ref = { ref: "refs/heads/main", sha: tipSha, type: "commit" }
  github.files = new Map(tipTree)
  vault.operations.length = 0

  await assert.rejects(
    () => new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false }),
    /External GitHub changes touched an encrypted V4 branch/u,
  )
  assert.equal(github.ref?.sha, tipSha)
  assert.equal(index.remoteCommitSha, baseline)
  assert.deepEqual(vault.operations, [])
})

test("D201 incomplete tip tree evidence refuses Sync before any mutation", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    for (const invalid of ["truncated", "mismatched", "unsafe"] as const) {
      const { github, vault, index, remoteConfig, keyring } = await unknownBaseFixture(mode, "remote-newer")
      const baseline = github.ref!.sha
      const writerIndex = structuredClone(index)
      const bucket = Object.keys(writerIndex.shards)[0]!
      writerIndex.shards[bucket]!.hash = writerIndex.shardHashes[bucket]!
      const writerVault = new MemoryVault()
      writerVault.files.set("note.md", { bytes: enc("plugin update"), mtime: 90 })
      await new V4SyncSession({
        github, vault: writerVault, index: writerIndex, config: remoteConfig, keyring,
        conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false })
      const tip = github.ref!.sha
      const tipTreeSha = github.commits.get(tip)!.treeSha
      const readTree = github.getTreeAt.bind(github)
      github.getTreeAt = async sha => {
        const tree = await readTree(sha)
        if (sha !== tipTreeSha) return tree
        if (invalid === "truncated") return { ...tree, truncated: true }
        if (invalid === "mismatched") return { ...tree, sha: "incorrect-tree-identity" }
        return {
          ...tree,
          tree: [...tree.tree, { path: "../unsafe.md", type: "blob" as const, mode: "100644", sha: "a".repeat(40) }],
        }
      }
      vault.operations.length = 0
      await assert.rejects(
        () => new V4SyncSession({
          github, vault, index, config: remoteConfig, keyring,
          conflictPolicy: "copy", abortChangePercent: 0,
        }).sync({ operation: "normal", allowThresholdOverride: false }),
        /GitHub tree is incomplete or mismatched|GitHub tree has an unsafe path/u,
      )
      assert.equal(github.ref?.sha, tip)
      assert.equal(index.remoteCommitSha, baseline)
      assert.deepEqual(vault.operations, [])
    }
  }
})

test("D194 a copied plugin commit message cannot hide out-of-band GitHub edits", async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    const fixture = await unknownBaseFixture(mode, "remote-newer")
    const { github, vault, index, remoteConfig, keyring } = fixture
    const base = github.ref!.sha
    const baseCommit = github.commits.get(base)!
    const tree = new Map(github.trees.get(baseCommit.treeSha)!)
    if (mode === "plaintext") tree.set("note.md", enc("external edit hidden by copied commit message"))
    else tree.set("foreign.md", enc("out-of-band change"))
    github.trees.set("tree-d194-forged", tree)
    github.commits.set("commit-d194-forged", {
      treeSha: "tree-d194-forged", parents: [base], message: baseCommit.message,
    })
    github.ref = { ref: "refs/heads/main", sha: "commit-d194-forged", type: "commit" }
    github.files = new Map(tree)
    vault.operations.length = 0
    const session = new V4SyncSession({
      github, vault, index, config: remoteConfig, keyring,
      conflictPolicy: "newer", abortChangePercent: 0,
    })
    if (mode === "encrypted") {
      await assert.rejects(
        () => session.sync({ operation: "normal", allowThresholdOverride: false }),
        /External GitHub changes touched an encrypted V4 branch/u,
      )
      assert.deepEqual(vault.operations, [], "Encrypted out-of-band change must not touch the vault")
      assert.equal(index.remoteCommitSha, base)
      assert.equal(github.ref?.sha, "commit-d194-forged", "Encrypted Sync must not publish over unrecognized history")
    } else {
      const result = await session.sync({ operation: "normal", allowThresholdOverride: false })
      assert.ok(result.mode === "pull" || result.mode === "pull-push")
      assert.equal(dec(vault.files.get("note.md")!.bytes), "external edit hidden by copied commit message")
      assert.equal(dec(github.files.get("note.md")!), "external edit hidden by copied commit message")
    }
  }
})

test("D193 external plaintext Sync rejects forged blob evidence and unsafe recursive entries before mutation", async () => {
  for (const scenario of [
    "wrong-blob-sha", "altered-bytes", "symlink", "duplicate", "unsafe-path",
  ] as const) {
    const github = new MemoryGitHub()
    const vault = new MemoryVault()
    vault.files.set("tracked.md", { bytes: enc("local baseline"), mtime: 1 })
    const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "device-a", mode: "plaintext" })
    await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "forcePush", allowThresholdOverride: false })
    const staleIndex = structuredClone(index)
    const initialBytes = new Uint8Array(vault.files.get("tracked.md")!.bytes)
    const initialCommit = github.ref!.sha
    const externalTree = new Map(github.trees.get(github.commits.get(initialCommit)!.treeSha)!)
    externalTree.set("tracked.md", enc("changed on GitHub"))
    github.trees.set("tree-d193", externalTree)
    github.commits.set("commit-d193", {
      treeSha: "tree-d193", parents: [initialCommit], message: "Direct GitHub edit",
    })
    github.ref = { ref: "refs/heads/main", sha: "commit-d193", type: "commit" }
    github.files = new Map(externalTree)

    const getTree = github.getTreeAt.bind(github)
    github.getTreeAt = async (sha: string) => {
      const tree = await getTree(sha)
      if (sha !== "tree-d193") return tree
      const entries = [...tree.tree]
      const pos = entries.findIndex(entry => entry.path === "tracked.md")
      assert.notEqual(pos, -1)
      const node = entries[pos]!
      if (scenario === "symlink") entries[pos] = { ...node, mode: "120000" }
      if (scenario === "unsafe-path") entries[pos] = { ...node, path: "../outside.md" }
      if (scenario === "duplicate") entries.push({ ...node })
      return { ...tree, tree: entries }
    }
    const getFile = github.getFileBytes.bind(github)
    github.getFileBytes = async (path: string, ref?: string) => {
      const file = await getFile(path, ref)
      if (path !== "tracked.md" || ref !== "commit-d193" || !file) return file
      if (scenario === "wrong-blob-sha") return { ...file, sha: "f".repeat(40) }
      if (scenario === "altered-bytes") return { ...file, bytes: enc("forged! on GitHub") }
      return file
    }
    const commitCount = github.commits.size
    vault.operations.length = 0
    await assert.rejects(() => new V4SyncSession({
      github, vault, index: staleIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "normal", allowThresholdOverride: false }),
    /GitHub|unsafe|invalid|mismatch|identity|duplicate/i, scenario)
    assert.deepEqual(vault.files.get("tracked.md")?.bytes, initialBytes, scenario)
    assert.ok(!vault.operations.some(op => /^(write:|trash:|delete:|commit-stage:)/u.test(op)), scenario)
    assert.equal(github.ref?.sha, "commit-d193", scenario)
    assert.equal(github.commits.size, commitCount, scenario)
  }
})

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
  const getTree = github.getTreeAt.bind(github);
  github.getTreeAt = async (sha: string) => {
    const tree = await getTree(sha);
    return sha === "tree-external"
      ? { ...tree, tree: tree.tree.map(node => node.path === "external.md" ? { ...node, mode: "100755" } : node) }
      : tree;
  };

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
  const head: V4RemoteHead = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 2, journalId: "j1", shardHashes, updatedAt: 2, deviceId: "other" };
  const tree = new Map<string, Uint8Array>([
    [V4_CONFIG_PATH, enc(JSON.stringify(config()))],
    [V4_HEAD_PATH, enc(JSON.stringify(head))],
    ...[...vault.files].map(([path, file]) => [path, file.bytes] as const),
  ]);
  const previousTree = new Map(tree);
  previousTree.set(V4_HEAD_PATH, enc(JSON.stringify({ ...head, generation: 1, journalId: "j0", updatedAt: 1 })));
  github.trees.set("tree-previous", previousTree);
  github.commits.set("commit-previous", { treeSha: "tree-previous", parents: [], message: "obsidian-sync-v4:j0" });
  github.trees.set("tree-noop", tree);
  github.commits.set("commit-noop", { treeSha: "tree-noop", parents: ["commit-previous"], message: "obsidian-sync-v4:j1" });
  github.ref = { ref: "refs/heads/main", sha: "commit-noop", type: "commit" };
  github.files = new Map(tree);

  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 }).sync({ operation: "normal", allowThresholdOverride: false });

  assert.equal(result.mode, "noop");
  assert.deepEqual(github.readPaths, [V4_CONFIG_PATH, V4_HEAD_PATH, V4_HEAD_PATH]);
  assert.deepEqual(github.readRefs, ["commit-noop", "commit-noop", "commit-previous"]);
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

test("v4 newer local conflict resolves from metadata without fetching the remote body", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"]);
  fixture.github.readPaths.length = 0;
  fixture.github.readRefs.length = 0;
  fixture.localVault.operations.length = 0;

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "newer",
    abortChangePercent: 0,
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

  assert.equal(result.mode, "push");
  assert.equal(fixture.github.readPaths.filter(path => path === "conflict.md").length, 0);
  assert.equal(dec(fixture.github.files.get("conflict.md")!), "local:conflict.md");
});

test("v4 keep-both conflict fetches the remote body only after exact totals are final", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"]);
  const timeline: Array<{ kind: "progress"; event: V4SyncProgressPatch } | { kind: "body-read" }> = [];
  const getFileBytes = fixture.github.getFileBytes.bind(fixture.github);
  fixture.github.getFileBytes = async (path, ref) => {
    if (path === "conflict.md") timeline.push({ kind: "body-read" });
    return getFileBytes(path, ref);
  };

  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    now: () => 100,
    onProgress: event => timeline.push({ kind: "progress", event: structuredClone(event) }),
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

  const exactIndex = timeline.findIndex(item => item.kind === "progress"
    && item.event.phase === "resolving-conflicts"
    && item.event.pull?.total === 1 && item.event.push?.total === 2);
  const bodyReadIndex = timeline.findIndex(item => item.kind === "body-read");
  assert.ok(exactIndex >= 0 && bodyReadIndex > exactIndex, `exact=${exactIndex}, body=${bodyReadIndex}`);
});

test("v4 merge fallback for a non-text conflict never reads the historical base body", async () => {
  const fixture = await divergedConflictFixture(["conflict.bin"]);
  fixture.github.readPaths.length = 0;
  fixture.github.readRefs.length = 0;

  await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "merge",
    abortChangePercent: 0,
    now: () => 100,
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.bin", mtime: 3 }] });

  const contentReads = fixture.github.readPaths
    .map((path, index) => ({ path, ref: fixture.github.readRefs[index] }))
    .filter(read => read.path === "conflict.bin");
  assert.equal(contentReads.length, 1, JSON.stringify(contentReads));
});

test("v4 merged conflict output does not trigger a second changed-path stat rescan", async () => {
  const fixture = await divergedConflictFixture(["A.md", "B.md"]);
  let statCalls = 0;
  const stat = fixture.localVault.stat.bind(fixture.localVault);
  fixture.localVault.stat = async path => { statCalls++; return stat(path); };

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "ask",
    abortChangePercent: 0,
    askConflict: async input => input.path === "A.md"
      ? { action: "merged", mergedBytes: enc("merged:A.md") }
      : { action: "use-local" },
  }).sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: ["A.md", "B.md"].map(path => ({ type: "modify" as const, path, mtime: 3 })),
  });

  assert.equal(result.pushedFiles, 2);
  assert.equal(statCalls, 6, `expected initial stat plus pre/post hash snapshot checks only, got ${statCalls}`);
  assert.equal(dec(fixture.localVault.files.get("A.md")!.bytes), "merged:A.md");
  assert.equal(dec(fixture.github.files.get("A.md")!), "merged:A.md");
});

test("v4 keep-both staged copy does not trigger a second changed-path stat rescan", async () => {
  const fixture = await divergedConflictFixture(["conflict.md"]);
  let statCalls = 0;
  const stat = fixture.localVault.stat.bind(fixture.localVault);
  fixture.localVault.stat = async path => { statCalls++; return stat(path); };

  const result = await new V4SyncSession({
    github: fixture.github,
    vault: fixture.localVault,
    index: fixture.localIndex,
    config: config(),
    conflictPolicy: "copy",
    abortChangePercent: 0,
    now: () => 100,
  }).sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "conflict.md", mtime: 3 }] });

  const copyPath = [...fixture.localVault.files.keys()].find(path => path.includes(".conflict-remote-"));
  assert.equal(statCalls, 4, `expected initial stat, pre/post hash checks, and final pull precondition only, got ${statCalls}`);
  assert.ok(copyPath);
  assert.equal(dec(fixture.localVault.files.get(copyPath!)!.bytes), "remote:conflict.md");
  assert.equal(dec(fixture.github.files.get(copyPath!)!), "remote:conflict.md");
  assert.equal(result.pushedFiles, 2);
});

test("v4 scan discards a changed hash snapshot and replans from fresh local metadata", async () => {
  class MutatingScanVault extends MemoryVault {
    reads = 0;
    override async read(path: string) {
      const result = await super.read(path);
      this.reads++;
      if (this.reads === 1) this.files.set(path, { bytes: enc("second"), mtime: 2 });
      return result;
    }
  }
  const github = new MemoryGitHub();
  const vault = new MutatingScanVault();
  vault.files.set("note.md", { bytes: enc("first"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });

  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  assert.equal(result.changedFiles, 1);
  assert.equal(vault.reads, 2);
  assert.equal(dec(github.files.get("note.md")!), "second");
  assert.equal(indexRecordByPath(index, "note.md").mtime, 2);
});


test("D11 direct staged Pull finalizes verified backup before reporting mutation complete", async () => {
  const events: string[] = [];
  const github = new MemoryGitHub();
  const vault = Object.assign(new MemoryVault(), {
    async commitStage() { events.push("commit"); },
    async finalizeStage() { events.push("finalize"); },
  });
  const index = createEmptyV4LocalIndex({repoId:"o/r#main",deviceId:"d11-direct",mode:"plaintext"});
  const session = new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });
  await (session as unknown as {
    applyPullBinding(binding: unknown, ownedStages: unknown[], localById: Map<string, unknown>, onCompleted: () => void): Promise<void>
  }).applyPullBinding({
    change: { kind:"modify", path:"fresh.md", fileId:"remote-f1" },
    stage: { stageId:"dummy-stage", hash:"a".repeat(64), mtime:1, size:DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES+1 },
    remoteCommitSha:"dummy-head",
  }, [], new Map(), () => events.push("completed"));
  assert.deepEqual(events, ["commit","finalize","completed"]);
});

test("v4 medium REST-safe chunked push uses bounded source instead of whole-buffer vault read", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const payload = new Uint8Array(DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES + 1);
  payload[0] = 7;
  payload[payload.length - 1] = 9;
  vault.files.set("medium.bin", { bytes: payload, mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "local", mode: "plaintext" });

  const result = await new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  assert.equal(result.pushedFiles, 1);
  assert.equal(indexRecordByPath(index, "medium.bin").storage, "chunked");
  assert.equal(vault.operations.includes("read:medium.bin"), false);
});


test("D77 encrypted Sync forcePush automatically chunks near-8 MiB plaintext before ciphertext exceeds Git REST cap", async () => {
  const { V4_GITHUB_REST_SAFE_WRITER_BYTES } = await import("../../src/lib/v4/large-files");
  const { V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } = await import("../../src/lib/v4/crypto");
  const plaintextSize = V4_GITHUB_REST_SAFE_WRITER_BYTES - V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES + 1;
  const payload = new Uint8Array(plaintextSize).fill(0x6b);
  const vault = new MemoryVault();
  vault.files.set("boundary-private.bin", { bytes: payload, mtime: 1 });
  let uploadedBlobs = 0;
  class CappedGitHub extends MemoryGitHub {
    async createGitBlob(bytes: Uint8Array) {
      assert.ok(bytes.byteLength <= V4_GITHUB_REST_SAFE_WRITER_BYTES,
        "Sync must not upload a ciphertext blob over 8 MiB");
      uploadedBlobs++;
      return super.createGitBlob(bytes);
    }
  }
  const github = new CappedGitHub();
  const encryptedConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main",
    pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keyring = await deriveV4Keyring({
    passphrase: "D77", repoId: "o/r#main", salt: enc("salt"), iterations: 10,
  });
  const index = createEmptyV4LocalIndex({
    repoId: "o/r#main", deviceId: "d77", mode: "encrypted", pathLayout: "opaque-stable-v1",
  });
  const result = await new V4SyncSession({
    github, vault, index, config: encryptedConfig, keyring,
    conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(result.pushedFiles, 1);
  assert.equal(indexRecordByPath(index, "boundary-private.bin").storage, "chunked");
  assert.ok(uploadedBlobs >= 2);
  assert.ok(vault.operations.filter(operation => operation === "read:boundary-private.bin").length <= 1,
    "initial scan may hash via one whole-file read; the subsequent chunked upload must stream");
});

test("v4 pack session uploads the current bounded group before opening the next group", async () => {
  const MiB = 1024 * 1024;
  const fileBytes = 512 * 1024;
  const fileCount = 64;
  const vault = new MemoryVault();
  for (let index = 0; index < fileCount; index++) {
    const bytes = new Uint8Array(fileBytes);
    bytes.fill(index & 0xff);
    vault.files.set(`Folder/file-${index}.bin`, { bytes, mtime: 1 });
  }
  const readsAtBlob: number[] = [];
  class TrackingGitHub extends MemoryGitHub {
    async createGitBlob(bytes: Uint8Array) {
      readsAtBlob.push(vault.operations.filter(operation => operation.startsWith("read:")).length);
      return super.createGitBlob(bytes);
    }
  }
  const github = new TrackingGitHub();
  const encryptedConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keyring = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const candidates = [...vault.files].map(([path, file], fileIndex) => ({ fileId: `planned-${fileIndex}`, path, size: file.bytes.byteLength }));
  const expectedGroups = planV4PackGroups(candidates, {
    maxPlaintextBytes: 32 * MiB,
    maxResidentBytes: 18 * MiB,
    maxTransportTransientBytes: 24 * MiB,
  });
  assert.ok(expectedGroups.length > 1);

  await new V4SyncSession({
    github, vault, index, config: encryptedConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
    resourceLimits: { maxResidentBytes: 18 * MiB, maxTransportTransientBytes: 24 * MiB },
  }).sync({ operation: "forcePush", allowThresholdOverride: false });

  assert.ok(readsAtBlob.length >= expectedGroups.length);
  assert.equal(readsAtBlob[0], fileCount + expectedGroups[0].length);
  assert.ok(readsAtBlob[0] < fileCount * 2, "the next pack group was opened before the first pack blob upload");
  assert.equal([...github.files.keys()].filter(path => path.includes("/packs/")).length, expectedGroups.length);
});


test("v4 changed pack member aborts before the first pack blob candidate or ref publication", async () => {
  class MutatingPackVault extends MemoryVault {
    private readonly reads = new Map<string, number>();
    async read(path: string) {
      const count = (this.reads.get(path) ?? 0) + 1;
      this.reads.set(path, count);
      this.operations.push(`read:${path}`);
      const file = this.files.get(path)!;
      const bytes = new Uint8Array(file.bytes);
      if (path === "Folder/file-0.bin" && count >= 2) bytes[0] ^= 0xff;
      return bytes;
    }
  }
  const vault = new MutatingPackVault();
  for (let index = 0; index < 64; index++) {
    const bytes = new Uint8Array(32);
    bytes.fill(index);
    vault.files.set(`Folder/file-${index}.bin`, { bytes, mtime: 1 });
  }
  const github = new MemoryGitHub();
  const encryptedConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const keyring = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });

  await assert.rejects(new V4SyncSession({
    github, vault, index, config: encryptedConfig, keyring, conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePush", allowThresholdOverride: false }), error => error instanceof V4SourceChangedError);

  assert.equal(github.blobs.size, 0);
  assert.equal(github.commits.size, 0);
  assert.equal(github.ref, null);
});


test("v4 pull preserves a local user edit that appears while remote bytes are in flight", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("note.md", { bytes: enc("base"), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localIndex = structuredClone(remoteIndex);
  localIndex.deviceId = "local";
  const localVault = new MemoryVault();
  localVault.files.set("note.md", { bytes: enc("base"), mtime: 1 });

  remoteVault.files.set("note.md", { bytes: enc("remote-new"), mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "note.md", mtime: 2 }] });

  const originalGetFileBytes = github.getFileBytes.bind(github);
  let injected = false;
  github.getFileBytes = async (path: string, ref?: string) => {
    if (!injected && path === "note.md") {
      injected = true;
      localVault.files.set("note.md", { bytes: enc("user-edit"), mtime: 99 });
    }
    return originalGetFileBytes(path, ref);
  };

  await assert.rejects(
    new V4SyncSession({ github, vault: localVault, index: localIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false }),
    /local target changed/iu,
  );
  assert.equal(dec(localVault.files.get("note.md")!.bytes), "user-edit");
});


test("v4 pull rename preserves an old-path user edit that appears while remote bytes are in flight", async () => {
  const github = new MemoryGitHub();
  const remoteVault = new MemoryVault();
  remoteVault.files.set("old.md", { bytes: enc("base"), mtime: 1 });
  const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "remote", mode: "plaintext" });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "forcePush", allowThresholdOverride: false });

  const localIndex = structuredClone(remoteIndex);
  localIndex.deviceId = "local";
  const localVault = new MemoryVault();
  localVault.files.set("old.md", { bytes: enc("base"), mtime: 1 });

  const old = remoteVault.files.get("old.md")!;
  remoteVault.files.delete("old.md");
  remoteVault.files.set("new.md", { ...old, mtime: 2 });
  await new V4SyncSession({ github, vault: remoteVault, index: remoteIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
    .sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 2 }] });

  const originalGetFileBytes = github.getFileBytes.bind(github);
  let injected = false;
  github.getFileBytes = async (path: string, ref?: string) => {
    if (!injected && path === "new.md") {
      injected = true;
      localVault.files.set("old.md", { bytes: enc("user-edit"), mtime: 99 });
    }
    return originalGetFileBytes(path, ref);
  };

  await assert.rejects(
    new V4SyncSession({ github, vault: localVault, index: localIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0 })
      .sync({ operation: "normal", allowThresholdOverride: false }),
    /local target changed/iu,
  );
  assert.equal(dec(localVault.files.get("old.md")!.bytes), "user-edit");
});

test("D51 WAL pre-stages every Pull before a delete: later missing immutable object aborts all local mutations", async () => {
  const github = new MemoryGitHub();
  const sourceVault = new MemoryVault();
  const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "source-d51", mode: "plaintext" });
  const peerVault = new MemoryVault();
  const peerIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "peer-d51", mode: "plaintext" });
  const original = [
    ["A-remove.md", "original-deleted"],
    ["B-replace.md", "original-replaced"],
    ["C-last.md", "original-last"],
  ] as const;
  for (const [path, content] of original) sourceVault.files.set(path, { bytes: enc(content), mtime: 1 });
  const source = new V4SyncSession({
    github, vault: sourceVault, index: sourceIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  });
  await source.sync({ operation: "forcePush", allowThresholdOverride: false });
  await new V4SyncSession({
    github, vault: peerVault, index: peerIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
  }).sync({ operation: "forcePull", allowThresholdOverride: false });

  const beforeIndex = structuredClone(peerIndex);
  const beforeFiles = new Map([...peerVault.files].map(([path, file]) =>
    [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }] as const));
  peerVault.operations.length = 0;

  sourceVault.files.delete("A-remove.md");
  sourceVault.files.set("B-replace.md", { bytes: enc("new-good-body"), mtime: 2 });
  sourceVault.files.set("C-last.md", { bytes: enc("new-missing-body"), mtime: 2 });
  await source.sync({
    operation: "normal", allowThresholdOverride: false,
    changes: [
      { type: "delete", path: "A-remove.md", mtime: 2 },
      { type: "modify", path: "B-replace.md", mtime: 2 },
      { type: "modify", path: "C-last.md", mtime: 2 },
    ],
  });
  const publishedSha = github.ref!.sha;
  const missingRecord = indexRecordByPath(sourceIndex, "C-last.md");

  let injectedReads = 0;
  const readFile = github.getFileBytes.bind(github);
  github.getFileBytes = async (path, ref) => {
    if (path === "C-last.md" && ref === publishedSha) {
      injectedReads++;
      return null; // Immutable content remains published: simulate one read failure.
    }
    return readFile(path, ref);
  };

  const staging = peerVault.staging;
  let begun = 0;
  let finished = 0;
  let aborted = 0;
  let removed = 0;
  peerVault.staging = {
    ...staging,
    async beginStage(options) {
      begun++;
      const sink = await staging.beginStage(options);
      return {
        ...sink,
        async finish(result) { const stage = await sink.finish(result); finished++; return stage; },
        async abort() { aborted++; await sink.abort(); },
      };
    },
    async remove(ref) { removed++; await staging.remove(ref); },
  };
  let recoverySaves = 0;
  const recoveryStore = {
    async load() { return null; },
    async save(): Promise<never> {
      recoverySaves++;
      throw new Error("WAL save must not happen after a failed remote pre-stage");
    },
  };

  await assert.rejects(
    () => new V4SyncSession({
      github, vault: peerVault, index: peerIndex, config: config(),
      conflictPolicy: "copy", abortChangePercent: 0, recoveryStore,
    }).sync({ operation: "normal", allowThresholdOverride: false }),
    (error: unknown) => {
      assert.ok(error instanceof V4RemoteObjectMissingError);
      assert.equal(error.remoteCommitSha, publishedSha);
      assert.equal(error.remotePath, "C-last.md");
      assert.equal(error.fileId, missingRecord.fileId);
      return true;
    },
  );

  assert.equal(injectedReads, 1, "the failure must hit the last exact immutable object");
  assert.equal(begun, 2, "good middle body must be staged before final missing object");
  assert.equal(finished, 1, "good middle body must have a complete, verified stage");
  assert.equal(aborted, 1, "incomplete final stage must be aborted");
  assert.equal(removed, 1, "the completed earlier stage must also be cleaned");
  assert.equal(recoverySaves, 0, "a failed pre-stage must never persist a WAL mutation intent");
  assert.deepEqual(peerIndex, beforeIndex, "failed batch must not advance any local base metadata");
  assert.deepEqual(peerVault.files, beforeFiles, "failed batch must preserve all old local contents and mtimes");
  assert.equal(peerVault.operations.some(operation => /^(?:trash|write|commit-stage|delete):/u.test(operation)), false,
    "no local write or delete is allowed before every remote body is available");
  assert.equal(github.ref!.sha, publishedSha, "peer must not publish a new GitHub head on failed Pull");
  assert.equal(github.files.get("C-last.md")?.byteLength, enc("new-missing-body").byteLength,
    "published immutable content must still exist while its read is faulted");
});

for (const kind of ["delete", "modify"] as const) {
  test(`D52 WAL pins SHA-256 of local ${kind} target after remote staging even if size and mtime are unchanged`, async () => {
    const github = new MemoryGitHub();
    const sourceVault = new MemoryVault();
    sourceVault.files.set("A-target.md", { bytes: enc("abcde"), mtime: 1 });
    sourceVault.files.set("B-later.md", { bytes: enc("prior"), mtime: 1 });
    const sourceIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d52-source", mode: "plaintext" });
    const source = new V4SyncSession({
      github, vault: sourceVault, index: sourceIndex,
      config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    });
    await source.sync({ operation: "forcePush", allowThresholdOverride: false });

    const peerVault = new MemoryVault();
    const peerIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d52-peer", mode: "plaintext" });
    await new V4SyncSession({
      github, vault: peerVault, index: peerIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false });
    const beforeIndex = structuredClone(peerIndex);
    peerVault.operations.length = 0;

    if (kind === "delete") sourceVault.files.delete("A-target.md");
    else sourceVault.files.set("A-target.md", { bytes: enc("newer"), mtime: 2 });
    sourceVault.files.set("B-later.md", { bytes: enc("fresh"), mtime: 2 });
    await source.sync({
      operation: "normal", allowThresholdOverride: false,
      changes: [
        { type: kind, path: "A-target.md", mtime: 2 },
        { type: "modify", path: "B-later.md", mtime: 2 },
      ],
    });
    const publishedSha = github.ref!.sha;
    let sameStatEdit = 0;
    const getFileBytes = github.getFileBytes.bind(github);
    github.getFileBytes = async (path, ref) => {
      if (path === "B-later.md" && ref === publishedSha && sameStatEdit++ === 0) {
        const existing = peerVault.files.get("A-target.md");
        assert.ok(existing);
        peerVault.files.set("A-target.md", { bytes: enc("edcba"), mtime: existing.mtime });
      }
      return getFileBytes(path, ref);
    };
    const originalStaging = peerVault.staging;
    let stageBegins = 0;
    let stageFinishes = 0;
    let stageRemoves = 0;
    peerVault.staging = {
      ...originalStaging,
      async beginStage(options) {
        stageBegins++;
        const sink = await originalStaging.beginStage(options);
        return {
          ...sink,
          async finish(result) { const stage = await sink.finish(result); stageFinishes++; return stage; },
        };
      },
      async remove(stage) { stageRemoves++; await originalStaging.remove(stage); },
    };
    let walSaves = 0;
    const recoveryStore = {
      async load() { return null; },
      async save(): Promise<never> {
        walSaves++;
        throw new Error("WAL save must not happen if target content identity changed");
      },
    };

    await assert.rejects(
      () => new V4SyncSession({
        github, vault: peerVault, index: peerIndex, recoveryStore,
        config: config(), conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false }),
      (error: unknown) => error instanceof V4LocalTargetChangedError && error.path === "A-target.md",
    );

    assert.equal(sameStatEdit, 1, "the edit must happen after local scan on a later immutable object read");
    const expectedStages = kind === "delete" ? 1 : 2;
    assert.equal(stageBegins, expectedStages);
    assert.equal(stageFinishes, expectedStages);
    assert.equal(stageRemoves, expectedStages, "all verified stages must be discarded after changed target");
    assert.equal(walSaves, 0, "no mutation intent may be saved for stale local content");
    assert.equal(dec(peerVault.files.get("A-target.md")!.bytes), "edcba", "concurrent user bytes were overwritten");
    assert.equal(peerVault.files.get("A-target.md")!.mtime, 1, "same-mtime synthetic edit must remain unchanged");
    assert.equal(dec(peerVault.files.get("B-later.md")!.bytes), "prior", "other local target changed");
    assert.equal(peerVault.operations.some(operation => /^(?:trash|write|commit-stage|delete):/u.test(operation)), false,
      "no local mutation can occur when pre-WAL content hash is stale");
    assert.deepEqual(peerIndex, beforeIndex, "failed pull must preserve the previous local index");
    assert.equal(github.ref!.sha, publishedSha, "failed peer Pull must not advance GitHub head");
  });
}

for (const ambiguity of ["definite-before-write", "write-may-have-persisted"] as const) {
  test(`D53 WAL save error (${ambiguity}) preserves staged bytes and forbids local changes`, async () => {
    const github = new MemoryGitHub();
    const remoteVault = new MemoryVault();
    remoteVault.files.set("A-delete.md", { bytes: enc("old-A"), mtime: 1 });
    remoteVault.files.set("B-update.md", { bytes: enc("old-B"), mtime: 1 });
    const remoteIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d53-remote", mode: "plaintext" });
    const remote = new V4SyncSession({
      github, vault: remoteVault, index: remoteIndex,
      config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    });
    await remote.sync({ operation: "forcePush", allowThresholdOverride: false });
    const peerVault = new MemoryVault();
    const peerIndex = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d53-peer", mode: "plaintext" });
    await new V4SyncSession({
      github, vault: peerVault, index: peerIndex, config: config(), conflictPolicy: "copy", abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false });
    const beforeIndex = structuredClone(peerIndex);
    const beforeFiles = new Map([...peerVault.files].map(([path, file]) =>
      [path, { bytes: new Uint8Array(file.bytes), mtime: file.mtime }] as const));
    peerVault.operations.length = 0;

    remoteVault.files.delete("A-delete.md");
    remoteVault.files.set("B-update.md", { bytes: enc("new-B"), mtime: 2 });
    await remote.sync({
      operation: "normal", allowThresholdOverride: false,
      changes: [
        { type: "delete", path: "A-delete.md", mtime: 2 },
        { type: "modify", path: "B-update.md", mtime: 2 },
      ],
    });
    const publishedSha = github.ref!.sha;
    const realStaging = peerVault.staging;
    const finishedStages: V4StageRef[] = [];
    let stageRemoved = 0;
    peerVault.staging = {
      ...realStaging,
      async beginStage(options) {
        const sink = await realStaging.beginStage(options);
        return {
          ...sink,
          async finish(result) {
            const stage = await sink.finish(result);
            finishedStages.push(stage);
            return stage;
          },
        };
      },
      async remove(ref) { stageRemoved++; await realStaging.remove(ref); },
    };
    // Exercise the real two-slot WAL serializer and reloader, not just a
    // spy recording the input to save(). Simulate an error *after* durable
    // adapter.write as well as a failure before any write.
    const storedPaths = new Map<string, string>();
    const adapter: V4LocalIndexAdapter = {
      async read(path) {
        const value = storedPaths.get(path);
        if (value === undefined) throw new Error("Missing recovery slot");
        return value;
      },
      async write(path, value) { storedPaths.set(path, value); },
      async exists(path) { return storedPaths.has(path); },
      async mkdir() {},
    };
    const actualStore = createV4RecoveryStore({
      adapter, root: "d53-local-recovery", repoId: "o/r#main",
    });
    let attemptedSave = 0;
    const failure = new Error("injected-wal-io-unknown-outcome");
    const recoveryStore: V4RecoveryStore = {
      load: () => actualStore.load(),
      async save(input) {
        attemptedSave++;
        assert.equal(input.phase, "remote-verified");
        if (ambiguity === "write-may-have-persisted") await actualStore.save(input);
        throw failure;
      },
    };

    await assert.rejects(
      () => new V4SyncSession({
        github, vault: peerVault, index: peerIndex, recoveryStore,
        config: config(), conflictPolicy: "copy", abortChangePercent: 0,
      }).sync({ operation: "normal", allowThresholdOverride: false }),
      (error: unknown) => error === failure,
      "the original WAL I/O error must propagate unchanged",
    );

    assert.equal(attemptedSave, 1, "WAL must be attempted exactly once");
    assert.equal(finishedStages.length, 1, "required remote content must be verified and staged before WAL save");
    assert.equal(finishedStages[0]!.size, enc("new-B").byteLength);
    assert.equal(stageRemoved, 0,
      "an ambiguous WAL save result must not discard bytes that a persisted WAL could reference");
    const retainedSource = await realStaging.open(finishedStages[0]!);
    const retained: Uint8Array[] = [];
    for await (const chunk of retainedSource.chunks(1024)) retained.push(new Uint8Array(chunk));
    assert.deepEqual(retained, [enc("new-B")], "the staged content must remain readable for recovery");
    const reloaded = await actualStore.load();
    if (ambiguity === "write-may-have-persisted") {
      assert.equal(reloaded?.header.phase, "remote-verified",
        "a persisted WAL must be readable through the actual slot validation and integrity checks");
      assert.equal(reloaded.header.verifiedRemoteHead, publishedSha);
      assert.deepEqual(reloaded.payload?.mutations.map(mutation =>
        [mutation.kind, mutation.path]), [
        ["trash", "A-delete.md"],
        ["stage-write", "B-update.md"],
      ]);
      assert.equal(reloaded.payload?.mutations.find(m => m.kind === "stage-write")
        ?.stage.stageId, finishedStages[0]!.stageId);
      assert.equal(storedPaths.size, 1, "only the actual recovery slot should be present");
    } else {
      assert.equal(reloaded, null, "a definite pre-write failure must not fabricate a WAL");
      assert.equal(storedPaths.size, 0);
    }
    assert.deepEqual(peerVault.files, beforeFiles, "failed WAL save must preserve user bytes and mtimes");
    assert.deepEqual(peerIndex, beforeIndex, "failed WAL save must not advance local index/base");
    assert.equal(peerVault.operations.some(op => /^(?:trash|write|commit-stage|delete):/u.test(op)), false,
      "no local mutation may occur before WAL durability was confirmed");
    assert.equal(github.ref!.sha, publishedSha, "failed peer Pull must not publish a new commit");
    // Cleanup is deliberately NOT automatic in the production implementation:
    // an ambiguous save failure may have persisted a WAL referencing this stage.
  });
}
