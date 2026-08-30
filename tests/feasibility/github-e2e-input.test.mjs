import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GITHUB_E2E_BUNDLES, writeGitHubE2EInputManifest } from "../../scripts/github-e2e-input.mjs";

const goodEnv = {
  GITHUB_REPOSITORY_ID: "1282135059",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "2",
};

async function makeBundles() {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-input-test-"));
  for (const name of GITHUB_E2E_BUNDLES) await writeFile(resolve(outDir, name), `bundle:${name}\n`);
  return outDir;
}

test("manifest binds exact bundles to CI attempt", async () => {
  const outDir = await makeBundles();
  await writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "v22.11.0" });
  assert.deepEqual((await readdir(outDir)).sort(), ["github-e2e-input.json", ...GITHUB_E2E_BUNDLES].sort());
  const manifest = JSON.parse(await readFile(resolve(outDir, "github-e2e-input.json"), "utf8"));
  assert.deepEqual(manifest.bundles.map(item => item.name), GITHUB_E2E_BUNDLES);
  assert.equal(manifest.repositoryId, goodEnv.GITHUB_REPOSITORY_ID);
  assert.equal(manifest.commitSha, goodEnv.GITHUB_SHA);
  assert.equal(manifest.workflowRunId, goodEnv.GITHUB_RUN_ID);
  assert.equal(manifest.workflowRunAttempt, 2);
  assert.equal(manifest.nodeVersion, "v22.11.0");
  assert.ok(manifest.bundles.every(item => Number.isSafeInteger(item.size) && item.size > 0 && /^[0-9a-f]{64}$/u.test(item.sha256)));
});

test("manifest rejects invalid producer fields", async () => {
  for (const [key, value] of [
    ["GITHUB_REPOSITORY_ID", "0"],
    ["GITHUB_SHA", "bad"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ATTEMPT", "0"],
  ]) {
    const outDir = await makeBundles();
    await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: { ...goodEnv, [key]: value }, nodeVersion: "v22.11.0" }), new RegExp(key, "u"));
  }
});

test("manifest rejects empty or extra entries", async () => {
  const emptyDir = await makeBundles();
  await writeFile(resolve(emptyDir, GITHUB_E2E_BUNDLES[0]), "");
  await assert.rejects(writeGitHubE2EInputManifest({ outDir: emptyDir, env: goodEnv, nodeVersion: "v22.11.0" }), /empty/u);

  const extraDir = await makeBundles();
  await writeFile(resolve(extraDir, "unexpected.txt"), "x");
  await assert.rejects(writeGitHubE2EInputManifest({ outDir: extraDir, env: goodEnv, nodeVersion: "v22.11.0" }), /unexpected entries/u);
});

test("manifest rejects invalid Node version", async () => {
  const outDir = await makeBundles();
  await assert.rejects(writeGitHubE2EInputManifest({ outDir, env: goodEnv, nodeVersion: "22" }), /Node version/u);
});

test("CI publishes live E2E input only for master pushes", async () => {
  const ci = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /--out-dir=\.tmp\/github-e2e-input/u);
  assert.match(ci, /--write-input-manifest/u);
  assert.match(ci, /github-e2e-input-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/u);
});

test("hidden CI input directory is explicitly included in artifact upload", async () => {
  const ci = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
  const start = ci.indexOf("Upload release-qualifying GitHub E2E input");
  const end = ci.indexOf("Upload tested plugin artifact", start);
  assert.ok(start >= 0 && end > start);
  assert.match(ci.slice(start, end), /include-hidden-files:\s*true/u);
});
