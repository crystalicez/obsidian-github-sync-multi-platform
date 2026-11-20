import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverTests } from "./test-discovery.mjs";
import {
  snapshotOfflineFastSource, requireOfflineFastSourceUnchanged, withUnchangedOfflineFastSource,
} from "./fast-offline-source-fingerprint.mjs";
import { createOfflineFastTaskReceipt, summarizeOfflineFastTaskReceipts } from "./fast-offline-qualification-receipts.mjs";
import { createOfflineFastQualificationPlan, HEAVY_FAST_TEST_FILE,
  sanitizeOfflineFastChildEnvironment } from "./fast-offline-qualification-plan.mjs";

// Local-only test qualification. No GitHub API, remote writes, or release tags.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const runner = path.join(root, "scripts", "run-tests.mjs");
const args = process.argv.slice(2);
const selected = args.length === 1 && args[0]?.startsWith("--task=")
  ? args[0].slice("--task=".length) : null;
if (args.length > 1 || (args.length === 1
  && args[0] !== "--plan" && args[0] !== "--finalize" && selected === null)) {
  throw new Error("Usage: node scripts/run-fast-offline-qualified.mjs [--plan|--task=LABEL|--finalize]");
}
const dryRun = args.includes("--plan");
const finalize = args.includes("--finalize");
const sourceOptions = { root };
const sourceBaseline = await snapshotOfflineFastSource(sourceOptions);
const discovered = await discoverTests(root);
const heavySource = await readFile(path.join(root, HEAVY_FAST_TEST_FILE), "utf8");
const plan = createOfflineFastQualificationPlan(discovered, heavySource);
await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
const receiptRoot = path.join(root, ".tmp", "offline-fast-receipts", sourceBaseline.digest);
function receiptPath(task) {
  // Receipt names come ONLY from the verified coverage plan, never a raw CLI path.
  if (!/^[A-Za-z0-9-]+$/u.test(task.label)) throw new Error("Invalid Offline Fast task label.");
  return path.join(receiptRoot, task.label + ".json");
}
async function requireSafeReceiptDirectories() {
  const dirs = [path.join(root, ".tmp"), path.join(root, ".tmp", "offline-fast-receipts"), receiptRoot];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Offline Fast receipt directory.");
  }
}
async function storeReceipt(task, receipt) {
  await requireSafeReceiptDirectories();
  const destination = receiptPath(task);
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(receipt) + "\n", { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    // A failed rename may leave a private .tmp file; remove only the filename
    // allocated by this invocation, never a previous verified task receipt.
    await rm(temporary, { force: true });
  }
}
async function readReceipt(task) {
  try {
    return JSON.parse(await readFile(receiptPath(task), "utf8"));
  } catch {
    throw new Error(`Offline Fast receipt unavailable or invalid for ${task.label}; rerun that exact task.`);
  }
}
if (dryRun) {
  console.log(`Offline Fast plan: ${plan.eligibleFiles} files, ${plan.ordinaryFiles} ordinary files, ${plan.heavyCases} heavy test cases.`);
  for (const task of plan.tasks) {
    console.log(`${task.label}: files=${task.fileCount}${task.expectedNames ? ` cases=${task.expectedNames.length}` : ""}`);
  }
} else if (finalize) {
  // A partial task, old source version or malformed receipt must NEVER
  // produce a full-suite qualification line.
  const receipts = [];
  for (const task of plan.tasks) receipts.push(await readReceipt(task));
  const summary = summarizeOfflineFastTaskReceipts(plan, sourceBaseline.digest, receipts);
  await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
  console.log(`Offline Fast qualified: ${summary.passed} passing test cases across all ${summary.eligibleFiles} Fast files; no skipped tests; source fingerprint=${sourceBaseline.digest}.`);
} else {
  const tasks = selected === null ? plan.tasks : plan.tasks.filter(task => task.label === selected);
  if (!tasks.length) throw new Error("Unknown Offline Fast task label; use --plan.");
  // Keep OS/runtime variables, not credentials from this maintainer process.
  // This does not make test code safe to run if it is untrusted.
  const env = sanitizeOfflineFastChildEnvironment(process.env);
  const receipts = [];
  for (const task of tasks) {
    console.log(`Running offline Fast ${task.label}...`);
    const result = await withUnchangedOfflineFastSource(sourceOptions, sourceBaseline, () =>
      spawnSync(process.execPath, [runner, ...task.args], {
        cwd: root, env, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
      }));
    if (result.error || result.status !== 0) {
      throw new Error(`Offline Fast ${task.label} failed (no suite qualification).`);
    }
    const receipt = createOfflineFastTaskReceipt({
      task, sourceDigest: sourceBaseline.digest, status: result.status, stdout: result.stdout,
    });
    await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
    await storeReceipt(task, receipt);
    receipts.push(receipt);
    console.log(`Offline Fast ${task.label}: ${receipt.passed} tests passed; receipt saved for this exact source.`);
  }
  await requireOfflineFastSourceUnchanged(sourceOptions, sourceBaseline);
  if (selected !== null) {
    console.log(`Offline Fast partial: ${selected} passed. NOT full-suite qualified; run all plan tasks and --finalize.`);
  } else {
    const summary = summarizeOfflineFastTaskReceipts(plan, sourceBaseline.digest, receipts);
    console.log(`Offline Fast qualified: ${summary.passed} passing test cases across all ${summary.eligibleFiles} Fast files; no skipped tests; source fingerprint=${sourceBaseline.digest}.`);
  }
}
