import assert from "node:assert/strict";
import test from "node:test";

import { createIdleV4Progress, type V4SyncProgressSnapshot } from "../../src/lib/v4/progress";
import { formatV4ActiveSyncStatus } from "../../src/lib/v4/status";

test("status formats phase and separate directional counts", () => {
  const snapshot = createIdleV4Progress();
  Object.assign(snapshot, {
    lifecycle: "active",
    phase: "uploading",
    currentPath: "Notes/project.md",
    pull: { completed: 10, total: 10 },
    push: { completed: 2, total: 7 },
  });
  assert.deepEqual(formatV4ActiveSyncStatus(snapshot), {
    text: "⏳ GH Sync: Uploading · ↓10/10 ↑2/7",
    title: "Uploading\nPath: Notes/project.md\nPull: 10/10 · remaining 0\nPush: 2/7 · remaining 5",
  });
});

test("unknown totals never render as zero totals", () => {
  const snapshot = { ...createIdleV4Progress(), lifecycle: "active" as const, phase: "scanning-local" as const };
  const display = formatV4ActiveSyncStatus(snapshot);
  assert.equal(display.text, "⏳ GH Sync: Scanning local…");
  assert.doesNotMatch(display.title, /0\/0/u);
});

test("failure tooltip keeps phase path counters and error", () => {
  const snapshot: V4SyncProgressSnapshot = {
    ...createIdleV4Progress(),
    lifecycle: "failed",
    phase: "uploading",
    currentPath: "A.md",
    failurePhase: "uploading",
    failurePath: "A.md",
    errorMessage: "network down",
  };
  assert.match(formatV4ActiveSyncStatus(snapshot).title, /Failed during Uploading.*A\.md.*network down/su);
});

test("legacy main status input remains supported until progress-store integration", () => {
  assert.deepEqual(formatV4ActiveSyncStatus({ pushCount: 1, totalPush: 3, pullCount: 2, totalPull: 4 }), {
    text: "⏳ GH Sync: ↑1/3 ↓2/4",
    title: "GitHub Sync: Syncing in progress...",
  });
});
