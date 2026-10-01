import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunScheduledSync } from "../../src/lib/sync-policy";

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
