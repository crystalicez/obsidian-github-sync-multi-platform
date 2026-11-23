import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { assertPluginSettingsRuntimeSafe } from "../../src/lib/plugin-settings-validation";

const valid = { ...DEFAULT_SETTINGS, githubOwner: "safe-org", githubRepo: "repo.test", githubBranch: "feature/safe-test" };

test("settings validator preserves valid defaults and nested Git branch while refusing unsafe persistent fields", () => {
  assert.doesNotThrow(() => assertPluginSettingsRuntimeSafe(valid));
  const invalid: Array<{ patch: Record<string, unknown>; message: RegExp }> = [
    { patch: { githubOwner: "../wrong" }, message: /Invalid GitHub owner/iu },
    { patch: { githubBranch: "branch@{1}" }, message: /Invalid GitHub branch/iu },
    { patch: { githubRepo: "oops/path" }, message: /Invalid GitHub repository/iu },
    { patch: { ignorePathRegex: "[" }, message: /(?:Invalid|regex|regular expression)/iu },
    { patch: { encryptionMode: "unsupported" }, message: /encryptionMode is unsupported/iu },
    { patch: { newVaultKdfIterations: 1_200_001 }, message: /KDF|iterations/iu },
    { patch: { newVaultKdfIterations: 599_999 }, message: /KDF|iterations/iu },
    { patch: { newVaultKdfIterations: "600000" }, message: /KDF|iterations/iu },
    { patch: { newVaultKdfIterations: 600_000.5 }, message: /KDF|iterations/iu },
    { patch: { conflictPolicy: "erase-all" }, message: /conflictPolicy is unsupported/iu },
    { patch: { abortChangePercent: Number.NaN }, message: /abortChangePercent must be between/iu },
    { patch: { abortChangePercent: 101 }, message: /abortChangePercent must be between/iu },
    { patch: { scheduledSyncIntervalSeconds: 0 }, message: /must be a positive number/iu },
    { patch: { lastSyncTime: -1 }, message: /lastSyncTime must be a non-negative/iu },
    { patch: { syncEnabled: "true" }, message: /syncEnabled must be a boolean/iu },
    { patch: { githubTokenSecretId: "secret-aliased", encryptionPassphraseSecretId: "secret-aliased" }, message: /secret IDs must be distinct/iu },
  ];
  for (const { patch, message } of invalid) {
    assert.throws(() => assertPluginSettingsRuntimeSafe({ ...valid, ...patch }), message, JSON.stringify(patch));
  }
});

test("D476 a legacy saved blank GitHub branch loads read-only for Settings repair", async () => {
  const secretWrites: string[] = []
  const saved = { ...valid, githubBranch: "", githubToken: "" }
  const fake = {
    loadData: async () => ({ settings: saved }),
    canMigrateStartupSecrets: async () => false,
    app: { secretStorage: {
      getSecret: () => null,
      setSecret: (id: string) => { secretWrites.push(id) },
    } },
  } as unknown as FastSync
  await FastSync.prototype.loadSettings.call(fake)
  assert.equal(fake.settings.githubBranch, "",
    "existing blank branch must remain visible and editable instead of silently switching to main")
  assert.deepEqual(secretWrites, [])
})

test("D476 direct Settings Save refuses blank GitHub branch before SecretStorage or persistence", async () => {
  const saved = { ...valid, githubTokenSecretId: "token-id", encryptionPassphraseSecretId: "pass-id" }
  const secretWrites: string[] = []
  let diskWrites = 0
  const plugin = {
    settings: saved,
    secretStorageReadUnavailable: false,
    settingsSaveInProgress: false,
    settingsSaveAttemptGeneration: 0,
    app: { secretStorage: {
      getSecret: () => null,
      setSecret: (id: string) => { secretWrites.push(id) },
    } },
    v4Runtime: { assertReencryptionSettingsSaveAllowed: async () => undefined },
    persistData: async () => { diskWrites++ },
    initGitHubClient: () => undefined,
    registerScheduledSync: () => undefined,
    createSecretId: () => { throw new Error("unexpected new secret allocation") },
  } as unknown as FastSync
  for (const githubBranch of ["", " \t "]) {
    await assert.rejects(() => FastSync.prototype.saveSettings.call(plugin,
      { ...saved, githubBranch }), /GitHub branch/u)
    assert.deepEqual(secretWrites, [], "invalid branch must not change credentials")
    assert.equal(diskWrites, 0, "invalid branch must not persist")
    assert.equal(plugin.settings.githubBranch, saved.githubBranch,
      "failed Save must not replace the active remote branch")
  }
})

