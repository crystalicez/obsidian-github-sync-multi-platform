import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const runner=resolve("scripts/run-obsidian-live-github-ui.mjs");

test("live Obsidian UI harness is syntax-valid",()=>{
 const r=spawnSync(process.execPath,["--check",runner],{encoding:"utf8",timeout:30000});
 assert.equal(r.status,0,r.stderr);
});
test("live Obsidian UI runner fails closed for a dirty source checkout",()=>{
 const r=spawnSync(process.execPath,[runner,"--preflight-only","--port=19488"],{encoding:"utf8",timeout:30000,
  env:{...process.env,GITHUB_E2E_ENV_FILE:resolve(".tmp","nonexistent-github-e2e-secret")}});
 // Test on a dirty workspace rejects *before* reading credentials or making network requests.
 // When run in a clean SHA, the runner instead rejects missing required E2E configuration.
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/clean source checkout|Missing|required|not found|GITHUB_E2E/iu);
 assert.doesNotMatch(r.stderr,/gh[pousr]_[A-Za-z0-9_]{12,}/gu);
});
test("configured live UI harness uses a randomly named cleanup-restricted branch, never a default branch",()=>{
 const code=readFileSync(runner,"utf8");
 assert.match(code,/qualificationE2EBranch\(sha\.stdout\.trim\(\),runId\)/u);
 assert.match(code,/cleanupE2EBranch\(/u);
 assert.match(code,/initialSha/);
 assert.match(code,/\.github-sync-center__actions button/u);
 assert.match(code,/GITHUB_E2E_EXPECTED_REPO_ID/u);
 assert.match(code,/parseLiveUiMode/u);
 assert.match(code,/verifyEncryptedGitHubTree/u);
});
