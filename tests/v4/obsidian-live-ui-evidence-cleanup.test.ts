import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanupGeneratedUiEvidence } from "../../scripts/obsidian-live-ui-cleanup.mjs";

test("native UI evidence cleanup deletes only screenshots of the exact synthetic run ID", async () => {
  const repositoryTemp = path.join(process.cwd(), ".tmp");
  await mkdir(repositoryTemp, { recursive: true });
  const repoRoot = await mkdtemp(path.join(repositoryTemp, "d25-ui-evidence-"));
  const id = "1234567890abcdef";
  const evidence = path.join(repoRoot, ".tmp", "obsidian-live-github-e2e-evidence");
  const runRoot = path.join(repoRoot, ".tmp", "obsidian-live-github-e2e", id);
  await mkdir(evidence, { recursive: true });
  const one = path.join(evidence, id + "-sync-center.png");
  const two = path.join(evidence, id + "-peer-restored.png");
  const other = path.join(evidence, "fedcba0987654321-sync-center.png");
  try {
    await writeFile(one, Buffer.from("synthetic-main"));
    await writeFile(two, Buffer.from("synthetic-peer"));
    await writeFile(other, Buffer.from("other-run"));
    await cleanupGeneratedUiEvidence(runRoot, { repoRoot });
    await assert.rejects(readFile(one), { code: "ENOENT" });
    await assert.rejects(readFile(two), { code: "ENOENT" });
    assert.equal((await readFile(other)).toString(), "other-run");
    // A second cleanup must be idempotent.
    await cleanupGeneratedUiEvidence(runRoot, { repoRoot });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("native UI evidence cleanup refuses paths outside exact disposable vault parent", async () => {
  const root = path.join(process.cwd(), ".tmp", "d25-identity-fixture");
  const removeCalls: string[] = [];
  const remove = async (target: string) => { removeCalls.push(target); };
  for (const unsafe of [
    path.join(root, "vault", "1234567890abcdef"),
    path.join(root, ".tmp", "obsidian-live-github-e2e", "..", "fedcba0987654321"),
    path.join(root, ".tmp", "obsidian-live-github-e2e", "malformed"),
  ]) {
    await assert.rejects(cleanupGeneratedUiEvidence(unsafe, { repoRoot: root, remove }), /untrusted|synthetic/i);
  }
  assert.deepEqual(removeCalls, []);
});

test("native UI evidence cleanup retries a transient Windows sharing error without broadening paths", async () => {
  const root = path.join(process.cwd(), ".tmp", "d25-retry-fixture");
  const runRoot = path.join(root, ".tmp", "obsidian-live-github-e2e", "0123456789abcdef");
  const removed: string[] = [];
  let calls = 0;
  await cleanupGeneratedUiEvidence(runRoot, {
    repoRoot: root,
    maxAttempts: 2,
    retryDelayMs: 1,
    wait: async () => undefined,
    remove: async (target: string) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      removed.push(target);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(removed.map(item => path.basename(item)), [
    "0123456789abcdef-sync-center.png",
    "0123456789abcdef-peer-restored.png",
  ]);
});
