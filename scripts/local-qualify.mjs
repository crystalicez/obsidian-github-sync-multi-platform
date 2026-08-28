import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadGitHubE2EEnv, qualificationE2EBranch, validateGitHubE2EConfig } from "./github-e2e-env.mjs";
import { cleanupE2EBranch, preflightE2ERemote } from "./github-e2e-remote.mjs";
import { CANONICAL_REPOSITORY, requireCanonicalOriginEndpoints } from "./github-repo.mjs";
import {
  createQualificationReceipt,
  QUALIFICATION_GATES,
  qualificationRefName,
  qualificationTagName,
  runCommand,
  runPnpmGate,
  serializeQualificationReceipt,
  validateQualificationReceipt,
  withoutGitHubE2EToken,
} from "./local-release-lib.mjs";
import {
  createAnnotatedTagObject,
  fetchAndInspectObservedQualificationTag,
  readRemoteMasterSha,
  requireCleanMaster,
} from "./local-release-git.mjs";
import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const FIXED_GATE_NAMES = Object.freeze(QUALIFICATION_GATES.slice(1, -1));

function requireSuccess(result, label) {
  if (!result || result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

function text(result) {
  return String(result?.stdout ?? "").trim();
}

function assertExactRuntimeToolchain({ metadata, nodeVersion, pnpmVersion }) {
  if (nodeVersion !== metadata.nodeVersion) {
    throw new Error(`Running Node ${nodeVersion} does not match committed ${metadata.nodeVersion}`);
  }
  if (pnpmVersion !== metadata.pnpmVersion) {
    throw new Error(`Running pnpm ${pnpmVersion} does not match committed ${metadata.pnpmVersion}`);
  }
}

function readPnpmVersion({ runner, cwd, env, platform, comspec }) {
  const result = platform === "win32"
    ? runner(comspec, ["/d", "/s", "/c", "corepack pnpm --version"], { cwd, env, encoding: "utf8" })
    : runner("corepack", ["pnpm", "--version"], { cwd, env, encoding: "utf8" });
  requireSuccess(result, "Corepack pnpm version check");
  const version = text(result);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Corepack pnpm returned an invalid version");
  return version;
}

function validateObservedQualification(state, { sha, version, nodeVersion, pnpmVersion }) {
  if (state.kind !== "present") throw new Error("Qualification receipt is absent");
  const expectedTagName = qualificationTagName(version, sha);
  const tag = state.tag;
  if (tag.targetType !== "commit") throw new Error("Qualification tag must target a commit directly");
  if (tag.targetSha !== sha) throw new Error("Qualification tag target SHA mismatch");
  if (tag.tagName !== expectedTagName) throw new Error("Qualification tag declared name mismatch");
  let receipt;
  try {
    receipt = JSON.parse(tag.message);
  } catch {
    throw new Error("Qualification receipt message is not valid JSON");
  }
  validateQualificationReceipt(receipt, { sha, version, nodeVersion, pnpmVersion });
  return { ...state, receipt };
}

function isExplicitExistingRefRejection(result) {
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return /\[rejected\].*(already exists|would clobber existing tag)/iu.test(output)
    || /\(already exists\)/iu.test(output);
}

function defaultRunId() {
  return randomBytes(12).toString("hex");
}

export async function qualifyLocal({
  cwd = process.cwd(),
  runner = runCommand,
  fetchImpl = fetch,
  now = () => new Date(),
  runId = defaultRunId,
  sleep,
  env = process.env,
  runtimeNodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
  onProgress = () => {},
} = {}) {
  const startedAt = now();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) throw new Error("now() must return a valid Date");

  const nonLiveEnv = withoutGitHubE2EToken(env);
  const nonLiveRunner = (command, args, options = {}) => runner(command, args, { ...options, env: nonLiveEnv });

  const sha = requireCleanMaster({ runner: nonLiveRunner, cwd });
  requireCanonicalOriginEndpoints({ runner: nonLiveRunner, cwd });
  if (readRemoteMasterSha({ runner: nonLiveRunner, cwd }) !== sha) throw new Error("Remote master does not equal local HEAD");

  const metadata = validateReleaseMetadata(await readReleaseMetadata(cwd));
  const pnpmVersion = readPnpmVersion({ runner: nonLiveRunner, cwd, env: nonLiveEnv, platform, comspec });
  assertExactRuntimeToolchain({ metadata, nodeVersion: runtimeNodeVersion, pnpmVersion });
  requireSuccess(nonLiveRunner("git", ["var", "GIT_COMMITTER_IDENT"], { cwd, encoding: "utf8" }), "Git committer identity check");

  const version = metadata.version;
  const qualificationRef = qualificationRefName(version, sha);
  const existing = fetchAndInspectObservedQualificationTag({ runner: nonLiveRunner, cwd, ref: qualificationRef });
  if (existing.kind === "present") {
    const valid = validateObservedQualification(existing, {
      sha,
      version,
      nodeVersion: metadata.nodeVersion,
      pnpmVersion: metadata.pnpmVersion,
    });
    return {
      sha,
      version,
      qualificationRef,
      qualificationTagObjectSha: valid.objectSha,
      alreadyQualified: true,
    };
  }

  const runIdValue = typeof runId === "function" ? runId() : runId;
  const officialBranch = qualificationE2EBranch(sha, runIdValue);
  const loaded = await loadGitHubE2EEnv({ cwd, env });
  const raw = loaded.env;
  for (const key of ["GITHUB_E2E_OWNER", "GITHUB_E2E_REPO", "GITHUB_E2E_TOKEN"]) {
    if (!raw[key]) throw new Error(`Missing required GitHub E2E env var: ${key}`);
  }
  const e2eConfig = validateGitHubE2EConfig({
    owner: raw.GITHUB_E2E_OWNER,
    repo: raw.GITHUB_E2E_REPO,
    branch: officialBranch,
    token: raw.GITHUB_E2E_TOKEN,
    currentSourceRepo: CANONICAL_REPOSITORY,
  });
  await preflightE2ERemote({ fetchImpl, config: e2eConfig });
  onProgress({ kind: "e2e-branch", branch: officialBranch });

  onProgress({ kind: "gate", name: "metadata-validation" });
  for (const gate of FIXED_GATE_NAMES) {
    if (gate === "github-e2e-live") break;
    onProgress({ kind: "gate", name: gate });
    const result = runPnpmGate(gate, { cwd, env: nonLiveEnv, platform, comspec, runner: nonLiveRunner });
    requireSuccess(result, `Qualification gate ${gate}`);
  }

  onProgress({ kind: "gate", name: "github-e2e-live" });
  const liveEnv = { ...raw, GITHUB_E2E_BRANCH: officialBranch };
  const liveResult = runPnpmGate("github-e2e-live", { cwd, env: liveEnv, platform, comspec, runner });
  let cleanupError = null;
  try {
    await cleanupE2EBranch({
      fetchImpl,
      owner: e2eConfig.owner,
      repo: e2eConfig.repo,
      branch: officialBranch,
      token: e2eConfig.token,
      sleep,
    });
    onProgress({ kind: "gate", name: "github-e2e-cleanup-verified" });
  } catch (error) {
    cleanupError = error;
  }

  if (!liveResult || liveResult.status !== 0) {
    if (cleanupError) throw new Error(`GitHub E2E live gate failed; cleanup also failed for ${officialBranch}: ${cleanupError.message}`);
    throw new Error(`GitHub E2E live gate failed; cleanup verified for ${officialBranch}`);
  }
  if (cleanupError) throw new Error(`GitHub E2E cleanup verification failed for ${officialBranch}: ${cleanupError.message}`);

  const postSha = requireCleanMaster({ runner: nonLiveRunner, cwd });
  if (postSha !== sha) throw new Error("HEAD changed during qualification");
  requireCanonicalOriginEndpoints({ runner: nonLiveRunner, cwd });
  if (readRemoteMasterSha({ runner: nonLiveRunner, cwd }) !== sha) throw new Error("Remote master changed during qualification");
  const postMetadata = validateReleaseMetadata(await readReleaseMetadata(cwd), { requestedVersion: version });
  const postPnpmVersion = readPnpmVersion({ runner: nonLiveRunner, cwd, env: nonLiveEnv, platform, comspec });
  assertExactRuntimeToolchain({ metadata: postMetadata, nodeVersion: runtimeNodeVersion, pnpmVersion: postPnpmVersion });
  const postExisting = fetchAndInspectObservedQualificationTag({ runner: nonLiveRunner, cwd, ref: qualificationRef });
  if (postExisting.kind !== "absent") throw new Error("Qualification ref appeared concurrently after gates");

  const finishedAt = now();
  if (!(finishedAt instanceof Date) || !Number.isFinite(finishedAt.getTime())) throw new Error("now() must return a valid Date");
  const durationMs = Math.max(0, Math.round(finishedAt.getTime() - startedAt.getTime()));
  const receipt = createQualificationReceipt({
    sha,
    version,
    qualifiedAt: finishedAt.toISOString(),
    durationMs,
    platform: `${platform}-${arch}`,
    nodeVersion: metadata.nodeVersion,
    pnpmVersion: metadata.pnpmVersion,
  });
  const tagName = qualificationTagName(version, sha);
  const message = serializeQualificationReceipt(receipt);
  const tagObjectSha = createAnnotatedTagObject({ runner: nonLiveRunner, cwd, targetSha: sha, tagName, message });

  const pushResult = nonLiveRunner("git", ["push", "--porcelain", "origin", `${tagObjectSha}:${qualificationRef}`], { cwd, encoding: "utf8" });
  const remoteAfterPush = fetchAndInspectObservedQualificationTag({ runner: nonLiveRunner, cwd, ref: qualificationRef });
  if (pushResult?.status === 0) {
    const valid = validateObservedQualification(remoteAfterPush, {
      sha, version, nodeVersion: metadata.nodeVersion, pnpmVersion: metadata.pnpmVersion,
    });
    if (valid.objectSha !== tagObjectSha) throw new Error("Remote qualification object differs from this invocation after successful push");
  } else if (isExplicitExistingRefRejection(pushResult)) {
    validateObservedQualification(remoteAfterPush, {
      sha, version, nodeVersion: metadata.nodeVersion, pnpmVersion: metadata.pnpmVersion,
    });
  } else {
    const valid = validateObservedQualification(remoteAfterPush, {
      sha, version, nodeVersion: metadata.nodeVersion, pnpmVersion: metadata.pnpmVersion,
    });
    if (valid.objectSha !== tagObjectSha) throw new Error("Qualification push outcome is ambiguous and remote object is not this invocation's tag object");
  }

  return {
    sha,
    version,
    qualificationRef,
    qualificationTagObjectSha: remoteAfterPush.objectSha,
    alreadyQualified: false,
  };
}

async function cli() {
  const result = await qualifyLocal();
  const state = result.alreadyQualified ? "already qualified" : "qualified";
  console.log(`${state}: ${result.version} ${result.sha}`);
  console.log(`qualification ref: ${result.qualificationRef}`);
  console.log(`qualification object: ${result.qualificationTagObjectSha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(error => {
    console.error(`Local qualification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
