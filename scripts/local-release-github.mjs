import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CANONICAL_REPOSITORY, repositoriesEqual } from "./github-repo.mjs";
import { runCommand } from "./local-release-lib.mjs";
import { parseStableTriple } from "./release-metadata.mjs";

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^sha256:([0-9a-f]{64})$/iu;

function requireRepo(repo) {
  if (!repositoriesEqual(repo, CANONICAL_REPOSITORY)) {
    throw new Error(`Publication repository must be ${CANONICAL_REPOSITORY}`);
  }
  return CANONICAL_REPOSITORY;
}

function requireVersion(version) {
  if (!parseStableTriple(version)) throw new Error(`Release version must be x.y.z: ${version}`);
  return version;
}

function requireSha(sha) {
  if (!SHA_RE.test(sha ?? "")) throw new Error("Expected full lowercase 40-hex commit SHA");
  return sha;
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function requireSuccess(result, label) {
  if (!result || result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

export function githubCliEnv(env = process.env) {
  return { ...env, GH_HOST: "github.com" };
}

export function runGitHubCli({ runner = runCommand, args, env = process.env, cwd } = {}) {
  return runner("gh", args, { cwd, env: githubCliEnv(env), encoding: "utf8" });
}

export function requireGithubPublicationAuth({ runner = runCommand, repo = CANONICAL_REPOSITORY, env = process.env, cwd } = {}) {
  const canonical = requireRepo(repo);
  requireSuccess(runGitHubCli({ runner, args: ["auth", "status", "--hostname", "github.com"], env, cwd }), "GitHub CLI authentication check");
  const result = requireSuccess(runGitHubCli({
    runner,
    args: ["api", "--hostname", "github.com", `repos/${canonical}`],
    env,
    cwd,
  }), "Authenticated canonical repository lookup");
  const body = parseJson(result.stdout, "Authenticated canonical repository lookup");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Authenticated canonical repository lookup returned malformed JSON");
  if (body?.permissions?.push !== true) throw new Error("GitHub authentication cannot prove Contents write permission for the canonical repository");
}

function matchingStableRefArgs(repo, version) {
  return ["api", "--hostname", "github.com", `repos/${repo}/git/matching-refs/tags/${encodeURIComponent(version)}`];
}

export function readStableRef({ runner = runCommand, repo = CANONICAL_REPOSITORY, version, env = process.env, cwd } = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  const result = requireSuccess(runGitHubCli({ runner, args: matchingStableRefArgs(canonical, version), env, cwd }), "Stable ref lookup");
  const rows = parseJson(result.stdout, "Stable ref lookup");
  if (!Array.isArray(rows)) throw new Error("Stable ref lookup returned malformed JSON");
  const expectedRef = `refs/tags/${version}`;
  const matches = rows.filter(row => row?.ref === expectedRef);
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) throw new Error(`Stable ref lookup returned duplicate exact refs for ${version}`);
  const sha = matches[0]?.object?.sha;
  requireSha(sha);
  if (matches[0]?.object?.type && matches[0].object.type !== "commit") {
    throw new Error("Stable ref must point directly to a commit");
  }
  return { kind: "present", ref: expectedRef, sha };
}

export function createStableRef({ runner = runCommand, repo = CANONICAL_REPOSITORY, version, sha, env = process.env, cwd } = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  requireSha(sha);
  const ref = `refs/tags/${version}`;
  const result = runGitHubCli({
    runner,
    args: ["api", "--hostname", "github.com", "--method", "POST", `repos/${canonical}/git/refs`, "-f", `ref=${ref}`, "-f", `sha=${sha}`],
    env,
    cwd,
  });
  if (!result || result.status !== 0) {
    let observed;
    try {
      observed = readStableRef({ runner, repo: canonical, version, env, cwd });
    } catch (error) {
      throw new Error(`Stable ref create failed with unknown remote state: ${error.message}`);
    }
    if (observed.kind === "present") {
      throw new Error(`Stable ref create failed and ${ref} now exists at ${observed.sha}; stop for partial/concurrent-state inspection`);
    }
    throw new Error(`Stable ref create failed; ${ref} is currently absent, so outcome is not safe to retry automatically`);
  }

  const body = parseJson(result.stdout, "Stable ref create");
  if (body?.ref !== ref || body?.object?.sha !== sha) throw new Error("Stable ref create returned an unexpected ref or SHA");
  const observed = readStableRef({ runner, repo: canonical, version, env, cwd });
  if (observed.kind !== "present" || observed.sha !== sha) throw new Error("Stable ref post-create verification failed");
  return { kind: "created" };
}

export function readReleaseState({ runner = runCommand, repo = CANONICAL_REPOSITORY, version, env = process.env, cwd } = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  const result = requireSuccess(runGitHubCli({
    runner,
    args: ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${canonical}/releases?per_page=100`],
    env,
    cwd,
  }), "Complete release listing");
  const pages = parseJson(result.stdout, "Complete release listing");
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("Complete release listing returned malformed pagination shape");
  const matches = pages.flat().filter(release => release?.tag_name === version);
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) throw new Error(`Complete release listing returned duplicate releases for ${version}`);
  const release = matches[0];
  if (!release || typeof release !== "object" || Array.isArray(release)) throw new Error("Release state is malformed");
  if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean" || !Array.isArray(release.assets)) {
    throw new Error("Release state is missing required draft/prerelease/assets fields");
  }
  return { kind: "present", release };
}

export function createDraftArgs({ repo = CANONICAL_REPOSITORY, version, previousStableTag, stagedAssetPaths } = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  if (!Array.isArray(stagedAssetPaths) || stagedAssetPaths.length !== 4 || stagedAssetPaths.some(path => typeof path !== "string" || path === "")) {
    throw new Error("Draft release requires exactly four staged asset paths");
  }
  if (previousStableTag !== undefined && previousStableTag !== null) requireVersion(previousStableTag);
  return [
    "release", "create", version,
    "--repo", canonical,
    "--verify-tag",
    "--draft",
    "--title", version,
    "--generate-notes",
    ...(previousStableTag ? ["--notes-start-tag", previousStableTag] : []),
    ...stagedAssetPaths,
  ];
}

export function publishDraftArgs({ repo = CANONICAL_REPOSITORY, version } = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  return ["release", "edit", version, "--repo", canonical, "--draft=false"];
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyDownloadedAsset({ runner, repo, version, artifact, tempRoot, env, cwd }) {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `asset-verify-${randomUUID().slice(0, 8)}-`));
  const output = join(dir, "asset.bin");
  try {
    const result = runGitHubCli({
      runner,
      args: ["release", "download", version, "--repo", repo, "--pattern", artifact.name, "--output", output],
      env,
      cwd,
    });
    requireSuccess(result, `Release asset download verification for ${artifact.name}`);
    const info = await stat(output);
    if (!info.isFile() || info.size !== artifact.size) throw new Error(`Downloaded release asset size mismatch: ${artifact.name}`);
    const digest = await sha256File(output);
    if (digest !== artifact.sha256) throw new Error(`Downloaded release asset SHA-256 mismatch: ${artifact.name}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function verifyReleaseAssets({
  runner = runCommand,
  repo = CANONICAL_REPOSITORY,
  version,
  release,
  localArtifacts,
  tempRoot,
  env = process.env,
  cwd,
} = {}) {
  const canonical = requireRepo(repo);
  requireVersion(version);
  if (!release || release.tag_name !== version || !Array.isArray(release.assets)) throw new Error("Release asset verification received the wrong release");
  if (!Array.isArray(localArtifacts) || localArtifacts.length !== 4) throw new Error("Local artifact manifest must contain exactly four assets");
  const localNames = new Set(localArtifacts.map(item => item?.name));
  if (localNames.size !== 4 || [...localNames].some(name => typeof name !== "string" || !name)) throw new Error("Local artifact manifest contains invalid or duplicate names");
  if (localArtifacts.some(item => !Number.isSafeInteger(item?.size) || item.size < 1 || !/^[0-9a-f]{64}$/u.test(item?.sha256 ?? ""))) {
    throw new Error("Local artifact manifest contains invalid size or SHA-256 data");
  }

  const remoteNames = new Set(release.assets.map(item => item?.name));
  if (remoteNames.size !== release.assets.length) throw new Error("Release contains duplicate asset names");
  if (remoteNames.size !== localNames.size || [...localNames].some(name => !remoteNames.has(name))) throw new Error("Release asset set does not exactly match local artifacts");

  for (const artifact of localArtifacts) {
    const remote = release.assets.find(item => item.name === artifact.name);
    if (remote.state !== "uploaded") throw new Error(`Release asset is not uploaded: ${artifact.name}`);
    if (remote.size !== artifact.size) throw new Error(`Release asset size mismatch: ${artifact.name}`);
    if (remote.digest === null || remote.digest === undefined) {
      if (typeof tempRoot !== "string" || tempRoot === "") throw new Error("Asset digest fallback requires a verification temp root");
      await verifyDownloadedAsset({ runner, repo: canonical, version, artifact, tempRoot, env, cwd });
      continue;
    }
    if (typeof remote.digest !== "string") throw new Error(`Release asset digest is malformed: ${artifact.name}`);
    const match = SHA256_RE.exec(remote.digest);
    if (!match) throw new Error(`Release asset digest is not SHA-256: ${artifact.name}`);
    if (match[1].toLowerCase() !== artifact.sha256) throw new Error(`Release asset SHA-256 mismatch: ${artifact.name}`);
  }
}
