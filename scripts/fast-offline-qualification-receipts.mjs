import { verifyOfflineFastTestOutput } from "./fast-offline-qualification-plan.mjs";

// Receipts are local, non-adversarial test evidence, NOT cryptographic proof.
// They are useful only with the complete matching plan and current source digest.
const FIELDS = Object.freeze([
  "schema", "sourceDigest", "taskLabel", "args", "files", "fileCount", "expectedNames", "passed",
]);
const digestIsValid = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function createOfflineFastTaskReceipt({ task, sourceDigest, status, stdout }) {
  if (!digestIsValid(sourceDigest) || !task || typeof task !== "object") {
    throw new Error("Offline Fast receipt requires a valid source fingerprint and planned task.");
  }
  const passed = verifyOfflineFastTestOutput({ task, status, stdout });
  return {
    schema: 1,
    sourceDigest,
    taskLabel: task.label,
    args: [...task.args],
    files: [...task.files],
    fileCount: task.fileCount,
    expectedNames: task.expectedNames === null ? null : [...task.expectedNames],
    passed,
  };
}

export function summarizeOfflineFastTaskReceipts(plan, sourceDigest, receipts) {
  if (!digestIsValid(sourceDigest) || !Array.isArray(plan?.tasks) || !plan.tasks.length
    || !Array.isArray(receipts) || receipts.length !== plan.tasks.length) {
    throw new Error("Incomplete Offline Fast qualification receipts; every planned task is required.");
  }
  const byLabel = new Map();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || !same(Object.keys(receipt).sort(), [...FIELDS].sort())
      || receipt.schema !== 1 || !digestIsValid(receipt.sourceDigest)
      || typeof receipt.taskLabel !== "string" || byLabel.has(receipt.taskLabel)) {
      throw new Error("Invalid or duplicate Offline Fast qualification receipt.");
    }
    byLabel.set(receipt.taskLabel, receipt);
  }
  let passed = 0;
  for (const task of plan.tasks) {
    const receipt = byLabel.get(task.label);
    if (!receipt || receipt.sourceDigest !== sourceDigest || receipt.taskLabel !== task.label
      || !same(receipt.args, task.args) || !same(receipt.files, task.files)
      || receipt.fileCount !== task.fileCount
      || !same(receipt.expectedNames, task.expectedNames)
      || !Number.isSafeInteger(receipt.passed) || receipt.passed < task.fileCount
      || (task.expectedNames !== null && receipt.passed !== task.expectedNames.length)) {
      throw new Error(`Offline Fast receipt missing or mismatched: ${task.label}.`);
    }
    passed += receipt.passed;
  }
  if (!Number.isSafeInteger(passed) || passed < plan.eligibleFiles) {
    throw new Error("Invalid Offline Fast qualification total.");
  }
  return { passed, eligibleFiles: plan.eligibleFiles, tasks: plan.tasks.length };
}
