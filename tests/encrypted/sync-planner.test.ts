import assert from "node:assert/strict";
import test from "node:test";

import { planEncryptedSnapshotSync } from "../../src/lib/encrypted/sync-planner";

function files(count: number, size = 100) {
  return Array.from({ length: count }, (_, index) => ({ path: `Notes/${index}.md`, size, mtime: index }));
}

test("sync planner chooses pack for initial snapshots with many small files", () => {
  const plan = planEncryptedSnapshotSync({
    currentLayout: { packedFileCount: 0, looseObjectCount: 0, looseBytes: 0 },
    changedFiles: files(1_999, 100),
    totalFiles: 1_999,
    totalBytes: 199_900,
  });

  assert.equal(plan.mode, "pack-base");
  assert.equal(plan.reason, "initial-bulk");
  assert.ok(plan.estimatedRequests < 20);
});

test("sync planner chooses loose delta for one edited file after packed base", () => {
  const plan = planEncryptedSnapshotSync({
    currentLayout: { packedFileCount: 5_000, looseObjectCount: 0, looseBytes: 0 },
    changedFiles: [{ path: "Notes/a.md", size: 200, mtime: 2 }],
    totalFiles: 5_000,
    totalBytes: 500_000,
  });

  assert.equal(plan.mode, "loose-delta");
  assert.equal(plan.reason, "small-change-set");
  assert.equal(plan.estimatedRequests, 2);
});

test("sync planner chooses chunked object for GitHub-large files", () => {
  const plan = planEncryptedSnapshotSync({
    currentLayout: { packedFileCount: 0, looseObjectCount: 0, looseBytes: 0 },
    changedFiles: [{ path: "large.bin", size: 120 * 1024 * 1024, mtime: 1 }],
    totalFiles: 1,
    totalBytes: 120 * 1024 * 1024,
  });

  assert.equal(plan.mode, "chunked-object");
  assert.equal(plan.reason, "large-file");
  assert.ok(plan.estimatedRequests > 2);
});

test("sync planner chooses compaction when loose deltas exceed request budget", () => {
  const plan = planEncryptedSnapshotSync({
    currentLayout: { packedFileCount: 5_000, looseObjectCount: 600, looseBytes: 4 * 1024 * 1024 },
    changedFiles: files(40, 100),
    totalFiles: 5_000,
    totalBytes: 500_000,
  }, { maxLooseObjectsBeforeCompact: 512 });

  assert.equal(plan.mode, "compact");
  assert.equal(plan.reason, "loose-object-budget");
});