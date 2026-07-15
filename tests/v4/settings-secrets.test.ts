import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { TFile } from "obsidian";

import { DEFAULT_SETTINGS } from "../../src/setting";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence } from "../../src/lib/v4/secrets";
import { selectV4RuntimeConfig, V4PluginRuntime } from "../../src/lib/v4/runtime";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";

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
  async getFileBytes(path: string, ref?: string) { const commit = ref ? this.commits.get(ref) : undefined; const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path); return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null; }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) { const value = this.commits.get(sha)!; return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }; }
  async getTreeAt(treeSha: string) { const tree = this.trees.get(treeSha) ?? new Map(); return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: `tree-blob-${index}`, size: bytes.byteLength, url: "" })) }; }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) { const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined); for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!)); const sha = `tree-${this.trees.size + 1}`; this.trees.set(sha, tree); return sha; }
  async createGitCommit(message: string, treeSha: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha, parents, message }); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { if (expected && this.ref?.sha !== expected) throw new Error("stale ref"); await this.createGitRef(sha); }
}

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
    syncProgress: { status: "idle", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: 0 },
    enableWatch() {}, updateStatusBar() {}, addIgnoredFile() {}, removeIgnoredFile() {},
  };
  return { runtime: new V4PluginRuntime(plugin as never), plugin, github, oldObjectPath };
}

test("v4 runtime authenticates encrypted remote before confirmed plaintext Force Push", async () => {
  const correct = await encryptedToPlaintextRuntimeFixture("correct");
  await correct.runtime.forcePush(true);
  assert.equal(correct.plugin.syncProgress.status, "success");
  assert.equal(JSON.parse(new TextDecoder().decode(correct.github.files.get(V4_CONFIG_PATH)!)).mode, "plaintext");
  assert.equal(new TextDecoder().decode(correct.github.files.get("note.md")!), "plaintext body");
  assert.equal(correct.github.files.has(correct.oldObjectPath), false);
  correct.runtime.dispose();

  const wrong = await encryptedToPlaintextRuntimeFixture("wrong");
  const before = { ref: wrong.github.ref!.sha, blobs: wrong.github.blobs.size, trees: wrong.github.trees.size, commits: wrong.github.commits.size };
  await wrong.runtime.forcePush(true);
  assert.equal(wrong.plugin.syncProgress.status, "fail");
  assert.match(wrong.plugin.syncProgress.errorMessage ?? "", /decrypt|passphrase|authentication/iu);
  assert.deepEqual({ ref: wrong.github.ref!.sha, blobs: wrong.github.blobs.size, trees: wrong.github.trees.size, commits: wrong.github.commits.size }, before);
  assert.equal(wrong.github.files.has(wrong.oldObjectPath), true);
  wrong.runtime.dispose();
});

function runtimeFixture(input: { remoteConfig: V4RemoteConfig; localIndexRepoId: string; localIndexPathLayout?: "opaque-stable-v1" }) {
  const files = new Map<string, string>();
  const indexPath = ".obsidian/plugins/test/github-sync-v4-index/index.json";
  files.set(indexPath, JSON.stringify({
    formatVersion: V4_FORMAT_VERSION,
    repoId: input.localIndexRepoId,
    deviceId: "device",
    mode: "encrypted",
    ...(input.localIndexPathLayout ? { pathLayout: input.localIndexPathLayout } : {}),
    remoteCommitSha: "remote",
    epoch: 1,
    generation: 1,
    shardHashes: {},
  }));
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
    syncProgress: { status: "idle", pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0, lastSyncTime: 0 },
    enableWatch() {},
    updateStatusBar() {},
    addIgnoredFile() {},
    removeIgnoredFile() {},
  };
  return { runtime: new V4PluginRuntime(plugin as never), plugin, get vaultLists() { return vaultLists; } };
}

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

  assert.match(fixture.plugin.syncProgress.errorMessage ?? "", /repository identity mismatch/iu);
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
