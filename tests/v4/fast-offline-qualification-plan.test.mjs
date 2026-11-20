import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotOfflineFastSource, requireOfflineFastSourceUnchanged, withUnchangedOfflineFastSource,
  OFFLINE_FAST_SOURCE_DIRS, OFFLINE_FAST_ROOT_FILES,
} from "../../scripts/fast-offline-source-fingerprint.mjs";

import { discoverTests, excludeSelectedTestFile } from "../../scripts/test-discovery.mjs";
import { createOfflineFastTaskReceipt, summarizeOfflineFastTaskReceipts } from "../../scripts/fast-offline-qualification-receipts.mjs";
import {
  collectHeavyFastTestNames,
  createOfflineFastQualificationPlan,
  HEAVY_FAST_TEST_FILE,
  HEAVY_TEST_COHORTS,
  verifyOfflineFastTestOutput,
  sanitizeOfflineFastChildEnvironment,
} from "../../scripts/fast-offline-qualification-plan.mjs";

const goodSummary = (passed, names = []) => [
  ...names.map(name => `✔ ${name} (1.23ms)`),
  `ℹ tests ${passed}`, `ℹ pass ${passed}`, "ℹ fail 0",
  "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0",
].join("\n");

test("D299 offline plan covers every discovered Fast file and every literal heavy case exactly once", async () => {
  const discovered = await discoverTests(process.cwd());
  const source = await readFile(HEAVY_FAST_TEST_FILE, "utf8");
  const plan = createOfflineFastQualificationPlan(discovered, source);
  assert.equal(plan.eligibleFiles, discovered.filter(item => item.tier === "fast").length);
  assert.equal(plan.ordinaryFiles + 1, plan.eligibleFiles);
  assert.equal(plan.heavyCases, 190, "unexpected heavy file test count needs explicit review");
  assert.equal(plan.tasks.length, 12 + HEAVY_TEST_COHORTS.length);
  const ordinary = plan.tasks.slice(0, 12).flatMap(task => task.files);
  assert.equal(ordinary.length, plan.ordinaryFiles);
  assert.equal(new Set(ordinary).size, ordinary.length);
  assert.ok(ordinary.every(file => file !== HEAVY_FAST_TEST_FILE));
  const named = plan.tasks.slice(12).flatMap(task => task.expectedNames);
  assert.equal(named.length, plan.heavyCases);
  assert.equal(new Set(named).size, named.length);
  assert.deepEqual(named.slice().sort(), collectHeavyFastTestNames(source).slice().sort());
  assert.ok(plan.tasks.every(task => task.files.length === task.fileCount));
  const bounded = plan.tasks.filter(task => /^D23[0-9]$/u.test(task.label));
  assert.ok(bounded.length >= 8, "D230–239 must be split into bounded, individually rerunnable cases");
  assert.ok(bounded.every(task => task.expectedNames.length > 0 && task.expectedNames.length <= 10),
    "a formerly 45-case D23 cohort must never timeout as one uninterruptible qualification task");
});

