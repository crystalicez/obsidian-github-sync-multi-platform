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
