import assert from "node:assert/strict";
import test from "node:test";

import { classifyTestPath, discoverTests, selectTests, shardSelectedTests } from "../../scripts/test-discovery.mjs";

test("real GitHub E2E is excluded from the default test tier", () => {
  assert.equal(classifyTestPath("tests/github-e2e/v4-real-github-e2e.test.ts"), "github-e2e");
  assert.equal(classifyTestPath("tests/v4/planner.test.ts"), "fast");
  assert.equal(classifyTestPath("tests/model/v4-sync-model.test.ts"), "fast");
  assert.equal(classifyTestPath("tests/soak/v4-100mb-stream.test.ts"), "soak");
});

test("test discovery is recursive, normalized, sorted, and tiered", async () => {
  const discovered = await discoverTests(process.cwd());
  const paths = discovered.map(item => item.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(discovered.some(item => item.path === "tests/v4/planner.test.ts" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/github-e2e/v4-real-github-e2e.test.ts" && item.tier === "github-e2e"));
  assert.ok(discovered.some(item => item.path === "tests/v4/legacy-retirement.test.mjs" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/model/v4-sync-model.test.ts" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/soak/v4-100mb-stream.test.ts" && item.tier === "soak"));
});


test("D261 test sharding preserves every file exactly once without modifying the full tier", async () => {
  const all = selectTests(await discoverTests(process.cwd()), { tier: "fast" });
  assert.ok(all.length >= 7, "shard coverage test requires seven real Fast files");
  for (const total of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: total }, (_, i) =>
      shardSelectedTests(all, `${i + 1}/${total}`));
    const union = shards.flat();
    assert.equal(union.length, all.length, "all test files must be scheduled exactly once");
    assert.equal(new Set(union.map(item => item.path)).size, all.length);
    assert.deepEqual(union.map(item => item.path).sort(),
      all.map(item => item.path).sort());
    for (const [i, files] of shards.entries()) {
      assert.deepEqual(files, all.filter((_, index) => index % total === i));
    }
  }
  assert.deepEqual(shardSelectedTests(all, ""), all, "full fast is unchanged by default");
});

test("D261 invalid shards refuse silently skipping tests and tier filters stay isolated", () => {
  const discovered = [
    { path: "tests/v4/a.test.ts", tier: "fast" },
    { path: "tests/v4/b.test.ts", tier: "fast" },
    { path: "tests/v4/c.test.ts", tier: "fast" },
    { path: "tests/github-e2e/live.test.ts", tier: "github-e2e" },
  ];
  for (const invalid of ["0/2", "3/2", "1/0", "1/-2", "1/1.5", "1/2x", "hi", "2", "1/9999999999"]) {
    assert.throws(() => shardSelectedTests(selectTests(discovered, { tier: "fast" }), invalid),
      /shard/i, invalid);
  }
  const fast = selectTests(discovered, { tier: "fast" });
  assert.deepEqual(shardSelectedTests(fast, "2/2"), [fast[1]]);
  assert.deepEqual(shardSelectedTests(selectTests(discovered, {
    tier: "github-e2e",
  }), "1/1"), [discovered[3]]);
  assert.deepEqual(shardSelectedTests(selectTests(discovered, {
    tier: "fast", filter: "b.test",
  }), "1/1"), [discovered[1]]);
});

test("tier and filter selection never leaks tests from another tier", () => {
  const discovered = [
    { path: "tests/v4/planner.test.ts", tier: "fast" },
    { path: "tests/v4/storage-codec.test.ts", tier: "fast" },
    { path: "tests/github-e2e/v4-real-github-e2e.test.ts", tier: "github-e2e" },
  ];
  assert.deepEqual(selectTests(discovered, { tier: "fast", filter: "planner" }), [discovered[0]]);
  assert.deepEqual(selectTests(discovered, { tier: "github-e2e" }), [discovered[2]]);
});