test("D441 resumable Offline Fast requires complete, source-matched, exact-plan receipts", async () => {
  const discovered = await discoverTests(process.cwd());
  const heavySource = await readFile(HEAVY_FAST_TEST_FILE, "utf8");
  const plan = createOfflineFastQualificationPlan(discovered, heavySource);
  const digest = "a".repeat(64);
  const receipts = plan.tasks.map(task => {
    const names = task.expectedNames ?? [];
    const count = task.expectedNames === null ? task.fileCount : names.length;
    return createOfflineFastTaskReceipt({ task, sourceDigest: digest,
      status: 0, stdout: goodSummary(count, names) });
  });
  const result = summarizeOfflineFastTaskReceipts(plan, digest, receipts);
  assert.equal(result.tasks, plan.tasks.length);
  assert.equal(result.eligibleFiles, plan.eligibleFiles);
  assert.equal(result.passed, receipts.reduce((total, receipt) => total + receipt.passed, 0));

  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, receipts.slice(1)), /Incomplete/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, "b".repeat(64), receipts), /mismatched/u);
  const changed = (index, patch) => receipts.map((receipt, at) => at === index ? { ...receipt, ...patch } : receipt);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { passed: 0 })), /mismatched/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { sourceDigest: "b".repeat(64) })), /mismatched/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { taskLabel: receipts[1].taskLabel })), /duplicate/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { args: ["--tier=fast"] })), /mismatched/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { files: [] })), /mismatched/u);
  assert.throws(() => summarizeOfflineFastTaskReceipts(plan, digest, changed(0, { skipped: 1 })), /Invalid/u);
  const heavyTask = plan.tasks.find(task => task.expectedNames !== null);
  assert.ok(heavyTask);
  assert.throws(() => createOfflineFastTaskReceipt({ task: heavyTask, sourceDigest: digest,
    status: 0, stdout: goodSummary(heavyTask.expectedNames.length, heavyTask.expectedNames).replace("ℹ skipped 0", "ℹ skipped 1") }),
  /did not pass/u);
});

test("D299 qualification plan fails closed on missing, duplicated or unsupported heavy cases", () => {
  const discovered = [
    { path: HEAVY_FAST_TEST_FILE, tier: "fast" },
    { path: "tests/v4/a.test.ts", tier: "fast" },
    { path: "tests/v4/b.test.ts", tier: "fast" },
  ];
  const source = [
    'test("D83 simple", () => {})',
    'test("D220 distinct", () => {})',
    ...[230, 231, 232, 233, 234, 235, 236, 238, 239].map(n =>
      `test("D${n} distinct", () => {})`),
    'test("D240 distinct", () => {})',
    'test("D250 distinct", () => {})',
    'test("D368 explicit", () => {})',
  ].join("\n");
  const valid = createOfflineFastQualificationPlan(discovered, source, 2);
  assert.equal(valid.tasks.length, 2 + HEAVY_TEST_COHORTS.length);
  assert.throws(() => createOfflineFastQualificationPlan(discovered.slice(1), source, 2), /exactly once/u);
  assert.throws(() => createOfflineFastQualificationPlan([...discovered, discovered[0]], source, 2), /duplicate/u);
  assert.throws(() => collectHeavyFastTestNames(source + '\ntest("D300 newer", () => {})'), /Unclassified/u);
  assert.throws(() => collectHeavyFastTestNames(source + '\ntest("D369 newer", () => {})'), /Unclassified/u);
  assert.throws(() => collectHeavyFastTestNames(source + '\ntest("D83 simple", () => {})'), /Duplicate/u);
  assert.throws(() => collectHeavyFastTestNames(source + '\ntest.skip("D251 disabled", () => {})'), /nonliteral/u);
  assert.throws(() => collectHeavyFastTestNames(source + '\ntest(title, () => {})'), /nonliteral/u);
  assert.throws(() => createOfflineFastQualificationPlan(discovered, source, 3), /Invalid number/u);
});

test("D299 offline parser rejects skip, fewer passes, bad status and missing summary", () => {
  const task = { label: "D230-239", fileCount: 1, expectedNames: ["D230 exact"] };
  assert.equal(verifyOfflineFastTestOutput({
    status: 0, stdout: goodSummary(1, ["D230 exact"]), task,
  }), 1);
  for (const [status, stdout] of [
    [1, goodSummary(1, ["D230 exact"])],
    [0, goodSummary(1, ["D230 missing"])],
    [0, goodSummary(2, ["D230 exact", "D231 extra"])],
    [0, goodSummary(1, ["D230 exact"]).replace("ℹ skipped 0", "ℹ skipped 1")],
    [0, goodSummary(1, ["D230 exact"]).replace("ℹ pass 1", "ℹ pass 0")],
    [0, "✔ D230 exact (1ms)"],
    [0, goodSummary(1, ["D230 exact"]) + "\nℹ pass 1"],
  ]) {
    assert.throws(() => verifyOfflineFastTestOutput({ status, stdout, task }));
  }
  const shard = { label: "files-1", fileCount: 2, expectedNames: null };
  assert.throws(() => verifyOfflineFastTestOutput({ status: 0, stdout: goodSummary(1), task: shard }),
    /did not pass/u);
  assert.equal(verifyOfflineFastTestOutput({ status: 0, stdout: goodSummary(3), task: shard }), 3);
});

