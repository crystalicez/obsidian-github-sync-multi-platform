import assert from "node:assert/strict";
import test from "node:test";
import { planEncryptedV3Sync } from "../../src/lib/encrypted/v3-planner";

test("encrypted v3 planner uses loose delta for one edit after a packed base", () => {
  const plan = planEncryptedV3Sync({
    layout: { basePackCount: 12, looseDeltaCount: 0, looseDeltaBytes: 0 },
    changedFiles: [{ path: "note.md", size: 120, mtime: 1 }],
    totalFiles: 100000,
    totalBytes: 5 * 1024 * 1024 * 1024,
  });
  assert.equal(plan.mode, "loose-delta");
  assert.equal(plan.rewritesBasePacks, false);
  assert.equal(plan.estimatedCommits, 1);
});

test("encrypted v3 planner chooses base pack for initial large vault", () => {
  const plan = planEncryptedV3Sync({
    layout: { basePackCount: 0, looseDeltaCount: 0, looseDeltaBytes: 0 },
    changedFiles: Array.from({ length: 5000 }, (_, index) => ({ path: `n${index}.md`, size: 50, mtime: index })),
    totalFiles: 5000,
    totalBytes: 250000,
  });
  assert.equal(plan.mode, "base-pack");
  assert.ok(plan.packCount > 1);
  assert.equal(plan.rewritesBasePacks, true);
});

test("encrypted v3 planner chooses chunked object for files larger than GitHub accepts", () => {
  const plan = planEncryptedV3Sync({
    layout: { basePackCount: 1, looseDeltaCount: 0, looseDeltaBytes: 0 },
    changedFiles: [{ path: "movie.mov", size: 101 * 1024 * 1024, mtime: 1 }],
    totalFiles: 10,
    totalBytes: 110 * 1024 * 1024,
  });
  assert.equal(plan.mode, "chunked-object");
  assert.ok(plan.chunkCount > 1);
});

test("encrypted v3 planner compacts when loose deltas exceed budget", () => {
  const plan = planEncryptedV3Sync({
    layout: { basePackCount: 2, looseDeltaCount: 600, looseDeltaBytes: 70 * 1024 * 1024 },
    changedFiles: [{ path: "new.md", size: 100, mtime: 1 }],
    totalFiles: 2000,
    totalBytes: 80 * 1024 * 1024,
  });
  assert.equal(plan.mode, "compact");
  assert.equal(plan.rewritesBasePacks, true);
});