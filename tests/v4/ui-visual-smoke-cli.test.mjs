import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";

const runner = resolve("scripts/run-ui-screenshots.mjs");
const ownedTmp = resolve(".tmp");
// A frozen-install clean checkout has no ignored .tmp yet. Do not rely on
// previous runs to create it, and never follow a substituted symlink/junction.
mkdirSync(ownedTmp, { recursive: true });
const tmpInfo = lstatSync(ownedTmp);
assert.ok(tmpInfo.isDirectory() && !tmpInfo.isSymbolicLink(), "UI fixture root must be a real project-local directory");

test("visual UI runner refuses a vault outside ignored repository .tmp", () => {
  const result = spawnSync(process.execPath, [runner, "--attach", "--vault=../non-synthetic-vault"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vault must be a child of .*\.tmp/u);
  assert.doesNotMatch(result.stdout, /screenshots|PASSED/u);
});


test("visual UI runner will not replace an existing folder in project .tmp", () => {
  const directory = mkdtempSync(resolve(".tmp", "ui-runner-guard-"));
  const sentinel = join(directory, "keep.txt");
  writeFileSync(sentinel, "do not modify");
  try {
    const result = spawnSync(process.execPath, [runner, "--launch", "--port=19371", `--vault=${directory}`, `--profile=${directory}-profile`], {cwd:process.cwd(),encoding:"utf8"});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST|file already exists/iu);
    assert.equal(readFileSync(sentinel,"utf8"), "do not modify");
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test("attach requires a preexisting synthetic runner fixture marker before CDP access", () => {
  const directory = mkdtempSync(resolve(".tmp", "ui-runner-attach-"));
  try {
    const result = spawnSync(process.execPath, [runner, "--attach", "--port=19372", `--vault=${directory}`], {cwd:process.cwd(),encoding:"utf8"});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT|screenshot-fixture/u);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test("visual UI runner refuses invalid or unprivileged CDP ports before attaching", () => {
  const result = spawnSync(process.execPath, [runner, "--attach", "--port=99"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Valid isolated CDP port required/u);
});
