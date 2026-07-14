import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS } from "../../src/setting";
import { migrateV4Secrets, sanitizeV4SettingsForPersistence } from "../../src/lib/v4/secrets";
import { selectV4RuntimeConfig } from "../../src/lib/v4/runtime";
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
