import assert from "node:assert/strict";
import test from "node:test";

import { classifyTestPath, discoverTests, selectTests } from "../../scripts/test-discovery.mjs";

test("real GitHub E2E is excluded from the default test tier", () => {
  assert.equal(classifyTestPath("tests/github-e2e/v4-real-github-e2e.test.ts"), "github-e2e");
  assert.equal(classifyTestPath("tests/v4/planner.test.ts"), "fast");
  assert.equal(classifyTestPath("tests/model/v4-sync-model.test.ts"), "fast");
  assert.equal(classifyTestPath("tests/soak/v4-5gib-stream.test.ts"), "soak");
});

test("test discovery is recursive, normalized, sorted, and tiered", async () => {
  const discovered = await discoverTests(process.cwd());
  const paths = discovered.map(item => item.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(discovered.some(item => item.path === "tests/v4/planner.test.ts" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/github-e2e/v4-real-github-e2e.test.ts" && item.tier === "github-e2e"));
  assert.ok(discovered.some(item => item.path === "tests/v4/legacy-retirement.test.mjs" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/model/v4-sync-model.test.ts" && item.tier === "fast"));
  assert.ok(discovered.some(item => item.path === "tests/soak/v4-5gib-stream.test.ts" && item.tier === "soak"));
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
