import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("repository ships no executable GitHub Actions workflows", async () => {
  let entries = [];
  try { entries = await readdir(resolve(".github/workflows")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  assert.deepEqual(entries.filter(name => /\.ya?ml$/iu.test(name)), [],
    "GitHub Actions must remain absent; qualification and release use the local-only path");
});

test("maintainer qualification and publication stay exact-SHA and local-only", async () => {
  const [qualify, release, lib, packageJson] = await Promise.all([
    readFile(resolve("scripts/local-qualify.mjs"), "utf8"),
    readFile(resolve("scripts/local-release.mjs"), "utf8"),
    readFile(resolve("scripts/local-release-lib.mjs"), "utf8"),
    readFile(resolve("package.json"), "utf8"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["qualify:local"], "node scripts/local-qualify.mjs");
  assert.equal(scripts["release:local"], "node scripts/local-release.mjs");
  assert.match(qualify, /requireCleanMaster/u);
  assert.match(qualify, /readRemoteMasterSha/u);
  assert.match(qualify, /cleanupE2EBranch/u);
  assert.match(release, /validateQualificationReceipt/u);
  assert.match(release, /createStableRef/u);
  assert.match(release, /verifyReleaseAssets/u);
  assert.match(lib, /"github-e2e-cleanup-verified"/u);
  assert.doesNotMatch(qualify + release, /actions\/workflows\/|workflow_dispatch|gh workflow run/iu);
});
