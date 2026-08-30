import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const suites = [
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
];

test("all credentialed live suites delegate destructive target safety", async () => {
  for (const file of suites) {
    const text = await readFile(resolve(file), "utf8");
    assert.match(text, /\.\/support\/target-safety/u, file);
    assert.match(text, /readGitHubE2ETargetEnvironment/u, file);
    assert.match(text, /resolveGitHubE2ETarget/u, file);
    assert.match(text, /resetGitHubE2EDisposableBranch/u, file);
    assert.doesNotMatch(text, /async function deleteTestBranch/u, file);
    assert.doesNotMatch(text, /const forbiddenBranches/u, file);
  }
});
