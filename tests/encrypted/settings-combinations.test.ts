import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveConflictPolicy,
  normalizeScheduledSyncIntervalSeconds,
  shouldHandleEncryptedLocalChange,
  shouldRunScheduledSync,
  shouldRunStartupSync,
  syncModeUsesEncryption,
} from "../../src/lib/encrypted/settings-policy";
import type { ConflictPolicy } from "../../src/lib/encrypted/types";
import { createDebugPayload, sanitizeDebugSettings, syncConsoleLog } from "../../src/lib/debug";

type Mode = "plaintext" | "encrypted";

interface SettingsCase {
  syncEnabled: boolean;
  encryptionMode: Mode;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  syncOnStartup: boolean;
  syncOnLocalChange: boolean;
  scheduledSyncEnabled: boolean;
  scheduledSyncIntervalSeconds: number;
  conflictPolicy: ConflictPolicy;
  ignorePathRegex: string;
}

const bools = [false, true];
const modes: Mode[] = ["plaintext", "encrypted"];
const policies: ConflictPolicy[] = ["copy", "newer", "merge", "ask"];

function settingsFor(options: {
  syncEnabled: boolean;
  mode: Mode;
  hasConfig: boolean;
  syncOnStartup: boolean;
  syncOnLocalChange: boolean;
  scheduledSyncEnabled: boolean;
  conflictPolicy: ConflictPolicy;
}): SettingsCase {
  return {
    syncEnabled: options.syncEnabled,
    encryptionMode: options.mode,
    githubToken: options.hasConfig ? "token" : "",
    githubOwner: options.hasConfig ? "owner" : "",
    githubRepo: options.hasConfig ? "repo" : "",
    syncOnStartup: options.syncOnStartup,
    syncOnLocalChange: options.syncOnLocalChange,
    scheduledSyncEnabled: options.scheduledSyncEnabled,
    scheduledSyncIntervalSeconds: 300,
    conflictPolicy: options.conflictPolicy,
    ignorePathRegex: "",
  };
}

test("settings policy covers every automatic-sync boolean/mode/conflict combination", () => {
  let combinations = 0;

  for (const syncEnabled of bools) {
    for (const mode of modes) {
      for (const hasConfig of bools) {
        for (const syncOnStartup of bools) {
          for (const syncOnLocalChange of bools) {
            for (const scheduledSyncEnabled of bools) {
              for (const conflictPolicy of policies) {
                combinations += 1;
                const settings = settingsFor({
                  syncEnabled,
                  mode,
                  hasConfig,
                  syncOnStartup,
                  syncOnLocalChange,
                  scheduledSyncEnabled,
                  conflictPolicy,
                });

                assert.equal(syncModeUsesEncryption(settings), mode === "encrypted");
                assert.equal(shouldRunStartupSync(settings), syncEnabled && syncOnStartup && hasConfig);
                assert.equal(shouldRunScheduledSync(settings), syncEnabled && scheduledSyncEnabled);
                assert.equal(shouldHandleEncryptedLocalChange(settings, true), mode === "encrypted" && syncEnabled && syncOnLocalChange);
                assert.equal(shouldHandleEncryptedLocalChange(settings, false), mode === "encrypted");
                assert.equal(effectiveConflictPolicy(settings.conflictPolicy), conflictPolicy);
              }
            }
          }
        }
      }
    }
  }

  assert.equal(combinations, 2 * 2 * 2 * 2 * 2 * 2 * 4);
});

test("settings policy normalizes schedule intervals and invalid conflict policies", () => {
  assert.equal(normalizeScheduledSyncIntervalSeconds(300), 300);
  assert.equal(normalizeScheduledSyncIntervalSeconds(30), 30);
  assert.equal(normalizeScheduledSyncIntervalSeconds(1), 30);
  assert.equal(normalizeScheduledSyncIntervalSeconds(2.9), 30);
  assert.equal(normalizeScheduledSyncIntervalSeconds(0.5), 30);
  assert.equal(normalizeScheduledSyncIntervalSeconds(0), 300);
  assert.equal(normalizeScheduledSyncIntervalSeconds(-10), 300);
  assert.equal(normalizeScheduledSyncIntervalSeconds(Number.NaN), 300);
  assert.equal(normalizeScheduledSyncIntervalSeconds("15"), 30);
  assert.equal(normalizeScheduledSyncIntervalSeconds(""), 300);

  assert.equal(effectiveConflictPolicy("copy"), "copy");
  assert.equal(effectiveConflictPolicy("newer"), "newer");
  assert.equal(effectiveConflictPolicy("merge"), "merge");
  assert.equal(effectiveConflictPolicy("ask"), "ask");
  assert.equal(effectiveConflictPolicy("overwrite"), "copy");
});


test("debug settings sanitization hides every secret", () => {
  const sanitized = sanitizeDebugSettings({
    githubToken: "ghp_secret",
    encryptionPassphrase: "vault passphrase",
    githubOwner: "owner",
  });
  const json = JSON.stringify(sanitized);
  assert.equal(sanitized.githubToken, "***HIDDEN***");
  assert.equal(sanitized.encryptionPassphrase, "***HIDDEN***");
  assert.equal(json.includes("ghp_secret"), false);
  assert.equal(json.includes("vault passphrase"), false);
});


test("debug payload hides every secret copied from settings", () => {
  const payload = createDebugPayload({
    githubToken: "ghp_secret",
    encryptionPassphrase: "vault passphrase",
    githubOwner: "owner",
  }, "1.2.3");
  const json = JSON.stringify(payload);
  assert.equal((payload.settings as Record<string, unknown>).githubToken, "***HIDDEN***");
  assert.equal((payload.settings as Record<string, unknown>).encryptionPassphrase, "***HIDDEN***");
  assert.equal(json.includes("ghp_secret"), false);
  assert.equal(json.includes("vault passphrase"), false);
});

test("sync console logging is opt-in and hides secrets", () => {
  const lines: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args); };
  try {
    syncConsoleLog({ consoleLoggingEnabled: false }, "warn", "hidden", { githubToken: "ghp_secret" });
    syncConsoleLog({ consoleLoggingEnabled: true }, "warn", "visible", {
      githubToken: "ghp_secret",
      nested: { encryptionPassphrase: "vault passphrase", count: 2 },
    });
  } finally {
    console.warn = originalWarn;
  }
  const json = JSON.stringify(lines);
  assert.equal(lines.length, 1);
  assert.equal(json.includes("visible"), true);
  assert.equal(json.includes("ghp_secret"), false);
  assert.equal(json.includes("vault passphrase"), false);
  assert.equal(json.includes("***HIDDEN***"), true);
});