import assert from "node:assert/strict";
import test from "node:test";

import { formatV4ActiveSyncStatus } from "../../src/lib/v4/status";

test("active sync without a transfer plan shows the checking phase instead of zero counters", () => {
  assert.deepEqual(formatV4ActiveSyncStatus({ pushCount: 0, totalPush: 0, pullCount: 0, totalPull: 0 }), {
    text: "⏳ GH Sync: Checking remote...",
    title: "GitHub Sync: Checking remote and planning changes...",
  });
});

test("active sync shows transfer counters once totals are known", () => {
  assert.deepEqual(formatV4ActiveSyncStatus({ pushCount: 1, totalPush: 3, pullCount: 2, totalPull: 4 }), {
    text: "⏳ GH Sync: ↑1/3 ↓2/4",
    title: "GitHub Sync: Syncing in progress...",
  });
});
