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
