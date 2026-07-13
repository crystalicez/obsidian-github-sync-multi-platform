import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, ".tmp", "tests");
const tsEntries = [
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
  "tests/v4/status.test.ts",
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
