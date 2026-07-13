import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS } from "../../src/setting";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence } from "../../src/lib/v4/secrets";

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