test("D302 offline Fast child environment strips credential aliases without mutating caller environment", () => {
  const source = {
    PATH: "C:\\Tools",
    TEMP: "C:\\Temp",
    CI: "true",
    GITHUB_E2E_TOKEN: "secret",
    github_pat: "secret",
    gh_token: "secret",
    GITHUB_API_TOKEN: "secret",
    CUSTOM_ACCESS_TOKEN: "secret",
    SECRET_TOKEN: "secret",
    service_password: "secret",
    API_KEY: "secret",
    aws_access_key_id: "secret",
    SSH_AUTH_SOCK: "secret",
  };
  const child = sanitizeOfflineFastChildEnvironment(source);
  assert.deepEqual(child, { PATH: "C:\\Tools", TEMP: "C:\\Temp", CI: "true" });
  assert.equal(source.GITHUB_E2E_TOKEN, "secret", "parent environment must not be changed");
  assert.notEqual(child, source);
  assert.throws(() => sanitizeOfflineFastChildEnvironment(null), /environment/i);
});

test("D304 offline Fast children omit inherited npm and Git authentication configuration", () => {
  const parent = {
    PATH: "runtime",
    CI: "true",
    NPM_CONFIG__AUTH: "registry-credential",
    npm_config_userconfig: "path-to-private-npmrc",
    GIT_ASKPASS: "credential-helper",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: secret",
    GIT_SSH_COMMAND: "ssh -i private-key",
  };
  const child = sanitizeOfflineFastChildEnvironment(parent);
  assert.deepEqual(child, { PATH: "runtime", CI: "true" });
  assert.equal(parent.GIT_CONFIG_VALUE_0, "Authorization: secret");
});

test("D305 offline Fast child runtime ignores inherited Node preloads and module lookup paths", () => {
  const parent = {
    PATH: "runtime",
    CI: "true",
    NODE_OPTIONS: "--require ./unrelated-preload.cjs",
    node_options: "--import ./other-unrelated-module.mjs",
    NODE_PATH: "C:\\unrelated-modules",
    NODE_V8_COVERAGE: "C:\\outside-coverage",
  };
  const child = sanitizeOfflineFastChildEnvironment(parent);
  assert.deepEqual(child, { PATH: "runtime", CI: "true" });
  assert.equal(parent.NODE_OPTIONS, "--require ./unrelated-preload.cjs");
});

test("D300 default offline fingerprint covers Fast inputs including bundled JS, docs and version metadata", () => {
  assert.ok(OFFLINE_FAST_SOURCE_DIRS.includes("docs"));
  for (const file of ["main.js", "styles.css", "versions.json", "package.json", "pnpm-lock.yaml",
    "tsconfig.json", "tsconfig.maximum-strict.json", "tsconfig.github-e2e-strict.json"]) {
    assert.ok(OFFLINE_FAST_ROOT_FILES.includes(file), `Missing source input: ${file}`);
  }
});

