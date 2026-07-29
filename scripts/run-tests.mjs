import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { discoverTests, selectTests } from "./test-discovery.mjs";

const root = process.cwd();
const outDir = path.join(root, ".tmp", "tests");

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

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

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
    alias: {
      obsidian: path.join(root, "tests", "stubs", "obsidian.ts"),
    },
    logLevel: "silent",
  });
  runnable.push(outfile);
}

const result = spawnSync(process.execPath, ["--test", ...runnable], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
