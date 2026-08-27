import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CANONICAL_REPOSITORY, repositoriesEqual } from "./github-repo.mjs";

const REQUIRED_E2E_KEYS = Object.freeze([
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
]);
const FORBIDDEN_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"]);

export function parseEnvLine(line) {
  const trimmed = String(line ?? "").trim();
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

export async function loadGitHubE2EEnv({ cwd = process.cwd(), env = process.env, envFile } = {}) {
  const merged = { ...env };
  const explicitPath = envFile ?? env.GITHUB_E2E_ENV_FILE;
  const selected = explicitPath ?? ".env.github-e2e";
  const path = isAbsolute(selected) ? selected : join(cwd, selected);

  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && explicitPath === undefined) return { env: merged, envPath: path };
    if (error?.code === "ENOENT") throw new Error(`GitHub E2E env file not found: ${path}`);
    throw error;
  }

  for (const line of content.split(/\r?\n/u)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (merged[key] === undefined) merged[key] = value;
  }
  return { env: merged, envPath: path };
}

function requireSafeSegment(value, name) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("/") || /\s/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value.trim();
}

export function validateGitHubE2EConfig({ owner, repo, branch, token, currentSourceRepo }) {
  const safeOwner = requireSafeSegment(owner, "GITHUB_E2E_OWNER");
  const safeRepo = requireSafeSegment(repo, "GITHUB_E2E_REPO");
  if (typeof branch !== "string" || branch.trim() === "") throw new Error("Missing GITHUB_E2E_BRANCH");
  const safeBranch = branch.trim();
  if (FORBIDDEN_BRANCHES.has(safeBranch.toLowerCase())) {
    throw new Error(`Refusing destructive GitHub E2E against protected-looking branch: ${safeBranch}`);
  }
  if (typeof token !== "string" || token === "") throw new Error("Missing GITHUB_E2E_TOKEN");

  const targetRepository = `${safeOwner}/${safeRepo}`;
  if (currentSourceRepo && repositoriesEqual(targetRepository, currentSourceRepo)) {
    throw new Error("Refusing destructive GitHub E2E against the current source repository");
  }
  if (repositoriesEqual(targetRepository, CANONICAL_REPOSITORY)) {
    throw new Error("Refusing destructive GitHub E2E against the canonical source repository");
  }

  return { owner: safeOwner, repo: safeRepo, branch: safeBranch, token, targetRepository };
}

export function requireGitHubE2EConfig(env, { currentSourceRepo } = {}) {
  const missing = REQUIRED_E2E_KEYS.filter(name => !env?.[name]);
  if (missing.length > 0) throw new Error(`Missing required GitHub E2E env vars: ${missing.join(", ")}`);
  return validateGitHubE2EConfig({
    owner: env.GITHUB_E2E_OWNER,
    repo: env.GITHUB_E2E_REPO,
    branch: env.GITHUB_E2E_BRANCH,
    token: env.GITHUB_E2E_TOKEN,
    currentSourceRepo,
  });
}

export function qualificationE2EBranch(sha, runId) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) throw new Error("Expected full lowercase commit SHA");
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(runId ?? "")) throw new Error("Unsafe qualification run id");
  return `obsidian-sync-e2e/local-${sha.slice(0, 12)}-${runId}`;
}
