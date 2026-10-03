import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScheduledSyncIntervalSeconds, shouldRunScheduledSync } from "../../src/lib/sync-policy";

test("scheduled sync requires a complete GitHub configuration", () => {
  const enabled = {
    syncEnabled: true,
    scheduledSyncEnabled: true,
    githubToken: "token",
    githubOwner: "owner",
    githubRepo: "repo",
  };

  assert.equal(shouldRunScheduledSync(enabled), true);
  assert.equal(shouldRunScheduledSync({ ...enabled, githubToken: "" }), false);
  assert.equal(shouldRunScheduledSync({ ...enabled, githubOwner: "" }), false);
  assert.equal(shouldRunScheduledSync({ ...enabled, githubRepo: "" }), false);
});

test("scheduled sync interval never exceeds the safe 32-bit timer delay", () => {
  const maxSafeSeconds = Math.floor(0x7fffffff / 1000);
  assert.equal(normalizeScheduledSyncIntervalSeconds(Number.MAX_VALUE), maxSafeSeconds);
  assert.equal(normalizeScheduledSyncIntervalSeconds(maxSafeSeconds + 1), maxSafeSeconds);
});
