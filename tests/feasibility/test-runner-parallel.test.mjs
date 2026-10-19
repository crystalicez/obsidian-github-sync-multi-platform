import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function startTier(tier, filter) {
  return new Promise((resolve, reject) => {
    const processRef = spawn(process.execPath,
      ["scripts/run-tests.mjs", `--tier=${tier}`, `--filter=${filter}`],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
    let tail = "";
    for (const stream of [processRef.stdout, processRef.stderr]) {
      stream.on("data", data => { tail = (tail + String(data)).slice(-8_192); });
    }
    processRef.once("error", reject);
    processRef.once("close", (code, signal) => resolve({ tier, code, signal, tail }));
  });
}

test("parallel test tiers keep their bundle directories isolated and do not remove an existing .tmp/tests marker", {
  timeout: 120_000,
}, async () => {
  const oldOutput = path.join(root, ".tmp", "tests");
  await mkdir(oldOutput, { recursive: true });
  const found = await lstat(oldOutput);
  assert.ok(found.isDirectory() && !found.isSymbolicLink(), "Never write to linked historical test output.");
  const marker = path.join(oldOutput, `preserve-${process.pid}-${randomBytes(6).toString("hex")}.txt`);
  const markerHandle = await open(marker, "wx");
  try {
    await markerHandle.writeFile("parallel runner must never delete this preexisting marker");
  } finally {
    await markerHandle.close();
  }
  try {
    const runs = await Promise.all([
      startTier("fast", "protocol-contract"),
      startTier("feasibility", "phase0-models"),
    ]);
    for (const result of runs) {
      assert.equal(result.code, 0, `Parallel ${result.tier} failed (${result.signal}): ${result.tail}`);
      assert.equal(result.signal, null);
    }
    assert.equal(await readFile(marker, "utf8"), "parallel runner must never delete this preexisting marker");
  } finally {
    await rm(marker, { force: true }); // Our marker only. Do not remove a shared directory.
  }
});
