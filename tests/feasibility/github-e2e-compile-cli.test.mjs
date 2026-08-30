import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("GitHub E2E compile-only mode works through a shell-independent CLI flag", () => {
  const env = { ...process.env };
  delete env.GITHUB_E2E_COMPILE_ONLY;
  delete env.GITHUB_E2E_ENV_FILE;
  delete env.GITHUB_E2E_OWNER;
  delete env.GITHUB_E2E_REPO;
  delete env.GITHUB_E2E_BRANCH;
  delete env.GITHUB_E2E_TOKEN;
  delete env.GITHUB_E2E_EXPECTED_REPO_ID;

  const result = spawnSync(process.execPath, [resolve("scripts/run-github-e2e.mjs"), "--compile-only"], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GitHub E2E bundle compiled:/u);
});

test("compile-only ignores target env files and emits only fixed bundles", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-compile-"));
  await writeFile(resolve(outDir, "stale.txt"), "stale\n");
  const env = { ...process.env, GITHUB_E2E_ENV_FILE: resolve(outDir, "missing.env") };
  for (const key of ["GITHUB_E2E_OWNER", "GITHUB_E2E_REPO", "GITHUB_E2E_BRANCH", "GITHUB_E2E_TOKEN", "GITHUB_E2E_EXPECTED_REPO_ID"]) delete env[key];

  const result = spawnSync(process.execPath, [
    resolve("scripts/run-github-e2e.mjs"),
    "--compile-only",
    `--out-dir=${outDir}`,
  ], { cwd: resolve("."), env, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual((await readdir(outDir)).sort(), [
    "v4-copy-contract-github-e2e.test.mjs",
    "v4-encrypted-external-mutation.test.mjs",
    "v4-real-github-e2e.test.mjs",
  ]);
});
