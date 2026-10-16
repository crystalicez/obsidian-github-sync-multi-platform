import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const runner = resolve("scripts/run-ui-screenshots.mjs");

test("visual UI runner refuses a vault outside ignored repository .tmp", () => {
  const result = spawnSync(process.execPath, [runner, "--attach", "--vault=../non-synthetic-vault"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vault must be a child of .*\.tmp/u);
  assert.doesNotMatch(result.stdout, /screenshots|PASSED/u);
});

test("visual UI runner refuses invalid or unprivileged CDP ports before attaching", () => {
  const result = spawnSync(process.execPath, [runner, "--attach", "--port=99"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Valid isolated CDP port required/u);
});
