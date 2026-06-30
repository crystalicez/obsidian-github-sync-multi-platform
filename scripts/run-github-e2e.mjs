import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--profile=")) process.env.GITHUB_E2E_PROFILE = arg.slice("--profile=".length);
  if (arg === "--benchmarks") process.env.GITHUB_E2E_RUN_BENCHMARKS = "1";
}
const envFile = process.env.GITHUB_E2E_ENV_FILE ?? ".env.github-e2e";
const envPath = path.isAbsolute(envFile) ? envFile : path.join(root, envFile);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const separatorIndex = normalized.indexOf("=");
  if (separatorIndex <= 0) return null;
  const key = normalized.slice(0, separatorIndex).trim();
  let value = normalized.slice(separatorIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadEnvFile() {
  if (!existsSync(envPath)) {
    if (process.env.GITHUB_E2E_ENV_FILE) {
      console.error(`GitHub E2E env file not found: ${envPath}`);
      process.exit(2);
    }
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const compileOnly = process.env.GITHUB_E2E_COMPILE_ONLY === "1";
const required = ["GITHUB_E2E_OWNER", "GITHUB_E2E_REPO", "GITHUB_E2E_BRANCH", "GITHUB_E2E_TOKEN"];
if (!compileOnly) {
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing required GitHub E2E env vars: ${missing.join(", ")}`);
    console.error(`Required: ${required.join(", ")}`);
    console.error(`Set them in the shell or in ${envPath}`);
    process.exit(2);
  }

  const branch = process.env.GITHUB_E2E_BRANCH ?? "";
  const forbiddenBranches = new Set(["main", "master", "production", "prod", "release", "stable"]);
  if (forbiddenBranches.has(branch.toLowerCase())) {
    console.error(`Refusing to run destructive GitHub E2E tests against protected-looking branch: ${branch}`);
    process.exit(2);
  }
}

const outDir = path.join(root, ".tmp", "github-e2e", `${process.pid}-${Date.now()}`);
const entry = "tests/github-e2e/real-github-e2e.test.ts";
const outfile = path.join(outDir, "real-github-e2e.test.mjs");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

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

if (compileOnly) {
  console.log(`GitHub E2E bundle compiled: ${outfile}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", outfile], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);