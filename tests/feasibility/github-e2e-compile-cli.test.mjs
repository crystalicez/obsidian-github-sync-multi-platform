import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("compile-only ignores target env files and cleans only repository-owned temp output", async t => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const outDir = await mkdtemp(resolve(".tmp", "github-e2e-compile-test-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
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

test("compile-only refuses to delete a caller-owned non-empty output directory", async t => {
  const outDir = await mkdtemp(resolve(tmpdir(), "github-e2e-caller-owned-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const sentinel = resolve(outDir, "keep-me.txt");
  await writeFile(sentinel, "keep\n");

  const result = spawnSync(process.execPath, [
    resolve("scripts/run-github-e2e.mjs"),
    "--compile-only",
    `--out-dir=${outDir}`,
  ], { cwd: resolve("."), env: { ...process.env }, encoding: "utf8" });

  assert.notEqual(result.status, 0, "caller-owned non-empty output must be rejected instead of cleared");
  assert.match(result.stderr, /output directory.*non-empty|refusing.*output directory/iu);
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("D371 fresh isolated E2E preflight fails closed without a dedicated repository and secret", async t => {
  const folder = await mkdtemp(resolve(tmpdir(), "d371-isolated-e2e-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const envFile = resolve(folder, "empty.env");
  await writeFile(envFile, "# intentionally no GitHub credentials\n");
  const env = { ...process.env, GITHUB_E2E_ENV_FILE: envFile };
  for (const key of ["GITHUB_E2E_COMPILE_ONLY", "GITHUB_E2E_OWNER", "GITHUB_E2E_REPO",
    "GITHUB_E2E_BRANCH", "GITHUB_E2E_TOKEN", "GITHUB_E2E_EXPECTED_REPO_ID"]) delete env[key];
  const result = spawnSync(process.execPath, [
    resolve("scripts/run-github-e2e.mjs"), "--preflight-only", "--fresh-isolated-branch",
  ], { cwd: resolve("."), env, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Missing required GitHub E2E env vars/u);
  assert.doesNotMatch(result.stdout, /Fresh isolated GitHub E2E branch|bundle compiled|preflight passed/u);
});

test("D371 fresh isolated E2E preflight refuses canonical source before credentialed network I/O", async t => {
  const folder = await mkdtemp(resolve(tmpdir(), "d371-e2e-source-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const envFile = resolve(folder, "empty.env");
  await writeFile(envFile, "# credentials supplied as harmless fake environment only\n");
  const marker = "D371_DO_NOT_LOG_FAKE_TOKEN";
  const env = {
    ...process.env,
    GITHUB_E2E_ENV_FILE: envFile,
    GITHUB_E2E_OWNER: "crystalicez",
    GITHUB_E2E_REPO: "obsidian-github-sync-multi-platform",
    GITHUB_E2E_EXPECTED_REPO_ID: "1282135059",
    GITHUB_E2E_TOKEN: marker,
  };
  delete env.GITHUB_E2E_COMPILE_ONLY;
  const result = spawnSync(process.execPath, [
    resolve("scripts/run-github-e2e.mjs"), "--preflight-only", "--fresh-isolated-branch",
  ], { cwd: resolve("."), env, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /source repository/u);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(marker));
  assert.doesNotMatch(result.stdout, /Fresh isolated GitHub E2E branch|preflight passed/u);
});

test("credentialed runner requires expected target repository ID before execution", () => {
  const env = { ...process.env };
  delete env.GITHUB_E2E_ENV_FILE;
  env.GITHUB_E2E_OWNER = "owner";
  env.GITHUB_E2E_REPO = "repo";
  env.GITHUB_E2E_BRANCH = "local-e2e";
  env.GITHUB_E2E_TOKEN = "test-token";
  delete env.GITHUB_E2E_EXPECTED_REPO_ID;

  const result = spawnSync(process.execPath, [resolve("scripts/run-github-e2e.mjs")], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /GITHUB_E2E_EXPECTED_REPO_ID/u);
});
