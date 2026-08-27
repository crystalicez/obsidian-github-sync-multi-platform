import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadGitHubE2EEnv, requireGitHubE2EConfig } from "./github-e2e-env.mjs";
import { readOriginFetchRepository } from "./github-repo.mjs";
import { preflightE2ERemote } from "./github-e2e-remote.mjs";

const root = process.cwd();
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, { ...options, shell: false });
}

let liveEnv = process.env;
if (!compileOnly) {
  try {
    const currentSourceRepo = readOriginFetchRepository({ runner: runCommand, cwd: root });
    const loaded = await loadGitHubE2EEnv({ cwd: root, env: process.env });
    const config = requireGitHubE2EConfig(loaded.env, { currentSourceRepo });
    await preflightE2ERemote({ fetchImpl: fetch, config });
    liveEnv = loaded.env;
  } catch (error) {
    console.error(`GitHub E2E preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

const outDir = path.join(root, ".tmp", "github-e2e", `${process.pid}-${Date.now()}`);
const entries = [
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const outfiles = [];
for (const entry of entries) {
  const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/u, ".mjs"));
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
  outfiles.push(outfile);
}

if (compileOnly) {
  for (const outfile of outfiles) console.log(`GitHub E2E bundle compiled: ${outfile}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...outfiles], {
  cwd: root,
  stdio: "inherit",
  env: liveEnv,
  shell: false,
});
process.exit(result.status ?? 1);
