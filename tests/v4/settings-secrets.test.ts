import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { modalButtons, Notice, resetModalTestState, TFile } from "obsidian";

import { DEFAULT_SETTINGS } from "../../src/setting";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence } from "../../src/lib/v4/secrets";
import { selectV4RuntimeConfig, V4PluginRuntime } from "../../src/lib/v4/runtime";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, V4_ROOT, type V4PathLayout, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { loadV4LocalIndex, type V4IndexFileRecord, type V4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index";
import type { V4SyncProgressSnapshot } from "../../src/lib/v4/progress";
import { waitForCondition } from "../helpers/wait-for";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

test("v4 settings defaults keep sensitive scopes and modification guard disabled", () => {
  assert.equal(DEFAULT_SETTINGS.syncObsidianConfig, false);
  assert.equal(DEFAULT_SETTINGS.syncBookmarks, false);
  assert.equal(DEFAULT_SETTINGS.syncPlugins, false);
  assert.equal(DEFAULT_SETTINGS.abortChangePercent, 0);
});

test("v4 encrypted-mode settings copy promises stable opaque paths without readable folders", async () => {
  const source = await readFile("src/setting.tsx", "utf8");
  assert.match(source, /hides directory names, filenames, extensions, and content behind stable opaque objects/iu);
  assert.doesNotMatch(source, /Folder paths remain readable/iu);
});

test("v4 secret migration stores legacy values and returns runtime-only secrets", () => {
  const stored = new Map<string, string>();
  const storage = {
    setSecret(id: string, value: string) { stored.set(id, value); },
    getSecret(id: string) { return stored.get(id) ?? null; },
  };
  let next = 0;
  const migrated = migrateV4Secrets({
    githubToken: "legacy-token",
    encryptionPassphrase: "legacy-pass",
    githubTokenSecretId: "",
    encryptionPassphraseSecretId: "",
  }, storage, prefix => `${prefix}-${++next}`);

  assert.equal(migrated.settings.githubToken, "legacy-token");
  assert.equal(migrated.settings.encryptionPassphrase, "legacy-pass");
  assert.equal(stored.get(migrated.settings.githubTokenSecretId), "legacy-token");
  assert.equal(stored.get(migrated.settings.encryptionPassphraseSecretId), "legacy-pass");
  assert.equal(migrated.migrated, true);

  const persisted = sanitizeV4SettingsForPersistence(migrated.settings);
  assert.equal("githubToken" in persisted, false);
  assert.equal("encryptionPassphrase" in persisted, false);
  assert.equal(persisted.githubTokenSecretId, migrated.settings.githubTokenSecretId);
});

test("v4 runtime selects explicit layouts and preserves encrypted KDF parameters for migration", () => {
  const legacy: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 321_000, salt: "bGVnYWN5LXNhbHQ" },
  };

  const selected = selectV4RuntimeConfig(legacy, "encrypted", "o/r#main");

  assert.equal(selected.pathLayout, "opaque-stable-v1");
  assert.deepEqual(selected.kdfParams, legacy.kdfParams);
  assert.equal(selectV4RuntimeConfig(null, "plaintext", "o/r#main").pathLayout, "plaintext-v1");
});

class RuntimeMemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();
  readPaths: string[] = [];
  updateFailuresRemaining = 0;
  updateFailureDelayMs = 0;
  onUpdateFailure?: () => void;
  blobFailuresRemaining = 0;
  blobAttempts = 0;
  createBlobOverride?: (bytes: Uint8Array, attempt: number) => Promise<string>;
  refReadBarrier?: Promise<void>;
  refReads = 0;
  returnStaleRefAfterNextUpdate = false;
  staleRefReads = 0;
  staleRef: { ref: string; sha: string; type: string } | null = null;
  async getFileBytes(path: string, ref?: string) { this.readPaths.push(path); const commit = ref ? this.commits.get(ref) : undefined; const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path); return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null; }
  async getGitRefOrNull() {
    this.refReads++;
    await this.refReadBarrier;
    if (this.staleRefReads > 0) {
      this.staleRefReads--;
      return this.staleRef;
    }
    return this.ref;
  }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }; }
  async getTreeAt(treeSha: string) { const tree = this.trees.get(treeSha) ?? new Map(); return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: `tree-blob-${index}`, size: bytes.byteLength, url: "" })) }; }
  async createGitBlob(bytes: Uint8Array) { const attempt = ++this.blobAttempts; if (this.createBlobOverride) return this.createBlobOverride(bytes, attempt); if (this.blobFailuresRemaining-- > 0) throw new Error("simulated upload failure"); const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) { const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined); for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!)); const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha; }
  async createGitCommit(message: string, treeSha: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha, parents, message }); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) {
    if (this.updateFailuresRemaining-- > 0) {
      this.onUpdateFailure?.();
      if (this.updateFailureDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.updateFailureDelayMs));
      throw new Error("stale ref");
    }
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref");
    const previous = this.ref;
    await this.createGitRef(sha);
    if (this.returnStaleRefAfterNextUpdate) {
      this.returnStaleRefAfterNextUpdate = false;
      this.staleRef = previous;
      this.staleRefReads = 1;
    }
  }
}

