import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CANONICAL_REPOSITORY, repositoriesEqual } from "./github-repo.mjs";

const REQUIRED_E2E_KEYS = Object.freeze([
  "GITHUB_E2E_OWNER",
  "GITHUB_E2E_REPO",
  "GITHUB_E2E_BRANCH",
  "GITHUB_E2E_TOKEN",
  "GITHUB_E2E_EXPECTED_REPO_ID",
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

function requireRepositoryId(value, name = "GITHUB_E2E_EXPECTED_REPO_ID") {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

export function resolvePinnedGitHubE2ERepoId(envPinned, cliPinned) {
  const fromEnv = envPinned === undefined ? "" : String(envPinned).trim();
  const fromCli = cliPinned === undefined ? "" : String(cliPinned).trim();
  if (fromEnv && fromCli && fromEnv !== fromCli) {
    throw new Error("Conflicting GITHUB_E2E_EXPECTED_REPO_ID and --expected-repo-id");
  }
  return requireRepositoryId(fromCli || fromEnv);
}

// Match the public GitHub username and repository boundaries before any
// credentialed URL is built. encodeURIComponent does NOT escape "."/"..":
// those segments would be normalized into a different API path by fetch.
const E2E_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const E2E_REPO = /^[A-Za-z0-9._-]{1,100}$/u;
export function assertSafeGitHubE2ECoordinates(owner, repo) {
  if (typeof owner !== "string" || !E2E_OWNER.test(owner)) {
    throw new Error("Invalid GITHUB_E2E_OWNER");
  }
  if (typeof repo !== "string" || !E2E_REPO.test(repo)
    || repo === "." || repo === "..") {
    throw new Error("Invalid GITHUB_E2E_REPO");
  }
}

// E2E branch strings are interpolated into GitHub API URLs. URL parsers
// normalize "." / ".." path segments BEFORE a request is sent; a prefix
// check on the unparsed string is not a safe ref-identity boundary.
const SAFE_E2E_REF_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;
export function assertSafeGitHubE2EBranch(branch) {
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 200
    || branch.includes("..") || branch.endsWith(".")
    || branch.split("/").some(segment => !SAFE_E2E_REF_SEGMENT.test(segment)
      || segment.endsWith(".lock"))) {
    throw new Error("Invalid GITHUB_E2E_BRANCH: unsafe GitHub branch path.");
  }
}

export function validateGitHubE2EConfig({ owner, repo, branch, token, expectedRepoId, currentSourceRepo }) {
  assertSafeGitHubE2ECoordinates(owner, repo);
  const safeOwner = owner;
  const safeRepo = repo;
  if (typeof branch !== "string" || branch.trim() === "") throw new Error("Missing GITHUB_E2E_BRANCH");
  assertSafeGitHubE2EBranch(branch);
  const safeBranch = branch;
  if (FORBIDDEN_BRANCHES.has(safeBranch.toLowerCase())) {
    throw new Error(`Refusing destructive GitHub E2E against protected-looking branch: ${safeBranch}`);
  }
  if (typeof token !== "string" || token === "") throw new Error("Missing GITHUB_E2E_TOKEN");
  const safeExpectedRepoId = requireRepositoryId(expectedRepoId);

  const targetRepository = `${safeOwner}/${safeRepo}`;
  if (currentSourceRepo && repositoriesEqual(targetRepository, currentSourceRepo)) {
    throw new Error("Refusing destructive GitHub E2E against the current source repository");
  }
  if (repositoriesEqual(targetRepository, CANONICAL_REPOSITORY)) {
    throw new Error("Refusing destructive GitHub E2E against the canonical source repository");
  }

  return {
    owner: safeOwner,
    repo: safeRepo,
    branch: safeBranch,
    token,
    expectedRepoId: safeExpectedRepoId,
    targetRepository,
  };
}

export function requireGitHubE2EConfig(env, { currentSourceRepo } = {}) {
  const missing = REQUIRED_E2E_KEYS.filter(name => !env?.[name]);
  if (missing.length > 0) throw new Error(`Missing required GitHub E2E env vars: ${missing.join(", ")}`);
  return validateGitHubE2EConfig({
    owner: env.GITHUB_E2E_OWNER,
    repo: env.GITHUB_E2E_REPO,
    branch: env.GITHUB_E2E_BRANCH,
    token: env.GITHUB_E2E_TOKEN,
    expectedRepoId: env.GITHUB_E2E_EXPECTED_REPO_ID,
    currentSourceRepo,
  });
}

export function sanitizeGitHubE2ELiveEnv(env = {}) {
  const next = { ...env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete next[key];
  return next;
}

function deriveIsolatedE2EBranch(sourceBranch, purpose) {
  // Never inherit arbitrary source refs; destination and backup must both
  // remain bounded single leaves even for maximum-size qualification run IDs.
  assertSafeGitHubE2EBranch(sourceBranch);
  if (!/^obsidian-sync-e2e\/local-[A-Za-z0-9_-]{6,160}$/u.test(sourceBranch)
    || (purpose !== "backup" && purpose !== "destination")) {
    throw new Error("Derived E2E ref needs a safe isolated generated source branch and purpose");
  }
  const leaf = createHash("sha256").update(sourceBranch + ":" + purpose, "utf8").digest("hex").slice(0, 32);
  return `obsidian-sync-e2e/local-${purpose}-${leaf}`;
}

export function deriveGitHubE2EFrozenBackupBranch(sourceBranch) {
  return deriveIsolatedE2EBranch(sourceBranch, "backup");
}

export function deriveGitHubE2EDestinationBranch(sourceBranch) {
  return deriveIsolatedE2EBranch(sourceBranch, "destination");
}

export function freshIsolatedGitHubE2EBranch(runId) {
  if (typeof runId !== "string" || !/^[0-9a-f]{32}$/u.test(runId)) {
    throw new Error("A fresh isolated E2E branch needs a cryptographically random 128-bit hex run ID");
  }
  return `obsidian-sync-e2e/local-${runId}`;
}

export function qualificationE2EBranch(sha, runId) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) throw new Error("Expected full lowercase commit SHA");
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(runId ?? "")) throw new Error("Unsafe qualification run id");
  return `obsidian-sync-e2e/local-${sha.slice(0, 12)}-${runId}`;
}
