import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverTests } from "./test-discovery.mjs";
import {
  snapshotOfflineFastSource, requireOfflineFastSourceUnchanged, withUnchangedOfflineFastSource,
} from "./fast-offline-source-fingerprint.mjs";
import { createOfflineFastQualificationPlan, HEAVY_FAST_TEST_FILE,
  sanitizeOfflineFastChildEnvironment, verifyOfflineFastTestOutput } from "./fast-offline-qualification-plan.mjs";

// Local-only test qualification. No GitHub API, remote writes, or release tags.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = path.join(root, "scripts", "run-tests.mjs");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--plan") || args.filter(arg => arg === "--plan").length > 1) {
  throw new Error("Usage: node scripts/run-fast-offline-qualified.mjs [--plan]");
}
const dryRun = args.includes("--plan");
const sourceOptions = { root };
const sourceBaseline = await snapshotOfflineFastSource(sourceOptions);
const discovered = await discoverTests(root);
const heavySource = await readFile(path.join(root, HEAVY_FAST_TEST_FILE), "utf8");
const plan = createOfflineFastQualificationPlan(discovered, heavySource);
await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
if (dryRun) {
  console.log(`Offline Fast plan: ${plan.eligibleFiles} files, ${plan.ordinaryFiles} ordinary files, ${plan.heavyCases} heavy test cases.`);
  for (const task of plan.tasks) {
    console.log(`${task.label}: files=${task.fileCount}${task.expectedNames ? ` cases=${task.expectedNames.length}` : ""}`);
  }
} else {
  // Keep OS/runtime variables, not credentials from this maintainer process.
  // This does not make test code safe to run if it is untrusted.
  const env = sanitizeOfflineFastChildEnvironment(process.env);
  let passed = 0;
  for (const task of plan.tasks) {
    console.log(`Running offline Fast ${task.label}...`);
    const result = await withUnchangedOfflineFastSource(sourceOptions, sourceBaseline, () =>
      spawnSync(process.execPath, [runner, ...task.args], {
        cwd: root, env, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
      }));
    if (result.error || result.status !== 0) {
      throw new Error(`Offline Fast ${task.label} failed (no suite qualification).`);
    }
    const count = verifyOfflineFastTestOutput({ status: result.status, stdout: result.stdout, task });
    passed += count;
    console.log(`Offline Fast ${task.label}: ${count} tests passed.`);
  }
  await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
  console.log(`Offline Fast qualified: ${passed} passing test cases across all ${plan.eligibleFiles} Fast files; no skipped tests; source fingerprint=${sourceBaseline.digest}.`);
}