function plaintextRuntimeFixture(pathInput: string | string[] = "secret.md", github = new RuntimeMemoryGitHub(), deviceId = "device") {
  const paths = Array.isArray(pathInput) ? pathInput : [pathInput];
  const contents = new Map(paths.map(path => [path, new TextEncoder().encode("body")]));
  const vaultFiles = paths.map(path => {
    const file = new TFile(path, contents.get(path));
    file.stat = { size: 4, mtime: 1 };
    return file;
  });
  const vaultFile = vaultFiles[0];
  const indexFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const indexAdapter: V4LocalIndexAdapter & {
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    remove(path: string): Promise<void>;
  } = {
    async read(indexPath: string) { const value = indexFiles.get(indexPath); if (value === undefined) throw new Error(`missing ${indexPath}`); return value; },
    async write(indexPath: string, value: string) { indexFiles.set(indexPath, value); },
    async exists(indexPath: string) { return indexFiles.has(indexPath) || binaryFiles.has(indexPath); },
    async mkdir() {},
    async readBinary(path: string) { const value = binaryFiles.get(path); if (!value) throw new Error(`missing binary ${path}`); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); },
    async writeBinary(path: string, data: ArrayBuffer) { binaryFiles.set(path, new Uint8Array(data.slice(0))); },
    async remove(path: string) { binaryFiles.delete(path); },
  };
  const plugin = {
    app: { vault: {
      configDir: ".obsidian",
      adapter: indexAdapter,
      getFiles() { return vaultFiles; },
      getAbstractFileByPath(candidate: string) { return vaultFiles.find(file => file.path === candidate) ?? null; },
      async readBinary(file: TFile) { return contents.get(file.path)!.buffer; },
      async createBinary(path: string, buffer: ArrayBuffer) {
        const bytes = new Uint8Array(buffer.slice(0));
        contents.set(path, bytes);
        const file = new TFile(path, bytes);
        vaultFiles.push(file);
        return file;
      },
      async modifyBinary(file: TFile, buffer: ArrayBuffer) {
        const bytes = new Uint8Array(buffer.slice(0));
        contents.set(file.path, bytes);
        file.stat = { size: bytes.byteLength, mtime: Date.now() };
      },
      async delete(file: TFile) {
        contents.delete(file.path);
        const index = vaultFiles.indexOf(file);
        if (index >= 0) vaultFiles.splice(index, 1);
      },
      async createFolder() {},
    } },
    manifest: { id: "test" },
    githubClient: github,
    settings: { githubOwner: "o", githubRepo: "r", githubBranch: "main", vault: deviceId, encryptionMode: "plaintext", encryptionPassphrase: "", conflictPolicy: "copy", abortChangePercent: 0, ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false, syncEnabled: true, syncOnLocalChange: true },
    ignoredFiles: new Set<string>(), isWatchEnabled: true, isSyncInProgress: false,
    enableWatch() { this.isWatchEnabled = true; }, updateStatusBar() {}, addIgnoredFile() {}, removeIgnoredFile() {},
  };
  return { runtime: new V4PluginRuntime(plugin as never), plugin, github, contents, vaultFile, vaultFiles, indexFiles, indexAdapter };
}

function runtimeRemoteIndexRecords(github: RuntimeMemoryGitHub): V4IndexFileRecord[] {
  return [...github.files]
    .filter(([path]) => path.startsWith(`${V4_ROOT}/index/`) && path.endsWith(".json"))
    .flatMap(([, bytes]) => Object.values((JSON.parse(new TextDecoder().decode(bytes)) as { records: Record<string, V4IndexFileRecord> }).records));
}

