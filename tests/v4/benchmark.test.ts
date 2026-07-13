import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseV4Parts } from "../../src/lib/v4/large-files";
import { planV4Sync, type V4LogicalFile } from "../../src/lib/v4/planner";

test("v4 planner isolates one change across 100,000 logical files", () => {
  const count = 100_000;
  const base: V4LogicalFile[] = Array.from({ length: count }, (_, index) => ({ path: `Folder/${index}.md`, fileId: `f${index}`, hash: `h${index}`, size: 1024, mtime: 1 }));
  const local = base.slice();
  local[54_321] = { ...local[54_321], hash: "changed", mtime: 2 };
  const started = Date.now();
  const plan = planV4Sync({ operation: "normal", base, local, remote: base });
  assert.equal(plan.pushes.length, 1);
  assert.equal(plan.changedFiles, 1);
  assert.ok(Date.now() - started < 5_000);
});

test("v4 predicts part storage for a 5 GiB logical file without allocating it", () => {
  assert.equal(shouldUseV4Parts(5 * 1024 * 1024 * 1024), true);
});
