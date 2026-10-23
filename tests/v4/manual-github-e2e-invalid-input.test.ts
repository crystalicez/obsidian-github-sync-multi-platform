import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// Test ONLY invalid inputs, which the launchers must reject before reading a
// token, resolving GitHub metadata, creating a branch, or running any E2E.
const SAFE_ENV = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const ROOT = process.cwd();

function launch(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    env: SAFE_ENV,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 12_000,
  });
  assert.equal(result.error, undefined, "The argument guard must exit promptly.");
  return result;
}

test("manual GitHub E2E launcher rejects missing and unknown scenarios before GitHub access", () => {
  for (const args of [
    [],
    ["--help"],
    ["main"],
    ["full", "--branch=main"],
    ["rename-plaintext", "--branch=master"],
    ["full", "--force"],
    ["rename-plaintext; rm -rf ."],
  ]) {
    const result = launch("scripts/run-github-e2e-disposable.mjs", args);
    assert.equal(result.status, 2, `Unexpected exit for ${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stderr, /Usage: node scripts\/run-github-e2e-disposable\.mjs/);
    assert.equal(result.stdout, "", "Rejected inputs must not reach remote preflight.");
  }
});

test("read-only branch verifier rejects default branches and path traversal without GitHub access", () => {
  for (const branch of [
    "main", "master", "production",
    "obsidian-sync-e2e/local-../../main",
    "obsidian-sync-e2e/local-demo/../../main",
    "refs/heads/main",
    "obsidian-sync-e2e/local-a%2f..%2fmain",
  ]) {
    const result = launch("scripts/check-github-e2e-branch-absence.mjs", [branch]);
    assert.notEqual(result.status, 0, `Untrusted verification target accepted: ${branch}`);
    assert.match(result.stderr, /Specify exactly one obsidian-sync-e2e\/local-/);
    assert.equal(result.stdout, "", "Rejected input must not be described as verified.");
  }
});

test("read-only verifier rejects ambiguous argument counts before GitHub access", () => {
  for (const args of [
    [], ["--help"], ["main", "master"],
    ["obsidian-sync-e2e/local-demo", "--delete"],
  ]) {
    const result = launch("scripts/check-github-e2e-branch-absence.mjs", args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Specify exactly one obsidian-sync-e2e\/local-/);
    assert.equal(result.stdout, "");
  }
});
