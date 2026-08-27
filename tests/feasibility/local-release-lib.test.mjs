import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALIFICATION_GATES,
  createQualificationReceipt,
  qualificationRefName,
  qualificationTagName,
  runPnpmGate,
  serializeQualificationReceipt,
  validateQualificationReceipt,
} from "../../scripts/local-release-lib.mjs";

const sha = "a".repeat(40);
const validReceiptInput = {
  sha,
  version: "1.0.8",
  qualifiedAt: "2026-08-27T00:00:00.000Z",
  durationMs: 1234,
  platform: "linux-x64",
  nodeVersion: "v22.11.0",
  pnpmVersion: "9.12.3",
};
const expected = { sha, version: "1.0.8", nodeVersion: "v22.11.0", pnpmVersion: "9.12.3" };

test("qualification naming binds version and full SHA", () => {
  assert.equal(qualificationTagName("1.0.8", sha), `qualification/local/v1/1.0.8/${sha}`);
  assert.equal(qualificationRefName("1.0.8", sha), `refs/tags/qualification/local/v1/1.0.8/${sha}`);
  assert.throws(() => qualificationTagName("v1.0.8", sha), /version/i);
  assert.throws(() => qualificationTagName("1.0.8", "abc"), /40-hex/i);
});

test("receipt serialization is deterministic and ends with one newline", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  const first = serializeQualificationReceipt(receipt);
  const second = serializeQualificationReceipt(receipt);
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.ok(!first.endsWith("\n\n"));
  assert.deepEqual(receipt.gates, QUALIFICATION_GATES);
  assert.doesNotThrow(() => validateQualificationReceipt(receipt, expected));
});

test("receipt field insertion order is not authority", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  assert.doesNotThrow(() => validateQualificationReceipt(reordered, expected));
});

test("receipt requires exact ordered v1 gate array and exact schema fields", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  for (const gates of [
    [...receipt.gates].reverse(),
    receipt.gates.slice(1),
    [...receipt.gates, "extra"],
    [...receipt.gates, receipt.gates.at(-1)],
  ]) assert.throws(() => validateQualificationReceipt({ ...receipt, gates }, expected), /gates/i);
  assert.throws(() => validateQualificationReceipt({ ...receipt, extra: true }, expected), /fields/i);
});

test("receipt rejects wrong authority fields", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  const cases = [
    [{ ...receipt, schemaVersion: 2 }, /schemaVersion/i],
    [{ ...receipt, kind: "other" }, /kind/i],
    [{ ...receipt, repository: "other/repo" }, /repository/i],
    [{ ...receipt, commitSha: "b".repeat(40) }, /commit SHA/i],
    [{ ...receipt, version: "1.0.9" }, /version/i],
    [{ ...receipt, result: "failure" }, /result/i],
    [{ ...receipt, nodeVersion: "v22.12.0" }, /Node version/i],
    [{ ...receipt, pnpmVersion: "10.0.0" }, /pnpm version/i],
    [{ ...receipt, e2eSuite: "other" }, /E2E suite/i],
  ];
  for (const [value, pattern] of cases) assert.throws(() => validateQualificationReceipt(value, expected), pattern);
});

test("receipt validates audit field syntax", () => {
  const receipt = createQualificationReceipt(validReceiptInput);
  for (const [value, pattern] of [
    [{ ...receipt, qualifiedAt: "yesterday" }, /qualifiedAt/i],
    [{ ...receipt, qualifiedAt: "2026-08-27T00:00:00Z" }, /qualifiedAt/i],
    [{ ...receipt, durationMs: -1 }, /durationMs/i],
    [{ ...receipt, durationMs: 1.5 }, /durationMs/i],
    [{ ...receipt, platform: "" }, /platform/i],
    [{ ...receipt, platform: "linux x64" }, /platform/i],
  ]) assert.throws(() => validateQualificationReceipt(value, expected), pattern);
});

test("Windows gate construction uses only a fixed allowlisted shell string", () => {
  const calls = [];
  const runner = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: "", stderr: "" }; };
  runPnpmGate("github-e2e-live", {
    cwd: "C:\\repo",
    env: { GITHUB_E2E_BRANCH: "evil & echo pwned", GITHUB_E2E_TOKEN: "secret" },
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe",
    runner,
  });
  assert.deepEqual(calls[0].args, ["/d", "/s", "/c", "corepack pnpm test:github-e2e:quick"]);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\cmd.exe");
  assert.doesNotMatch(calls[0].args.at(-1), /evil|secret/u);
});

test("POSIX gate construction uses shell-free corepack argv", () => {
  const calls = [];
  const runner = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  runPnpmGate("install-frozen", { cwd: "/repo", env: {}, platform: "linux", runner });
  assert.equal(calls[0].command, "corepack");
  assert.deepEqual(calls[0].args, ["pnpm", "install", "--frozen-lockfile"]);
  assert.throws(() => runPnpmGate("not-a-gate", { runner }), /unknown pnpm gate/i);
});
