import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflow = resolve(".github/workflows/github-e2e-live.yml");

test("live workflow runs verified CI bundles without source build", async () => {
  const text = await readFile(workflow, "utf8");
  assert.match(text, /actions:\s*read/u);
  assert.match(text, /contents:\s*read/u);
  assert.doesNotMatch(text, /actions\/checkout@|pnpm\/action-setup@|pnpm install|pnpm build|run-github-e2e\.mjs/u);
  assert.match(text, /github-e2e-input-/u);
  assert.match(text, /E2E_REPO_ID/u);
  assert.match(text, /node --test --test-concurrency=1/u);
  assert.doesNotMatch(text, /^ {4}env:/mu);
});

test("receipt is blocking and before scenario execution", async () => {
  const text = await readFile(workflow, "utf8");
  const receipt = text.indexOf("Upload same-attempt qualification receipt");
  const execute = text.indexOf("Run verified real GitHub E2E bundles");
  assert.ok(receipt >= 0 && execute > receipt);
  assert.match(text, /github-e2e-target-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  const receiptBlock = text.slice(receipt, execute);
  assert.doesNotMatch(receiptBlock, /continue-on-error:\s*true/u);
  assert.match(receiptBlock, /include-hidden-files:\s*true/u);
});

test("cleanup re-proves target without qualify outputs", async () => {
  const text = await readFile(workflow, "utf8");
  assert.match(text, /if:\s*always\(\)/u);
  assert.ok((text.match(/environment:\s*github-e2e/gu) ?? []).length >= 2);
  assert.doesNotMatch(text, /needs\.qualify\.outputs/u);
  assert.match(text, /cleanup-only rerun may remove residue but is not release qualification/u);
});

test("cleanup uses documented exact-ref reads and a bounded 15 second verification deadline", async () => {
  const text = await readFile(workflow, "utf8");
  const cleanup = text.slice(text.indexOf("Delete and verify pinned disposable branch"));
  assert.match(cleanup, /const exactRead = \(\) => `\$\{base\}\/git\/ref\/heads\/\$\{encodeRef\(branch\)\}`/u);
  assert.match(cleanup, /const exactDelete = \(\) => `\$\{base\}\/git\/refs\/heads\/\$\{encodeRef\(branch\)\}`/u);
  assert.match(cleanup, /const cleanupDeadline = Date\.now\(\) \+ 15_000/u);
  assert.doesNotMatch(cleanup, /for \(let attempt = 1; attempt <= 3; attempt\+\+\)/u);
});
