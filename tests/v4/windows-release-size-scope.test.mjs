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
  assert.equal(baseline.physicalLargeFile.scope, "physical-windows-release-100mb-decimal");
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

test("Release readiness distinguishes the 100 MB gate from historical 5 GiB models", () => {
  const readiness = read("docs/engineering/production-release-readiness-2026-10-10.md");
  assert.match(readiness, /Windows 100 MB \(current release decision 2026-10-18\)/u);
  assert.match(readiness, /5 GiB physical test explicitly out of scope/u);
  const faq = read("docs/FAQ.md");
  assert.match(faq, /Windows 100 MB/u);
  assert.match(faq, /100,000,000 bytes/u);
});
