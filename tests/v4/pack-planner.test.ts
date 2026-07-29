import assert from "node:assert/strict";
import test from "node:test";

import {
  PACK_MAX_ENTRY_BYTES,
  PACK_MAX_FILES,
  PACK_MAX_PLAINTEXT_BYTES,
  PACK_MIN_CHANGED_FILES,
  planV4PackGroups,
  type V4PackCandidateMeta,
} from "../../src/lib/v4/pack-planner";

function candidate(index: number, options: { folder?: string; size?: number } = {}): V4PackCandidateMeta {
  const folder = options.folder ?? "Folder";
  return { fileId: `f${index}`, path: `${folder}/${index}.md`, size: options.size ?? 16 };
}

test("pack planner freezes the current V4 pack thresholds", () => {
  assert.equal(PACK_MIN_CHANGED_FILES, 64);
  assert.equal(PACK_MAX_FILES, 500);
  assert.equal(PACK_MAX_PLAINTEXT_BYTES, 32 * 1024 * 1024);
  assert.equal(PACK_MAX_ENTRY_BYTES, 1024 * 1024);
});

test("pack planner does not pack fewer than 64 eligible changed files", () => {
  assert.deepEqual(planV4PackGroups(Array.from({ length: 63 }, (_, index) => candidate(index))), []);
});

test("pack planner filters oversize entries before applying the 64-file threshold", () => {
  const candidates = Array.from({ length: 64 }, (_, index) => candidate(index));
  candidates[63] = candidate(63, { size: PACK_MAX_ENTRY_BYTES + 1 });
  assert.deepEqual(planV4PackGroups(candidates), []);
});

test("pack planner preserves folder grouping, order, max files, and plaintext byte limits", () => {
  const candidates: V4PackCandidateMeta[] = [
    ...Array.from({ length: 500 }, (_, index) => candidate(index, { folder: "A", size: 64 * 1024 })),
    candidate(500, { folder: "A", size: 64 * 1024 }),
    ...Array.from({ length: 64 }, (_, index) => candidate(501 + index, { folder: "B", size: 512 * 1024 })),
    candidate(565, { folder: "B", size: 512 * 1024 }),
  ];
  const groups = planV4PackGroups(candidates);

  assert.equal(groups[0].length, 500);
  assert.equal(groups[1].length, 1);
  assert.equal(groups[2].length, 64);
  assert.equal(groups[3].length, 1);
  assert.equal(groups[0][0].fileId, "f0");
  assert.equal(groups[1][0].fileId, "f500");
  assert.equal(groups[2][0].fileId, "f501");
  assert.ok(groups.every(group => new Set(group.map(item => item.path.split("/").slice(0, -1).join("/"))).size === 1));
  assert.ok(groups.every(group => group.reduce((sum, item) => sum + item.size, 0) <= PACK_MAX_PLAINTEXT_BYTES));
});
