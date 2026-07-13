import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, ".tmp", "tests");
const tsEntries = [
  "tests/encrypted/actual-behavior.test.ts",
  "tests/encrypted/error-handling.test.ts",
  "tests/encrypted/e2e-sync.test.ts",
  "tests/encrypted/benchmark.test.ts",
  "tests/encrypted/settings-combinations.test.ts",
  "tests/encrypted/pack-planner.test.ts",
  "tests/encrypted/snapshot-store.test.ts",
  "tests/encrypted/snapshot-merge.test.ts",
  "tests/encrypted/change-queue.test.ts",
  "tests/encrypted/sync-planner.test.ts",
  "tests/encrypted/v3-planner.test.ts",
  "tests/encrypted-v3/protocol-core.test.ts",
  "tests/encrypted-v3/sync-session.test.ts",
  "tests/encrypted-v3/store-modules.test.ts",
  "tests/encrypted-v3/runtime.test.ts",
  "tests/github-e2e/random-actions.test.ts",
  "tests/v3/git-atomic-writer.test.ts",
  "tests/v3/remote-cache.test.ts",
  "tests/v4/protocol-core.test.ts",
  "tests/v4/scope.test.ts",
  "tests/v4/local-index.test.ts",
  "tests/v4/github-transport.test.ts",
  "tests/v4/git-tree-writer.test.ts",
  "tests/v4/change-guard.test.ts",
  "tests/v4/planner.test.ts",
  "tests/v4/conflicts.test.ts",
  "tests/v4/storage-history.test.ts",
  "tests/v4/storage-codec.test.ts",
  "tests/v4/remote-index.test.ts",
  "tests/v4/sync-coordinator.test.ts",
  "tests/v4/sync-session.test.ts",
  "tests/v4/settings-secrets.test.ts",
  "tests/v4/history-service.test.ts",
  "tests/v4/benchmark.test.ts",
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const bundled = [];
for (const entry of tsEntries) {
  const outfile = path.join(outDir, entry.replace(/[\\/]/g, "__").replace(/\.ts$/u, ".mjs"));
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: {
      obsidian: path.join(root, "tests", "stubs", "obsidian.ts"),
    },
    logLevel: "silent",
  });
  bundled.push(outfile);
}

const args = ["--test", "tests/**/*.test.mjs", ...bundled];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
