import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = relative => readFileSync(path.join(root, relative), "utf8");

test("Windows physical release gate requires exactly 100 MB and remains unverified", () => {
  const baseline = JSON.parse(read("tests/baselines/v4/windows.json"));
  assert.equal(baseline.physicalLargeFile.logicalBytes, 100_000_000);
  assert.equal(baseline.physicalLargeFile.scope, "physical-windows-100mb-decimal");
  assert.equal(baseline.physicalLargeFile.status, "pending");
  assert.equal(baseline.physicalLargeFile.classification, null);
  assert.equal(baseline.physicalLargeFile.sourceSha256, null);
  assert.equal(baseline.physicalLargeFile.pulledSha256, null);
  // Historical virtual load testing is not a physical acceptance result.
  assert.equal(baseline.task15AutomatedGate.soak.measurementClass, "automated-virtual-stream");
});

test("Windows physical procedure generates 100 MB with safe create-only I/O", () => {
  const doc = read("docs/testing/v4-windows-android-validation.md");
  assert.match(doc, /Windows 100 MB physical qualification/u);
  assert.match(doc, /\$Total = \[int64\]100000000/u);
  assert.match(doc, /FileMode\]::CreateNew/u);
  assert.match(doc, /Test file size mismatch/u);
  assert.match(doc, /Force Pull into a clean vault/u);
  assert.match(doc, /SHA-256 must exactly match/u);
  assert.doesNotMatch(doc, /qualification-5gib\.bin/u);
});

test("All active generated-file and soak commands cap tests at 100 MB", () => {
  const runner = read("scripts/run-soak.mjs");
  const soakTest = read("tests/soak/v4-100mb-stream.test.ts");
  const local = read("scripts/test-windows-100mb.mjs");
  const models = read("scripts/model-github-v4-large-file.mjs");
  assert.match(runner, /MAX_TEST_BYTES = 100_000_000/u);
  assert.match(soakTest, /MAX_TEST_BYTES = 100_000_000/u);
  assert.match(local, /BYTES = 100_000_000/u);
  assert.match(models, /MAX_TEST_BYTES = 100_000_000/u);
  assert.doesNotMatch(runner, /5 \* GiB|2 \* GiB/u);
});

test("Oversized soak requests are rejected before test execution", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const bytes of ["100000001", "5368709120"]) {
    const result = spawnSync(process.execPath, ["scripts/run-soak.mjs", `--bytes=${bytes}`], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(result.status, 2, `oversized soak ${bytes} must fail closed`);
    assert.match(result.stderr, /no larger than 100000000 bytes/u);
  }
});

test("Release readiness enforces the permanent 100 MB test ceiling", () => {
  const readiness = read("docs/engineering/production-release-readiness-2026-10-10.md");
  assert.match(readiness, /Windows 100 MB \(permanent test limit since 2026-10-18\)/u);
  assert.match(readiness, /100,000,000 bytes/u);
  const faq = read("docs/FAQ.md");
  assert.match(faq, /Windows 100 MB/u);
  assert.match(faq, /100,000,000 bytes/u);
});