test("D388 E2E Maximum Strict input is pinned by Fast qualification and cannot silently drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "d388-e2e-strict-fingerprint-"));
  const filename = "tsconfig.github-e2e-strict.json";
  const options = { root, sourceDirs: ["src"], rootFiles: [filename] };
  const original = '{"extends":"./tsconfig.maximum-strict.json","include":["tests/github-e2e/a.ts"]}';
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, filename), original);
    const baseline = await snapshotOfflineFastSource(options);
    await requireOfflineFastSourceUnchanged(options, baseline);
    // Changing one E2E typecheck input must invalidate the source receipt,
    // even when no Production file, package.json or Fast test is modified.
    await writeFile(join(root, filename), original.replace("a.ts", "b.ts"));
    await assert.rejects(requireOfflineFastSourceUnchanged(options, baseline), error => {
      assert.match(error.message, /source changed.*tsconfig\.github-e2e-strict\.json/iu);
      return true;
    });
    await writeFile(join(root, filename), original);
    await requireOfflineFastSourceUnchanged(options, baseline);
    await rm(join(root, filename));
    await assert.rejects(snapshotOfflineFastSource(options), /ENOENT|no such file/iu,
      "Missing dedicated E2E Strict config cannot produce a qualified snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D388 E2E Strict config retains every GitHub entrypoint and Production-level strictness", async () => {
  const config = JSON.parse(await readFile("tsconfig.github-e2e-strict.json", "utf8"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(config.extends, "./tsconfig.maximum-strict.json");
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.target, "ES2022");
  assert.equal(config.compilerOptions.module, "ESNext");
  for (const key of ["strict", "exactOptionalPropertyTypes", "noUncheckedIndexedAccess",
    "noUnusedLocals", "noUnusedParameters", "noPropertyAccessFromIndexSignature",
    "skipLibCheck", "noEmitOnError"]) {
    assert.equal(Object.hasOwn(config.compilerOptions, key), false,
      "E2E Strict must inherit the parent policy without local overrides: " + key);
  }
  assert.deepEqual(new Set(config.include), new Set([
    "tests/github-e2e/v4-real-github-e2e.test.ts",
    "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
    "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
    "tests/github-e2e/obsidian-runtime-stub.d.ts",
  ]));
  assert.equal(pkg.scripts["typecheck:github-e2e"],
    "tsc --noEmit --project tsconfig.github-e2e-strict.json");
  assert.ok(OFFLINE_FAST_ROOT_FILES.includes("tsconfig.github-e2e-strict.json"));
});

test("D300 source fingerprint rejects changes between offline Fast qualification shards", async () => {
  const root = await mkdtemp(join(tmpdir(), "d300-fast-fingerprint-"));
  const options = { root, sourceDirs: ["src", "scripts", "tests", "docs"], rootFiles: ["package.json", "main.js", "styles.css", "versions.json"] };
  try {
    for (const dir of options.sourceDirs) await mkdir(join(root, dir));
    await writeFile(join(root, "src", "engine.ts"), "export const engine = 1");
    await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 1");
    await writeFile(join(root, "tests", "engine.test.ts"), 'test("engine", () => {})');
    await mkdir(join(root, "docs", "release-gates"), { recursive: true });
    await writeFile(join(root, "docs", "release-gates", "reencryption-wizard.json"), '{"status":"blocked"}');
    await writeFile(join(root, "package.json"), '{"version":"test"}');
    await writeFile(join(root, "main.js"), "original bundle");
    await writeFile(join(root, "styles.css"), "original stylesheet");
    await writeFile(join(root, "versions.json"), '{"1.0.8":"1.11.4"}');
    const fingerprint = await snapshotOfflineFastSource(options);
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    // Empty legacy folders are observable by Fast tests and must invalidate the snapshot.
    await mkdir(join(root, "src", "empty-legacy"));
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i,
      "new empty folder must invalidate a qualification");
    await rm(join(root, "src", "empty-legacy"), { recursive: true });
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "src", "engine.ts"), "export const engine = 2");
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await writeFile(join(root, "src", "engine.ts"), "export const engine = 1");
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "tests", "new.test.ts"), 'test("new", () => {})');
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await rm(join(root, "tests", "new.test.ts"));
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "package.json"), '{"version":"changed"}');
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await writeFile(join(root, "package.json"), '{"version":"test"}');
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "main.js"), "changed bundle");
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await writeFile(join(root, "main.js"), "original bundle");
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "docs", "release-gates", "reencryption-wizard.json"), '{"status":"qualified"}');
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await writeFile(join(root, "docs", "release-gates", "reencryption-wizard.json"), '{"status":"blocked"}');
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await writeFile(join(root, "versions.json"), '{"1.0.9":"1.11.4"}');
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
    await writeFile(join(root, "versions.json"), '{"1.0.8":"1.11.4"}');
    await requireOfflineFastSourceUnchanged(options, fingerprint);
    await rm(join(root, "scripts", "runner.mjs"));
    await assert.rejects(requireOfflineFastSourceUnchanged(options, fingerprint), /source changed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D320 source qualification diagnostics identify changed paths without displaying source contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "d320-offline-fingerprint-forensics-"));
  const options = { root, sourceDirs: ["src"], rootFiles: ["package.json"] };
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "source.ts"), "original-private-file-contents");
    await writeFile(join(root, "package.json"), '{"privateValue":"original-private-package"}');
    const baseline = await snapshotOfflineFastSource(options);
    await writeFile(join(root, "src", "source.ts"), "secret-can-never-appear-in-error");
    await assert.rejects(requireOfflineFastSourceUnchanged(options, baseline), error => {
      assert.match(error.message, /source changed.*src\/source\.ts/iu);
      assert.doesNotMatch(error.message, /secret-can-never-appear-in-error|original-private-file-contents/iu);
      return true;
    });
    await writeFile(join(root, "src", "source.ts"), "original-private-file-contents");
    await mkdir(join(root, "src", "new-empty-directory"));
    await assert.rejects(requireOfflineFastSourceUnchanged(options, baseline),
      /source changed.*src\/new-empty-directory/iu);
    await rm(join(root, "src", "new-empty-directory"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"privateValue":"secret-value-never-logged"}');
    await assert.rejects(requireOfflineFastSourceUnchanged(options, baseline), error => {
      assert.match(error.message, /source changed.*package\.json/iu);
      assert.doesNotMatch(error.message, /secret-value-never-logged/iu);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D300 offline Fast task guard refuses changed source before running and after running", async () => {
  const root = await mkdtemp(join(tmpdir(), "d300-fast-task-"));
  const options = { root, sourceDirs: ["src"], rootFiles: ["package.json"] };
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "source.ts"), "safe");
    await writeFile(join(root, "package.json"), "{}");
    const baseline = await snapshotOfflineFastSource(options);
    let started = 0;
    const good = await withUnchangedOfflineFastSource(options, baseline, async () => {
      started += 1;
      return 42;
    });
    assert.equal(good, 42);
    assert.equal(started, 1);
    await assert.rejects(withUnchangedOfflineFastSource(options, baseline, async () => {
      started += 1;
      await writeFile(join(root, "src", "source.ts"), "modified after test start");
      return 42;
    }), /source changed/i);
    assert.equal(started, 2);
    await assert.rejects(withUnchangedOfflineFastSource(options, baseline, () => {
      started += 1;
      return 42;
    }), /source changed/i);
    assert.equal(started, 2, "preflight mismatch must prevent test command execution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D299 exact-file exclusion requires a real selected path rather than silently skipping coverage", () => {
  const selected = [{ path: HEAVY_FAST_TEST_FILE }, { path: "tests/v4/ordinary.test.ts" }];
  assert.deepEqual(excludeSelectedTestFile(selected, HEAVY_FAST_TEST_FILE), [selected[1]]);
  assert.deepEqual(excludeSelectedTestFile(selected, ""), selected);
  assert.throws(() => excludeSelectedTestFile(selected, "missing.test.ts"), /exactly once/u);
  assert.throws(() => excludeSelectedTestFile([...selected, selected[0]], HEAVY_FAST_TEST_FILE), /exactly once/u);
});
