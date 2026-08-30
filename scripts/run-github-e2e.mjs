import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileGitHubE2EBundles, writeGitHubE2EInputManifest } from "./github-e2e-input.mjs";

const root = process.cwd();
const envFile = process.env.GITHUB_E2E_ENV_FILE ?? ".env.github-e2e";
const envPath = path.isAbsolute(envFile) ? envFile : path.join(root, envFile);
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";

function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

const requestedOutDir = optionValue("out-dir");
const writeInputManifest = process.argv.includes("--write-input-manifest");

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

if (!compileOnly) loadEnvFile();

const required = [
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
];
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

const outDir = requestedOutDir
  ? (path.isAbsolute(requestedOutDir) ? requestedOutDir : path.join(root, requestedOutDir))
  : path.join(root, ".tmp", "github-e2e", `${process.pid}-${Date.now()}`);
const outfiles = await compileGitHubE2EBundles({ root, outDir });
if (writeInputManifest) await writeGitHubE2EInputManifest({ outDir });

if (compileOnly) {
  for (const outfile of outfiles) console.log(`GitHub E2E bundle compiled: ${outfile}`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...outfiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
