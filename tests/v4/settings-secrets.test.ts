import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS } from "../../src/setting";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence } from "../../src/lib/v4/secrets";
import { selectV4RuntimeConfig, V4PluginRuntime } from "../../src/lib/v4/runtime";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";

test("v4 settings defaults keep sensitive scopes and modification guard disabled", () => {
  assert.equal(DEFAULT_SETTINGS.syncObsidianConfig, false);
  assert.equal(DEFAULT_SETTINGS.syncBookmarks, false);
  assert.equal(DEFAULT_SETTINGS.syncPlugins, false);
  assert.equal(DEFAULT_SETTINGS.abortChangePercent, 0);
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
