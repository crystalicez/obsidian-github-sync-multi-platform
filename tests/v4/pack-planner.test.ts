import assert from "node:assert/strict";
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "../../src/lib/v4/large-files";
import test from "node:test";

import {
  PACK_MAX_ENTRY_BYTES,
  PACK_MAX_FILES,
  PACK_MAX_PLAINTEXT_BYTES,
  PACK_MIN_CHANGED_FILES,
  estimateV4PackGroupResources,
  planV4PackGroups,
  type V4PackCandidateMeta,
} from "../../src/lib/v4/pack-planner";

function candidate(index: number, options: { folder?: string; size?: number } = {}): V4PackCandidateMeta {
  const folder = options.folder ?? "Folder";
  return { fileId: `f${index}`, path: `${folder}/${index}.md`, size: options.size ?? 16 };
}

test("pack planner splits large groups before new GitHub REST encrypted blob would exceed 8 MiB", () => {
  const candidates = Array.from({ length: 96 }, (_, index) =>
    candidate(index, { size: 512 * 1024 }));
  const groups = planV4PackGroups(candidates, {
    maxPlaintextBytes: PACK_MAX_PLAINTEXT_BYTES,
    maxTransportTransientBytes: 256 * 1024 * 1024,
    maxResidentBytes: 256 * 1024 * 1024,
  });
  assert.ok(groups.length >= 6, "Large pack groups must be split on the physical REST blob boundary");
  assert.deepEqual(groups.flat(), candidates, "Every eligible file is published exactly once");
  for (const group of groups) {
    const budget = estimateV4PackGroupResources(group);
    assert.ok(budget.ciphertextBytes <= V4_GITHUB_REST_SAFE_WRITER_BYTES,
      `Pack encrypted bytes ${budget.ciphertextBytes} exceed 8 MiB`);
  }
});


test("incremental planner matches a full group-resource recalculation for mixed 1,200-note vaults", () => {
  const candidates = Array.from({ length: 1_200 }, (_, index) => ({
    fileId: index % 7 === 0 ? `สวัสดี-🌏-${index}` : `file-${index}`,
    path: `${index < 550 ? "Notes" : index < 920 ? "Projects/Subfolder" : "Assets"}/note-${index}.md`,
    size: index % 97 === 0 ? PACK_MAX_ENTRY_BYTES + 1 : index % 37 === 0 ? 256 * 1024 : index % 5 === 0 ? 0 : (index % 17) + 1,
  }))
  const budgets = [
    { maxPlaintextBytes: PACK_MAX_PLAINTEXT_BYTES },
    { maxPlaintextBytes: 64 * 1024 },
    { maxResidentBytes: 2 * 1024 * 1024, maxTransportTransientBytes: 3 * 1024 * 1024 },
    { maxPlaintextBytes: 512 * 1024, maxResidentBytes: 4 * 1024 * 1024, maxTransportTransientBytes: 5 * 1024 * 1024 },
  ]
  for (const options of budgets) {
    const fits = (group: V4PackCandidateMeta[]) => {
      const estimate = estimateV4PackGroupResources(group)
      return estimate.plaintextBytes <= Math.min(PACK_MAX_PLAINTEXT_BYTES, options.maxPlaintextBytes ?? PACK_MAX_PLAINTEXT_BYTES)
        && estimate.ciphertextBytes <= V4_GITHUB_REST_SAFE_WRITER_BYTES
        && estimate.residentBytes <= (options.maxResidentBytes ?? Number.POSITIVE_INFINITY)
        && estimate.transportBytes <= (options.maxTransportTransientBytes ?? Number.POSITIVE_INFINITY)
    }
    const eligible = candidates.filter(item => item.size <= PACK_MAX_ENTRY_BYTES && fits([item]))
    const expected: V4PackCandidateMeta[][] = []
    if (eligible.length >= PACK_MIN_CHANGED_FILES) {
      for (let cursor = 0; cursor < eligible.length;) {
        const folder = eligible[cursor].path.slice(0, eligible[cursor].path.lastIndexOf("/"))
        const group: V4PackCandidateMeta[] = []
        while (cursor < eligible.length && group.length < PACK_MAX_FILES) {
          const item = eligible[cursor]
          if (group.length > 0 && item.path.slice(0, item.path.lastIndexOf("/")) !== folder) break
          if (group.length > 0 && !fits([...group, item])) break
          group.push(item)
          cursor++
        }
        expected.push(group)
      }
    }
    assert.deepEqual(planV4PackGroups(candidates, options), expected, JSON.stringify(options))
  }
})

test("10,000 small changed notes group in stable source order under the REST size cap", () => {
  const candidates = Array.from({ length: 10_000 }, (_, index) => candidate(index, { size: 512 }))
  const groups = planV4PackGroups(candidates)
  assert.equal(groups.length, 20)
  assert.deepEqual(groups.map(group => group.length), Array.from({ length: 20 }, () => 500))
  assert.deepEqual(groups.flat(), candidates)
  assert.ok(groups.every(group => estimateV4PackGroupResources(group).ciphertextBytes <= V4_GITHUB_REST_SAFE_WRITER_BYTES))
})

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

  assert.ok(groups[0].length > 0 && groups[0].length < 500);
  assert.ok(groups.length >= 3);
  assert.deepEqual(groups.flat(), candidates, "Each eligible file appears in order exactly once");
  assert.ok(groups.every(group => group.length <= PACK_MAX_FILES));
  assert.ok(groups.every(group => estimateV4PackGroupResources(group).ciphertextBytes <= V4_GITHUB_REST_SAFE_WRITER_BYTES));
  assert.equal(groups[0][0].fileId, "f0");
  assert.ok(groups.some(group => group[0].fileId === "f501"));
  assert.equal(groups.flat().at(-1)?.fileId, "f565");
  assert.ok(groups.every(group => new Set(group.map(item => item.path.split("/").slice(0, -1).join("/"))).size === 1));
  assert.ok(groups.every(group => group.reduce((sum, item) => sum + item.size, 0) <= PACK_MAX_PLAINTEXT_BYTES));
});
