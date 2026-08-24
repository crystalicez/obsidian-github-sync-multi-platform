import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("GitHub E2E compile-only mode works through a shell-independent CLI flag", () => {
  const env = { ...process.env };
  delete env.GITHUB_E2E_COMPILE_ONLY;
  delete env.GITHUB_E2E_ENV_FILE;
  delete env.GITHUB_E2E_OWNER;
  delete env.GITHUB_E2E_REPO;
  delete env.GITHUB_E2E_BRANCH;
  delete env.GITHUB_E2E_TOKEN;

  const result = spawnSync(process.execPath, [resolve("scripts/run-github-e2e.mjs"), "--compile-only"], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /GitHub E2E bundle compiled:/u);
});
