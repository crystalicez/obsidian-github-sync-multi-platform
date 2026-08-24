import assert from "node:assert/strict";
import test from "node:test";

import { coalesceV4Changes, type V4QueuedChange } from "../../src/lib/v4/sync-coordinator";

const rescan = (mtime = 99): V4QueuedChange => ({ type: "rescan", mtime });

function types(changes: V4QueuedChange[]): string[] {
  return coalesceV4Changes(changes).map(change => change.type);
}

test("v4 rescan preserves identity-breaking file causality", () => {
  const cases: Array<{ name: string; changes: V4QueuedChange[]; expected: string[] }> = [
    {
      name: "replace",
      changes: [{ type: "replace", oldPath: "a.md", path: "a.md", mtime: 1 }, rescan()],
      expected: ["replace", "rescan"],
    },
    {
      name: "rename",
      changes: [{ type: "rename", oldPath: "a.md", path: "b.md", mtime: 1 }, rescan()],
      expected: ["rename", "rescan"],
    },
    {
      name: "delete",
      changes: [{ type: "delete", path: "a.md", mtime: 1 }, rescan()],
      expected: ["delete", "rescan"],
    },
    {
      name: "delete recreate",
      changes: [
        { type: "delete", path: "a.md", mtime: 1 },
        { type: "modify", path: "a.md", mtime: 2 },
        rescan(),
      ],
      expected: ["replace", "rescan"],
    },
  ];

  for (const item of cases) {
    assert.deepEqual(types(item.changes), item.expected, item.name);
  }
});

test("v4 rescan preserves folder causality", () => {
  assert.deepEqual(types([
    { type: "folderRename", oldPath: "Folder", path: "Moved", mtime: 1 },
    rescan(),
  ]), ["folderRename", "rescan"]);

  assert.deepEqual(types([
    { type: "folderDelete", path: "Folder", mtime: 1 },
    rescan(),
  ]), ["folderDelete", "rescan"]);
});

test("v4 content-only modifies may still collapse to one rescan", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "modify", path: "a.md", mtime: 1 },
    { type: "modify", path: "b.md", mtime: 2 },
    rescan(3),
  ]), [{ type: "rescan", mtime: 3 }]);
});

test("v4 ambiguous rename chains keep raw causality plus rescan", () => {
  const changes: V4QueuedChange[] = [
    { type: "rename", oldPath: "a.md", path: "b.md", mtime: 1 },
    { type: "rename", oldPath: "b.md", path: "c.md", mtime: 2 },
    rescan(3),
  ];
  const result = coalesceV4Changes(changes);
  assert.equal(result.some(change => change.type === "rename" && change.oldPath === "a.md" && change.path === "b.md"), true);
  assert.equal(result.some(change => change.type === "rename" && change.oldPath === "b.md" && change.path === "c.md"), true);
  assert.equal(result.at(-1)?.type, "rescan");
});