function assertNoProgressPersistence(value: unknown): void {
  const forbidden = new Set(["phase", "currentPath", "failurePath", "pull", "push", "timings", "totalElapsedMs"]);
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      assert.equal(forbidden.has(key), false, `persisted runtime progress field: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("v4 runtime publishes loading, saving, and terminal lifecycle phases", async () => {
  const fixture = plaintextRuntimeFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  const unsubscribe = fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  await fixture.runtime.forcePush();
  unsubscribe();

  const actual = seen.flatMap(snapshot => snapshot.phase ? [snapshot.phase] : []);
  let cursor = -1;
  for (const phase of ["checking-remote", "loading-index", "scanning-local", "planning", "uploading", "committing", "saving-index"]) {
    cursor = actual.indexOf(phase as never, cursor + 1);
    assert.notEqual(cursor, -1, `missing ordered phase ${phase}: ${actual.join(", ")}`);
  }
  assert.equal(seen.at(-1)?.lifecycle, "success");
  assert.equal(fixture.runtime.progressSnapshot.operation, "forcePush");
  assert.equal(fixture.runtime.progressSnapshot.trigger, "forcePush");
  fixture.runtime.dispose();
});

test("v4 runtime keeps the exact upload failure phase and logical path", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.github.blobFailuresRemaining = 1;

  await fixture.runtime.forcePush();

  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "failed");
  assert.equal(fixture.runtime.progressSnapshot.failurePhase, "uploading");
  assert.equal(fixture.runtime.progressSnapshot.failurePath, "secret.md");
  assert.match(fixture.runtime.progressSnapshot.errorMessage ?? "", /upload failure/iu);
  fixture.runtime.dispose();
});

test("v4 runtime emits a warning when verbose logging is enabled and sync fails", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.plugin.settings.consoleLoggingEnabled = true;
  fixture.github.blobFailuresRemaining = 1;
  const messages: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = ((...args: unknown[]) => { messages.push(args); }) as typeof console.warn;
  try {
    await fixture.runtime.forcePush();
  } finally {
    console.warn = originalWarn;
    fixture.runtime.dispose();
  }

  assert.equal(messages.some(args => args[0] === "[Encrypted GitHub Sync]" && args[1] === "V4 sync failed"), true);
});

test("v4 normal sync retries without failing when immediate publication verification reads a stale branch head", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush();
  fixture.contents.set("secret.md", new TextEncoder().encode("changed"));
  fixture.vaultFile.stat = { size: 7, mtime: 2 };
  fixture.github.returnStaleRefAfterNextUpdate = true;

  await fixture.runtime.manualSync();

  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "no-change");
  assert.equal(fixture.runtime.progressSnapshot.attempt, 2);
  fixture.runtime.dispose();
});

test("v4 runtime terminal upload failure snapshot cannot mutate after delayed workers settle", async t => {
  const fixture = plaintextRuntimeFixture(["A.md", "B.md", "C.md", "D.md"]);
  t.after(() => fixture.runtime.dispose());
  const delayed = [deferred<string>(), deferred<string>(), deferred<string>()];
  fixture.github.createBlobOverride = async (_bytes, attempt) => {
    if (attempt === 1) throw new Error("simulated upload failure");
    if (attempt <= 4) return delayed[attempt - 2].promise;
    return `unexpected-blob-${attempt}`;
  };
  const seen: V4SyncProgressSnapshot[] = [];
  fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  const run = fixture.runtime.forcePush();
  await waitForCondition(() => fixture.github.blobAttempts >= 4, "four blob upload attempts");
  assert.equal(fixture.github.blobAttempts, 4, JSON.stringify(fixture.runtime.progressSnapshot));
  delayed.forEach((gate, index) => gate.resolve(`blob-${index + 2}`));
  await run;
  await new Promise<void>(resolve => setTimeout(resolve, 450));

  const terminalSnapshots = seen.filter(snapshot => snapshot.lifecycle === "failed");
  assert.ok(terminalSnapshots.length > 0);
  for (const snapshot of terminalSnapshots.slice(1)) assert.deepEqual(snapshot, terminalSnapshots[0]);
  assert.deepEqual(fixture.runtime.progressSnapshot, terminalSnapshots[0]);
  assert.equal(fixture.github.blobAttempts, 4);
});

test("v4 runtime publishes blocked with planned totals before the force override modal", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.plugin.settings.abortChangePercent = 1;
  resetModalTestState();

  const run = fixture.runtime.forcePush();
  await waitForCondition(() => modalButtons.length > 0, "force override modal");
  await waitForCondition(() => fixture.runtime.progressSnapshot.phase === "blocked", "blocked progress phase");

  assert.equal(fixture.runtime.progressSnapshot.phase, "blocked");
  assert.deepEqual(fixture.runtime.progressSnapshot.push, { completed: 0, total: 1 });
  const cancel = modalButtons.find(button => button.text === "Cancel");
  assert.ok(cancel);
  cancel.click();
  await run;
  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "failed");
  assert.equal(fixture.runtime.progressSnapshot.failurePhase, "blocked");
  fixture.runtime.dispose();
});

test("v4 runtime CAS retry resets attempt-local counters and aggregates checking remote", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush();
  fixture.contents.set("secret.md", new TextEncoder().encode("changed"));
  fixture.vaultFile.stat = { size: 7, mtime: 2 };
  fixture.github.updateFailuresRemaining = 1;
  const seen: V4SyncProgressSnapshot[] = [];
  const unsubscribe = fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  await fixture.runtime.manualSync();
  unsubscribe();

  const retry = seen.find(snapshot => snapshot.phase === "retrying");
  assert.ok(retry);
  assert.equal(retry.attempt, 2);
  assert.deepEqual(retry.pull, { completed: 0 });
  assert.deepEqual(retry.push, { completed: 0 });
  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(fixture.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2);
  fixture.runtime.dispose();
});

test("v4 runtime CAS retry reuses one keep-local-copy-remote conflict copy", async t => {
  const github = new RuntimeMemoryGitHub();
  const local = plaintextRuntimeFixture("conflict.md", github, "local");
  const remote = plaintextRuntimeFixture([], github, "remote");
  t.after(() => {
    local.runtime.dispose();
    remote.runtime.dispose();
  });
  await local.runtime.forcePush();
  await remote.runtime.forcePull();

  const remoteFile = remote.vaultFiles.find(file => file.path === "conflict.md");
  assert.ok(remoteFile);
  remote.contents.set("conflict.md", new TextEncoder().encode("remote change"));
  remoteFile.stat = { size: 13, mtime: 2 };
  await remote.runtime.manualSync();

  local.contents.set("conflict.md", new TextEncoder().encode("local change"));
  local.vaultFile.stat = { size: 12, mtime: 3 };
  github.updateFailuresRemaining = 1;
  github.updateFailureDelayMs = 10;

  await local.runtime.manualSync();

  const localCopyPaths = [...local.contents.keys()].filter(path => path.includes(".conflict-remote-"));
  const remoteCopyPaths = [...github.files.keys()].filter(path => path.includes(".conflict-remote-"));
  const index = await loadV4LocalIndex(local.indexAdapter, ".obsidian/plugins/test/github-sync-v4-index");
  const indexCopyPaths = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"))
    .map(record => record.path);

  assert.equal(local.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(localCopyPaths.length, 1, `local copies: ${localCopyPaths.join(", ")}`);
  assert.deepEqual(remoteCopyPaths, localCopyPaths, `remote copies: ${remoteCopyPaths.join(", ")}`);
  assert.deepEqual(indexCopyPaths, localCopyPaths, `index copies: ${indexCopyPaths.join(", ")}`);
  assert.deepEqual(local.runtime.progressSnapshot.pull, { completed: 1, total: 1 });
  assert.deepEqual(local.runtime.progressSnapshot.push, { completed: 2, total: 2 });
  assert.equal(local.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2);
});

test("v4 incremental CAS retry publishes an applied conflict copy when retry chooses use-local", async t => {
  const github = new RuntimeMemoryGitHub();
  const local = plaintextRuntimeFixture("conflict.md", github, "local");
  const remote = plaintextRuntimeFixture([], github, "remote");
  t.after(() => {
    local.runtime.dispose();
    remote.runtime.dispose();
  });
  await local.runtime.forcePush();
  await remote.runtime.forcePull();

  const remoteFile = remote.vaultFiles.find(file => file.path === "conflict.md");
  assert.ok(remoteFile);
  remote.contents.set("conflict.md", new TextEncoder().encode("remote change"));
  remoteFile.stat = { size: 13, mtime: 2 };
  await remote.runtime.manualSync();

  local.contents.set("conflict.md", new TextEncoder().encode("local change"));
  local.vaultFile.stat = { size: 12, mtime: 3 };
  github.updateFailuresRemaining = 1;
  github.onUpdateFailure = () => {
    local.plugin.settings.conflictPolicy = "newer";
    local.plugin.settings.ignorePathRegex = "\\.conflict-remote-";
  };
  local.runtime.enqueueModify("conflict.md", 3);

  await local.runtime.manualSync();

  const localCopyPaths = [...local.contents.keys()].filter(path => path.includes(".conflict-remote-"));
  const remoteCopyPaths = [...github.files.keys()].filter(path => path.includes(".conflict-remote-"));
  const index = await loadV4LocalIndex(local.indexAdapter, ".obsidian/plugins/test/github-sync-v4-index");
  const indexCopyRecords = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));
  const remoteCopyRecords = runtimeRemoteIndexRecords(github)
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));

  assert.equal(local.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(localCopyPaths.length, 1, `local copies: ${localCopyPaths.join(", ")}`);
  assert.deepEqual(remoteCopyPaths, localCopyPaths, `remote copies: ${remoteCopyPaths.join(", ")}`);
  assert.deepEqual(indexCopyRecords.map(record => record.path), localCopyPaths);
  assert.deepEqual(remoteCopyRecords.map(record => record.path), localCopyPaths);
  assert.deepEqual(remoteCopyRecords.map(record => record.fileId), indexCopyRecords.map(record => record.fileId));
  assert.deepEqual(local.runtime.progressSnapshot.pull, { completed: 0, total: 0 });
  assert.deepEqual(local.runtime.progressSnapshot.push, { completed: 2, total: 2 });
  assert.equal(local.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2);
});

test("v4 direct keep-local-copy keeps an out-of-scope generated copy local only", async t => {
  const github = new RuntimeMemoryGitHub();
  const local = plaintextRuntimeFixture("conflict.md", github, "local");
  const remote = plaintextRuntimeFixture([], github, "remote");
  t.after(() => {
    local.runtime.dispose();
    remote.runtime.dispose();
  });
  await local.runtime.forcePush();
  await remote.runtime.forcePull();

  const remoteFile = remote.vaultFiles.find(file => file.path === "conflict.md");
  assert.ok(remoteFile);
  remote.contents.set("conflict.md", new TextEncoder().encode("remote change"));
  remoteFile.stat = { size: 13, mtime: 2 };
  await remote.runtime.manualSync();

  local.contents.set("conflict.md", new TextEncoder().encode("local change"));
  local.vaultFile.stat = { size: 12, mtime: 3 };
  local.plugin.settings.ignorePathRegex = "\\.conflict-remote-";

  await local.runtime.manualSync();

  const localCopyPaths = [...local.contents.keys()].filter(path => path.includes(".conflict-remote-"));
  const remoteCopyPaths = [...github.files.keys()].filter(path => path.includes(".conflict-remote-"));
  const index = await loadV4LocalIndex(local.indexAdapter, ".obsidian/plugins/test/github-sync-v4-index");
  const indexCopyRecords = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));
  const remoteCopyRecords = runtimeRemoteIndexRecords(github)
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));

  assert.equal(local.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(localCopyPaths.length, 1, `local copies: ${localCopyPaths.join(", ")}`);
  assert.deepEqual(remoteCopyPaths, []);
  assert.deepEqual(remoteCopyRecords, []);
  assert.deepEqual(indexCopyRecords, []);
  assert.deepEqual(local.runtime.progressSnapshot.pull, { completed: 1, total: 1 });
  assert.deepEqual(local.runtime.progressSnapshot.push, { completed: 1, total: 1 });
});

test("v4 incremental CAS retry keeps an out-of-scope copy local when policy and settings change", async t => {
  const github = new RuntimeMemoryGitHub();
  const local = plaintextRuntimeFixture("conflict.md", github, "local");
  const remote = plaintextRuntimeFixture([], github, "remote");
  t.after(() => {
    local.runtime.dispose();
    remote.runtime.dispose();
  });
  await local.runtime.forcePush();
  await remote.runtime.forcePull();

  const remoteFile = remote.vaultFiles.find(file => file.path === "conflict.md");
  assert.ok(remoteFile);
  remote.contents.set("conflict.md", new TextEncoder().encode("remote change"));
  remoteFile.stat = { size: 13, mtime: 2 };
  await remote.runtime.manualSync();

  local.contents.set("conflict.md", new TextEncoder().encode("local change"));
  local.vaultFile.stat = { size: 12, mtime: 3 };
  local.plugin.settings.ignorePathRegex = "\\.conflict-remote-";
  github.updateFailuresRemaining = 1;
  github.onUpdateFailure = () => {
    local.plugin.settings.conflictPolicy = "newer";
    local.plugin.settings.ignorePathRegex = "";
  };
  local.runtime.enqueueModify("conflict.md", 3);

  await local.runtime.manualSync();

  const localCopyPaths = [...local.contents.keys()].filter(path => path.includes(".conflict-remote-"));
  const remoteCopyPaths = [...github.files.keys()].filter(path => path.includes(".conflict-remote-"));
  const index = await loadV4LocalIndex(local.indexAdapter, ".obsidian/plugins/test/github-sync-v4-index");
  const indexCopyRecords = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));
  const remoteCopyRecords = runtimeRemoteIndexRecords(github)
    .filter(record => !record.deleted && record.path.includes(".conflict-remote-"));

  assert.equal(local.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(localCopyPaths.length, 1, `local copies: ${localCopyPaths.join(", ")}`);
  assert.deepEqual(remoteCopyPaths, []);
  assert.deepEqual(remoteCopyRecords, []);
  assert.deepEqual(indexCopyRecords, []);
  assert.deepEqual(local.runtime.progressSnapshot.pull, { completed: 0, total: 0 });
  assert.deepEqual(local.runtime.progressSnapshot.push, { completed: 1, total: 1 });
  assert.equal(local.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2);
});

test("v4 runtime retains terminal timings until the next run begins", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush();
  const completed = structuredClone(fixture.runtime.progressSnapshot.timings);
  assert.equal(completed.length > 0, true);

  await Promise.resolve();
  assert.deepEqual(fixture.runtime.progressSnapshot.timings, completed);
  const nextRun = fixture.runtime.manualSync();
  assert.notDeepEqual(fixture.runtime.progressSnapshot.timings, completed);
  await nextRun;
  fixture.runtime.dispose();
});

test("v4 runtime reports every operation and automatic trigger without replacing terminal semantics", async () => {
  const fixture = plaintextRuntimeFixture();
  const cases = [
    [() => fixture.runtime.forcePush(), "forcePush", "forcePush", "success"],
    [() => fixture.runtime.manualSync(), "normal", "manual", "no-change"],
    [() => fixture.runtime.forcePull(), "forcePull", "forcePull", "no-change"],
    [() => fixture.runtime.startupSync(), "normal", "startup", "no-change"],
    [() => fixture.runtime.scheduledSync(), "normal", "scheduled", "no-change"],
  ] as const;

  for (const [run, operation, trigger, lifecycle] of cases) {
    await run();
    assert.equal(fixture.runtime.progressSnapshot.operation, operation);
    assert.equal(fixture.runtime.progressSnapshot.trigger, trigger);
    assert.equal(fixture.runtime.progressSnapshot.lifecycle, lifecycle);
  }
  fixture.runtime.dispose();
});

test("v4 runtime keeps the active snapshot when another user operation is rejected as busy", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush();
  let release!: () => void;
  fixture.github.refReadBarrier = new Promise<void>(resolve => { release = resolve; });

  const active = fixture.runtime.manualSync();
  const before = structuredClone(fixture.runtime.progressSnapshot);
  const repeated = await fixture.runtime.forcePull();

  assert.equal((repeated as { status: string }).status, "busy");
  assert.deepEqual(fixture.runtime.progressSnapshot, before);
  release();
  await active;
  fixture.runtime.dispose();
});

test("v4 runtime rejects a user operation synchronously re-entered by active progress", async () => {
  const fixture = plaintextRuntimeFixture();
  Notice.messages.length = 0;
  let vaultReads = 0;
  let activeVaultReads = 0;
  let maxConcurrentVaultReads = 0;
  const originalReadBinary = fixture.plugin.app.vault.readBinary.bind(fixture.plugin.app.vault);
  fixture.plugin.app.vault.readBinary = async file => {
    vaultReads++;
    activeVaultReads++;
    maxConcurrentVaultReads = Math.max(maxConcurrentVaultReads, activeVaultReads);
    try {
      await Promise.resolve();
      return await originalReadBinary(file);
    } finally {
      activeVaultReads--;
    }
  };
  let casWrites = 0;
  let activeCasWrites = 0;
  let maxConcurrentCasWrites = 0;
  const originalCreateGitRef = fixture.github.createGitRef.bind(fixture.github);
  fixture.github.createGitRef = async sha => {
    casWrites++;
    activeCasWrites++;
    maxConcurrentCasWrites = Math.max(maxConcurrentCasWrites, activeCasWrites);
    try {
      await Promise.resolve();
      await originalCreateGitRef(sha);
    } finally {
      activeCasWrites--;
    }
  };
  let reentered = false;
  let nested: Promise<unknown> | undefined;
  fixture.runtime.subscribeProgress(snapshot => {
    if (snapshot.lifecycle !== "active" || reentered) return;
    reentered = true;
    nested = fixture.runtime.manualSync();
  });

  const result = await fixture.runtime.forcePush();
  assert.ok(nested);
  const nestedResult = await nested;

  assert.equal((result as { status: string }).status, "completed");
  assert.equal((nestedResult as { status: string }).status, "busy");
  assert.deepEqual(Notice.messages, ["GitHub Sync: Sync already in progress"]);
  assert.equal(fixture.github.commits.size, 1);
  assert.equal(vaultReads, 1);
  assert.equal(maxConcurrentVaultReads, 1);
  assert.equal(casWrites, 1);
  assert.equal(maxConcurrentCasWrites, 1);
  fixture.runtime.dispose();
});

test("v4 runtime reveals a pending debounce after the active sync completes", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush();
  let release!: () => void;
  fixture.github.refReadBarrier = new Promise<void>(resolve => { release = resolve; });
  const active = fixture.runtime.manualSync();
  const activeSnapshot = structuredClone(fixture.runtime.progressSnapshot);

  fixture.runtime.enqueueModify("secret.md", 2);
  assert.deepEqual(fixture.runtime.progressSnapshot, activeSnapshot);
  release();
  await active;

  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "waiting");
  assert.equal(fixture.runtime.progressSnapshot.phase, "debouncing");
  fixture.runtime.dispose();
});

test("v4 runtime starts one waiting ledger per debounce cycle and disposes subscriptions safely", () => {
  const fixture = plaintextRuntimeFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  fixture.runtime.enqueueModify("secret.md", 2);
  const first = fixture.runtime.progressSnapshot;
  fixture.runtime.enqueueModify("secret.md", 3);
  const second = fixture.runtime.progressSnapshot;

  assert.equal(first.lifecycle, "waiting");
  assert.equal(first.phase, "debouncing");
  assert.equal(first.timings.find(item => item.phase === "debouncing")?.occurrences, 1);
  assert.equal(second.timings.find(item => item.phase === "debouncing")?.occurrences, 1);
  fixture.runtime.dispose();
  fixture.runtime.dispose();
  const countAfterDispose = seen.length;
  fixture.runtime.enqueueModify("secret.md", 4);
  assert.equal(seen.length, countAfterDispose);
});

test("v4 runtime progress subscribers are observational", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.runtime.subscribeProgress(() => { throw new Error("render failed"); });

  await fixture.runtime.forcePush();

  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "success");
  fixture.runtime.dispose();
});

test("v4 runtime hands a synchronously reentrant terminal subscriber to one waiting ledger", async () => {
  const fixture = plaintextRuntimeFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  let queued = false;
  fixture.runtime.subscribeProgress(snapshot => {
    seen.push(structuredClone(snapshot));
    if (snapshot.lifecycle === "success" && !queued) {
      queued = true;
      fixture.runtime.enqueueModify("secret.md", 2);
    }
  });

  await fixture.runtime.forcePush();

  const waiting = seen.filter(snapshot => snapshot.lifecycle === "waiting" && snapshot.phase === "debouncing");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].push.total, 1);
  assert.equal(fixture.runtime.pendingCount, 1);
  assert.equal(fixture.runtime.progressSnapshot.lifecycle, "waiting");
  assert.equal(fixture.runtime.progressSnapshot.timings.find(item => item.phase === "debouncing")?.occurrences, 1);
  fixture.runtime.dispose();
});

test("v4 runtime skips every sync entry point after disposal without I/O", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.runtime.dispose();
  const before = {
    refReads: fixture.github.refReads,
    readPaths: fixture.github.readPaths.length,
    indexFiles: fixture.indexFiles.size,
  };

  const results = await Promise.all([
    fixture.runtime.manualSync(),
    fixture.runtime.startupSync(),
    fixture.runtime.scheduledSync(),
    fixture.runtime.forcePush(),
    fixture.runtime.forcePull(),
  ]);

  assert.deepEqual(results.map(result => (result as { status: string }).status), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.deepEqual({
    refReads: fixture.github.refReads,
    readPaths: fixture.github.readPaths.length,
    indexFiles: fixture.indexFiles.size,
  }, before);
  assert.equal(fixture.plugin.isSyncInProgress, false);
});

test("v4 runtime rejects history I/O after disposal before touching GitHub", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.runtime.dispose();

  await assert.rejects(() => fixture.runtime.createHistoryService(), /disposed/iu);
  await assert.rejects(() => fixture.runtime.fileIdForPath("secret.md"), /disposed/iu);

  assert.equal(fixture.github.refReads, 0);
  assert.deepEqual(fixture.github.readPaths, []);
});

test("v4 guard confirmation counts each checking entry as a displayed attempt", async () => {
  const fixture = plaintextRuntimeFixture();
  fixture.plugin.settings.abortChangePercent = 1;
  resetModalTestState();
  const seen: V4SyncProgressSnapshot[] = [];
  fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  const run = fixture.runtime.forcePush();
  await waitForCondition(() => modalButtons.some(button => button.text === "Override and force push"), "force push override button");
  const confirm = modalButtons.find(button => button.text === "Override and force push");
  assert.ok(confirm);
  confirm.click();
  await run;

  const checks = seen.filter(snapshot => snapshot.phase === "checking-remote");
  assert.deepEqual([...new Set(checks.map(snapshot => snapshot.attempt))], [1, 2]);
  assert.equal(fixture.runtime.progressSnapshot.attempt, 2);
  assert.equal(fixture.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2);
  fixture.runtime.dispose();
});

test("v4 guard confirmation plus CAS retry keeps displayed attempts and occurrences aligned", async () => {
  const fixture = plaintextRuntimeFixture();
  await fixture.runtime.forcePush(true);
  fixture.contents.set("secret.md", new TextEncoder().encode("changed"));
  fixture.vaultFile.stat = { size: 7, mtime: 2 };
  fixture.plugin.settings.abortChangePercent = 1;
  fixture.github.updateFailuresRemaining = 1;
  resetModalTestState();
  const seen: V4SyncProgressSnapshot[] = [];
  fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));

  const run = fixture.runtime.forcePush();
  await waitForCondition(() => modalButtons.some(button => button.text === "Override and force push"), "force push override button");
  const confirm = modalButtons.find(button => button.text === "Override and force push");
  assert.ok(confirm);
  confirm.click();
  await run;

  assert.equal(seen.find(snapshot => snapshot.phase === "retrying")?.attempt, 3);
  assert.equal(fixture.runtime.progressSnapshot.attempt, 3);
  assert.equal(fixture.runtime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 3);
  fixture.runtime.dispose();
});

test("v4 runtime progress stays out of plugin data, local index files, and the retired main field", async () => {
  const fixture = plaintextRuntimeFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  fixture.runtime.subscribeProgress(snapshot => seen.push(structuredClone(snapshot)));
  await fixture.runtime.forcePush();
  assert.equal(seen.some(snapshot => snapshot.currentPath === "secret.md"), true);
  const recoveryProgressFields = new Set(["currentPath", "failurePath", "pull", "push", "timings", "totalElapsedMs"]);
  for (const [path, serialized] of fixture.indexFiles) {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    if (path.includes("github-sync-v4-recovery")) {
      for (const key of Object.keys(parsed)) assert.equal(recoveryProgressFields.has(key), false, `persisted recovery progress field: ${key}`);
      continue;
    }
    assertNoProgressPersistence(parsed);
  }

  const persisted = {
    settings: sanitizeV4SettingsForPersistence({ ...DEFAULT_SETTINGS, githubToken: "token", encryptionPassphrase: "passphrase" }),
  };
  assertNoProgressPersistence(persisted);

  const mainSource = await readFile("src/main.ts", "utf8");
  assert.doesNotMatch(mainSource, /\bsyncProgress\b/u);
  assert.match(mainSource, /v4Runtime\?\.progressSnapshot\s*\?\?\s*createIdleV4Progress/u);
  assert.match(mainSource, /async persistData\(\)[\s\S]*?saveData\(\{[\s\S]*?settings:\s*sanitizeV4SettingsForPersistence\(this\.settings\)/u);
  assert.match(mainSource, /startupSyncTimeout:\s*number\s*\|\s*null/u);
  assert.match(mainSource, /if \(this\.startupSyncTimeout !== null\) window\.clearTimeout\(this\.startupSyncTimeout\)/u);
  assert.match(mainSource, /onunload\(\)[\s\S]*?clearTimeout\(this\.startupSyncTimeout\)/u);
  assert.match(mainSource, /const runtime = this\.v4Runtime;?[\s\S]*?if \(runtime && !runtime\.isSyncing\)/u);
  fixture.runtime.dispose();
});

async function encryptedToPlaintextRuntimeFixture(savedPassphrase: string) {
  const github = new RuntimeMemoryGitHub();
  const repoId = "o/r#main";
  const remoteConfig: V4RemoteConfig = { formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } };
  const keys = await deriveV4Keyring({ passphrase: "correct", repoId, salt: new TextEncoder().encode("salt"), iterations: 10 });
  const prepared = await new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys }).prepare("note.md", new TextEncoder().encode("plaintext body"), "old-v", 1, "stable-file");
  const record = { path: "note.md", ...prepared.record };
  const bucket = record.pathId.slice(0, 2);
  const head: V4RemoteHead = { formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "old-v", shardHashes: { [bucket]: "old-hash" }, updatedAt: 1, deviceId: "old" };
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:old-v", files: [...prepared.files, ...await buildV4RemoteMetadata({ config: remoteConfig, head, records: [record], keyring: keys })] });
  const oldObjectPath = record.remotePath;
  const vaultFile = new TFile("note.md", new TextEncoder().encode("plaintext body"));
  vaultFile.stat = { size: 14, mtime: 1 };
  const indexFiles = new Map<string, string>();
  const plugin = {
    app: { vault: {
      configDir: ".obsidian",
      adapter: { async read(path: string) { return indexFiles.get(path)!; }, async write(path: string, value: string) { indexFiles.set(path, value); }, async exists(path: string) { return indexFiles.has(path); }, async mkdir() {} },
      getFiles() { return [vaultFile]; },
      getAbstractFileByPath(path: string) { return path === "note.md" ? vaultFile : null; },
      async readBinary() { return new TextEncoder().encode("plaintext body").buffer; },
    } },
    manifest: { id: "test" },
    githubClient: github,
    settings: { githubOwner: "o", githubRepo: "r", githubBranch: "main", vault: "device", encryptionMode: "plaintext", encryptionPassphrase: savedPassphrase, conflictPolicy: "copy", abortChangePercent: 0, ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false, syncEnabled: true, syncOnLocalChange: false },
    ignoredFiles: new Set<string>(), isWatchEnabled: false, isSyncInProgress: false,
    enableWatch() {}, updateStatusBar() {}, addIgnoredFile() {}, removeIgnoredFile() {},
  };
  return { runtime: new V4PluginRuntime(plugin as never), plugin, github, oldObjectPath };
}

test("v4 runtime authenticates encrypted remote before confirmed plaintext Force Push", async () => {
  const correct = await encryptedToPlaintextRuntimeFixture("correct");
  await correct.runtime.forcePush(true);
  assert.equal(correct.runtime.progressSnapshot.lifecycle, "success");
  assert.equal(JSON.parse(new TextDecoder().decode(correct.github.files.get(V4_CONFIG_PATH)!)).mode, "plaintext");
  assert.equal(new TextDecoder().decode(correct.github.files.get("note.md")!), "plaintext body");
  assert.equal(correct.github.files.has(correct.oldObjectPath), false);
  correct.runtime.dispose();

  const wrong = await encryptedToPlaintextRuntimeFixture("wrong");
  const before = { ref: wrong.github.ref!.sha, blobs: wrong.github.blobs.size, trees: wrong.github.trees.size, commits: wrong.github.commits.size };
  await wrong.runtime.forcePush(true);
  assert.equal(wrong.runtime.progressSnapshot.lifecycle, "failed");
  assert.match(wrong.runtime.progressSnapshot.errorMessage ?? "", /decrypt|passphrase|authentication/iu);
  assert.deepEqual({ ref: wrong.github.ref!.sha, blobs: wrong.github.blobs.size, trees: wrong.github.trees.size, commits: wrong.github.commits.size }, before);
  assert.equal(wrong.github.files.has(wrong.oldObjectPath), true);
  wrong.runtime.dispose();
});

test("v4 runtime recovers after a published commit whose second local shard save fails", async () => {
  const github = new RuntimeMemoryGitHub();
  const indexFiles = new Map<string, string>();
  const contents = new Map([["a.md", new TextEncoder().encode("old-a")], ["b.md", new TextEncoder().encode("old-b")]]);
  const files = [new TFile("a.md", contents.get("a.md")!), new TFile("b.md", contents.get("b.md")!)];
  files[0].stat = { size: 5, mtime: 1 };
  files[1].stat = { size: 5, mtime: 1 };
  let failShardWrite = 0;
  let shardWrites = 0;
  const plugin = {
    app: { vault: {
      configDir: ".obsidian",
      adapter: {
        async read(path: string) { const value = indexFiles.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; },
        async write(path: string, value: string) {
          if (path.includes("/shards/") && ++shardWrites === failShardWrite) throw new Error("simulated second shard persistence failure");
          indexFiles.set(path, value);
        },
        async exists(path: string) { return indexFiles.has(path); },
        async mkdir() {},
      },
      getFiles() { return files; },
      getAbstractFileByPath(path: string) { return files.find(file => file.path === path) ?? null; },
      async readBinary(file: TFile) { return contents.get(file.path)!.buffer; },
    } },
    manifest: { id: "test" },
    githubClient: github,
    settings: { githubOwner: "o", githubRepo: "r", githubBranch: "main", vault: "device", encryptionMode: "plaintext", encryptionPassphrase: "", conflictPolicy: "copy", abortChangePercent: 0, ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false, syncEnabled: true, syncOnLocalChange: false },
    ignoredFiles: new Set<string>(), isWatchEnabled: false, isSyncInProgress: false,
    enableWatch() {}, updateStatusBar() {}, addIgnoredFile() {}, removeIgnoredFile() {},
  };
  let runtime = new V4PluginRuntime(plugin as never);
  await runtime.forcePush(true);
  assert.equal(runtime.progressSnapshot.lifecycle, "success");
  const previousCommit = github.ref!.sha;
  contents.set("a.md", new TextEncoder().encode("new-a"));
  contents.set("b.md", new TextEncoder().encode("new-b"));
  files[0].stat = { size: 5, mtime: 2 };
  files[1].stat = { size: 5, mtime: 2 };
  shardWrites = 0;
  failShardWrite = 2;

  await runtime.manualSync();

  assert.equal(runtime.progressSnapshot.lifecycle, "failed");
  assert.match(runtime.progressSnapshot.errorMessage ?? "", /second shard persistence failure/iu);
  const publishedCommit = github.ref!.sha;
  assert.notEqual(publishedCommit, previousCommit);
  const commitsAfterPublish = github.commits.size;
  const persistedHeaderAfterFailure = JSON.parse(indexFiles.get(".obsidian/plugins/test/github-sync-v4-index/index.json")!);
  runtime.dispose();
  failShardWrite = 0;
  shardWrites = 0;
  github.readPaths.length = 0;
  runtime = new V4PluginRuntime(plugin as never);

  await runtime.manualSync();

  assert.equal(persistedHeaderAfterFailure.remoteCommitSha, previousCommit);
  assert.equal(runtime.progressSnapshot.lifecycle, "no-change");
  assert.equal(github.ref!.sha, publishedCommit);
  assert.equal(github.commits.size, commitsAfterPublish);
  assert.equal(github.readPaths.includes(V4_HEAD_PATH), true);
  assert.equal(github.readPaths.some(path => path.includes("/index/")), true);

  const recoveryHeaders = [...indexFiles.entries()]
    .filter(([path]) => path.includes("github-sync-v4-recovery") && path.endsWith(".json"))
    .map(([, value]) => JSON.parse(value) as { generation: number; phase: string });
  const latestRecovery = recoveryHeaders.sort((a, b) => b.generation - a.generation)[0];
  assert.equal(latestRecovery?.phase, "index-committed");

  const currentHeader = JSON.parse(indexFiles.get(".obsidian/plugins/test/github-sync-v4-index/index.json")!);
  const expectedIdentities = Object.fromEntries(Object.keys(currentHeader.shardHashes).flatMap(bucket => {
    const shard = JSON.parse(indexFiles.get(`.obsidian/plugins/test/github-sync-v4-index/shards/${bucket}.json`)!);
    return Object.values(shard.records as Record<string, { path: string; fileId: string }>).map(record => [record.path, record.fileId]);
  }));
  const missingBucket = Object.keys(currentHeader.shardHashes)[0];
  indexFiles.delete(`.obsidian/plugins/test/github-sync-v4-index/shards/${missingBucket}.json`);
  const commitsBeforeCacheRecovery = github.commits.size;
  runtime.dispose();
  github.readPaths.length = 0;
  runtime = new V4PluginRuntime(plugin as never);

  await runtime.manualSync();

  assert.equal(runtime.progressSnapshot.lifecycle, "no-change");
  assert.equal(github.commits.size, commitsBeforeCacheRecovery);
  assert.equal(github.readPaths.includes(V4_HEAD_PATH), true);
  assert.equal(github.readPaths.some(path => path.includes("/index/")), true);
  const repairedHeader = JSON.parse(indexFiles.get(".obsidian/plugins/test/github-sync-v4-index/index.json")!);
  const repairedIdentities = Object.fromEntries(Object.keys(repairedHeader.shardHashes).flatMap(bucket => {
    const shard = JSON.parse(indexFiles.get(`.obsidian/plugins/test/github-sync-v4-index/shards/${bucket}.json`)!);
    return Object.values(shard.records as Record<string, { path: string; fileId: string }>).map(record => [record.path, record.fileId]);
  }));
  assert.deepEqual(repairedIdentities, expectedIdentities);
  runtime.dispose();
});

function runtimeFixture(input: { remoteConfig: V4RemoteConfig; localIndexRepoId: string; localIndexPathLayout?: V4PathLayout; cachedShard?: boolean }) {
  const files = new Map<string, string>();
  const indexPath = ".obsidian/plugins/test/github-sync-v4-index/index.json";
  const shardHashes = input.cachedShard ? { aa: "legacy-hash" } : {};
  files.set(indexPath, JSON.stringify({
    formatVersion: V4_FORMAT_VERSION,
    repoId: input.localIndexRepoId,
    deviceId: "device",
    mode: "encrypted",
    ...(input.localIndexPathLayout ? { pathLayout: input.localIndexPathLayout } : {}),
    remoteCommitSha: "remote",
    epoch: 1,
    generation: 1,
    shardHashes,
  }));
  const legacyPathId = "aa".padEnd(64, "0");
  if (input.cachedShard) files.set(".obsidian/plugins/test/github-sync-v4-index/shards/aa.json", JSON.stringify({ bucket: "aa", hash: "legacy-hash", records: {
    [legacyPathId]: { path: "Legacy/note.md", pathId: legacyPathId, fileId: "legacy-file", plaintextSha256: "legacy-sha", size: 1, mtime: 1, remoteVersion: "legacy-v", remotePath: ".obsidian-github-sync-v4/data/Legacy/token.enc", storage: "single" },
  } }));
  let vaultLists = 0;
  const plugin = {
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          async read(path: string) { const value = files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; },
          async write(path: string, value: string) { files.set(path, value); },
          async exists(path: string) { return files.has(path); },
          async mkdir(_path: string) {},
        },
        getFiles() { vaultLists++; return []; },
        getAbstractFileByPath() { return null; },
      },
    },
    manifest: { id: "test" },
    githubClient: {
      async getGitRefOrNull() { return { ref: "refs/heads/main", sha: "remote", type: "commit" }; },
      async getFileBytes(path: string) {
        return path.endsWith("/config.json")
          ? { bytes: new TextEncoder().encode(JSON.stringify(input.remoteConfig)), sha: "config" }
          : null;
      },
    },
    settings: {
      githubOwner: "b",
      githubRepo: "r",
      githubBranch: "main",
      vault: "device",
      encryptionMode: "encrypted",
      encryptionPassphrase: "pass",
      conflictPolicy: "copy",
      abortChangePercent: 0,
      ignorePathRegex: "",
      syncObsidianConfig: false,
      syncBookmarks: false,
      syncPlugins: false,
      syncEnabled: true,
      syncOnLocalChange: false,
    },
    ignoredFiles: new Set<string>(),
    isWatchEnabled: false,
    isSyncInProgress: false,
    enableWatch() {},
    updateStatusBar() {},
    addIgnoredFile() {},
    removeIgnoredFile() {},
  };
  return { runtime: new V4PluginRuntime(plugin as never), plugin, get vaultLists() { return vaultLists; } };
}

test("v4 runtime reuses a local index only when repository, mode, and path layout all match", async () => {
  const remote: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "b/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const desired = selectV4RuntimeConfig(remote, "encrypted", remote.repoId);
  const loadIndex = async (fixture: ReturnType<typeof runtimeFixture>) => (
    fixture.runtime as unknown as { loadIndex(config: V4RemoteConfig): Promise<V4LocalIndex> }
  ).loadIndex(desired);

  for (const localIndexPathLayout of [undefined, "plaintext-v1"] as const) {
    const fixture = runtimeFixture({ remoteConfig: remote, localIndexRepoId: remote.repoId, localIndexPathLayout, cachedShard: true });
    const rebuilt = await loadIndex(fixture);
    assert.equal(rebuilt.pathLayout, "opaque-stable-v1");
    assert.equal(rebuilt.remoteCommitSha, undefined);
    assert.equal(rebuilt.epoch, 0);
    assert.equal(rebuilt.generation, 0);
    assert.deepEqual(rebuilt.shardHashes, {});
    assert.deepEqual(rebuilt.shards, {});
    fixture.runtime.dispose();
  }

  const matching = runtimeFixture({ remoteConfig: remote, localIndexRepoId: remote.repoId, localIndexPathLayout: "opaque-stable-v1", cachedShard: true });
  const reused = await loadIndex(matching);
  assert.equal(reused.remoteCommitSha, "remote");
  assert.equal(reused.generation, 1);
  assert.equal(Object.values(reused.shards.aa.records)[0].fileId, "legacy-file");
  matching.runtime.dispose();
});

test("v4 runtime rejects a remote repo identity mismatch before vault access or A-scoped index reuse", async () => {
  const remote: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "a/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const fixture = runtimeFixture({ remoteConfig: remote, localIndexRepoId: "a/r#main", localIndexPathLayout: "opaque-stable-v1" });

  assert.equal(selectV4RuntimeConfig(remote, "encrypted", "b/r#main").repoId, "b/r#main");
  await fixture.runtime.manualSync();

  assert.match(fixture.runtime.progressSnapshot.errorMessage ?? "", /repository identity mismatch/iu);
  assert.equal(fixture.vaultLists, 0);
  fixture.runtime.dispose();
});

test("v4 file-history lookup rejects legacy encrypted layout before returning not synced", async () => {
  const remote: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "b/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const fixture = runtimeFixture({ remoteConfig: remote, localIndexRepoId: "b/r#main" });

  await assert.rejects(() => fixture.runtime.fileIdForPath("note.md"), /Force Push/iu);
  assert.equal(fixture.vaultLists, 0);
  fixture.runtime.dispose();
});

test("v4 runtime keyring cache reuses one derived keyring until credential generation changes", async () => {
  const fixture = plaintextRuntimeFixture()
  const runtime = fixture.runtime as unknown as {
    keyringForConfig(config: V4RemoteConfig, passphrase: string, signal?: AbortSignal): Promise<unknown>
    credentialsChanged(): void
  }
  const config: V4RemoteConfig = {
    formatVersion: 4,
    mode: "encrypted",
    repoId: "o/r#main",
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  }
  const first = await runtime.keyringForConfig(config, "pass")
  const second = await runtime.keyringForConfig(config, "pass")
  assert.equal(first, second)
  runtime.credentialsChanged()
  const third = await runtime.keyringForConfig(config, "pass")
  assert.notEqual(first, third)
  fixture.runtime.dispose()
})

test("main settings save invalidates the runtime credential generation before future sync work", async () => {
  const source = await readFile("src/main.ts", "utf8")
  assert.match(source, /async saveSettings\(\)[\s\S]*?v4Runtime\?\.credentialsChanged\(\)/u)
})
