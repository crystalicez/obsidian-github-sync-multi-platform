import { build } from "esbuild";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { discoverTests, selectTests } from "./test-discovery.mjs";

const root = process.cwd();
const outputRoot = path.join(root, ".tmp");

function optionValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const tier = optionValue("tier", "fast");
const filter = optionValue("filter", "");
const knownTiers = new Set(["fast", "feasibility", "resource", "recovery", "github-e2e", "soak", "device"]);
if (!knownTiers.has(tier)) {
  console.error(`Unknown test tier: ${tier}`);
  process.exit(2);
}

const typeCheck = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tests", "tsconfig.type-tests.json"), "--pretty", "false"],
  { cwd: root, stdio: "inherit" },
);
if (typeCheck.status !== 0) process.exit(typeCheck.status ?? 1);

const discovered = await discoverTests(root);
const selected = selectTests(discovered, { tier, filter });
if (selected.length === 0) {
  console.error(`No tests matched tier=${tier}${filter ? ` filter=${filter}` : ""}`);
  process.exit(2);
}

// A shared .tmp/tests directory made parallel tiers and repeat runs delete one
// another's bundles (ENOTEMPTY/ENOENT). Only remove this invocation's directory.
await mkdir(outputRoot, { recursive: true });
const outputRootStat = await lstat(outputRoot);
if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()) {
  throw new Error("Refusing linked or non-directory .tmp test output root.");
}
const outDir = await mkdtemp(path.join(outputRoot, "tests-"));
try {
  const runnable = [];
  for (const item of selected) {
    if (item.path.endsWith(".test.mjs")) {
      runnable.push(path.join(root, item.path));
      continue;
    }
    const outfile = path.join(outDir, item.path.replace(/[\\/]/g, "__").replace(/\.ts$/u, ".mjs"));
    await build({
      entryPoints: [path.join(root, item.path)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      alias: { obsidian: path.join(root, "tests", "stubs", "obsidian.ts") },
      logLevel: "silent",
    });
    runnable.push(outfile);
  }
  const result = spawnSync(process.execPath, ["--test", ...runnable], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