test("D475 legacy saved blank Device ID remains loadable for Settings repair without secret mutation", async () => {
  const writes: string[] = []
  const legacy = { ...valid, vault: "", githubToken: "" }
  const fake = {
    loadData: async () => ({ settings: legacy }),
    canMigrateStartupSecrets: async () => false,
    app: { secretStorage: {
      getSecret: () => null,
      setSecret: (id: string) => { writes.push(id) },
    } },
  } as unknown as FastSync
  await FastSync.prototype.loadSettings.call(fake)
  assert.equal(fake.settings.vault, "",
    "loading an old blank ID must not silently replace the device identity or prevent Settings access")
  assert.deepEqual(writes, [], "startup must not rewrite saved secrets")
})

test("D475 an empty Device ID is rejected at the direct Save boundary before secrets or disk writes", async () => {
  const saved = { ...valid, vault: "existing-device", githubTokenSecretId: "token-id", encryptionPassphraseSecretId: "pass-id" }
  const secretWrites: string[] = []
  let diskWrites = 0
  const plugin = {
    settings: saved,
    secretStorageReadUnavailable: false,
    settingsSaveInProgress: false,
    settingsSaveAttemptGeneration: 0,
    app: { secretStorage: {
      getSecret: () => null,
      setSecret: (id: string) => { secretWrites.push(id) },
    } },
    v4Runtime: { assertReencryptionSettingsSaveAllowed: async () => undefined },
    persistData: async () => { diskWrites++ },
    initGitHubClient: () => undefined,
    registerScheduledSync: () => undefined,
    createSecretId: () => { throw new Error("no new secrets should be allocated") },
  } as unknown as FastSync
  for (const vault of ["", "  \t "]) {
    await assert.rejects(() => FastSync.prototype.saveSettings.call(plugin,
      { ...saved, vault }), /Device ID/u)
    assert.deepEqual(secretWrites, [])
    assert.equal(diskWrites, 0)
    assert.equal(plugin.settings.vault, "existing-device")
  }
})

test("corrupt saved settings are rejected before startup secret migration side effects", async () => {
  const writes: string[] = [];
  const fake = {
    loadData: async () => ({ settings: { githubOwner: "../unsafe", githubToken: "synthetic-token" } }),
    app: { secretStorage: { getSecret: () => null, setSecret: (id: string) => { writes.push(id); } } },
    createSecretId: (prefix: string) => prefix,
  } as unknown as FastSync;
  await assert.rejects(() => FastSync.prototype.loadSettings.call(fake), /Invalid GitHub owner/iu);
  assert.deepEqual(writes, [], "invalid persisted configuration must not touch saved secrets");
});

test("invalid pending settings reject before runtime credential generation or secret mutation", async () => {
  let generations = 0;
  const writes: string[] = [];
  const fake = {
    settings: { ...valid, githubTokenSecretId: "same", encryptionPassphraseSecretId: "same" },
    v4Runtime: { credentialsChanged: () => { generations++; } },
    app: { secretStorage: { getSecret: () => null, setSecret: (id: string) => { writes.push(id); } } },
    initGitHubClient: () => { throw new Error("should not initialize invalid client"); },
    registerScheduledSync: () => { throw new Error("should not schedule invalid settings"); },
    persistData: async () => { throw new Error("should not persist invalid settings"); },
  } as unknown as FastSync;
  await assert.rejects(() => FastSync.prototype.saveSettings.call(fake), /secret IDs must be distinct/iu);
  assert.equal(generations, 0, "rejected settings do not invalidate an in-flight sync snapshot");
  assert.deepEqual(writes, [], "no partial secret updates for rejected settings");
});
