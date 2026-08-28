import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CANONICAL_REPOSITORY, requireCanonicalOriginEndpoints } from "./github-repo.mjs";
import {
  qualificationRefName,
  qualificationTagName,
  runCommand,
  runPnpmGate,
  validateQualificationReceipt,
} from "./local-release-lib.mjs";
import {
  fetchAndInspectObservedQualificationTag,
  listRemoteStableTags,
  readRemoteMasterSha,
  requireCleanMaster,
} from "./local-release-git.mjs";
import {
  createDraftArgs,
  createStableRef,
  publishDraftArgs,
  readReleaseState,
  readStableRef,
  requireGithubPublicationAuth,
  runGitHubCli,
  verifyReleaseAssets,
} from "./local-release-github.mjs";
import { packagePlugin } from "./package-plugin.mjs";
import { compareStableTriples, parseStableTriple, readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const PUBLICATION_GATES = Object.freeze([
  "install-frozen",
  "build",
  "package-validation",
  "fast-tests",
  "github-e2e-compile",
]);

function requireSuccess(result, label) {
  if (!result || result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

function text(result) {
  return String(result?.stdout ?? "").trim();
}

function defaultReadPnpmVersion({ runner, cwd, env, platform, comspec }) {
  const result = platform === "win32"
    ? runner(comspec, ["/d", "/s", "/c", "corepack pnpm --version"], { cwd, env, encoding: "utf8" })
    : runner("corepack", ["pnpm", "--version"], { cwd, env, encoding: "utf8" });
  requireSuccess(result, "Corepack pnpm version check");
  const value = text(result);
  if (!/^\d+\.\d+\.\d+$/u.test(value)) throw new Error("Corepack pnpm returned an invalid version");
  return value;
}

function requireExactToolchain(metadata, { runtimeNodeVersion, runtimePnpmVersion }) {
  if (runtimeNodeVersion !== metadata.nodeVersion) {
    throw new Error(`Running Node ${runtimeNodeVersion} does not match committed ${metadata.nodeVersion}`);
  }
  if (runtimePnpmVersion !== metadata.pnpmVersion) {
    throw new Error(`Running pnpm ${runtimePnpmVersion} does not match committed ${metadata.pnpmVersion}`);
  }
}

function validateQualificationState(state, { sha, version, nodeVersion, pnpmVersion }) {
  if (!state || state.kind !== "present") throw new Error("Exact local qualification receipt is absent");
  const tag = state.tag;
  if (!tag || tag.targetType !== "commit") throw new Error("Qualification tag must target a commit directly");
  if (tag.targetSha !== sha) throw new Error("Qualification tag target SHA mismatch");
  if (tag.tagName !== qualificationTagName(version, sha)) throw new Error("Qualification tag declared name mismatch");
  let receipt;
  try {
    receipt = JSON.parse(tag.message);
  } catch {
    throw new Error("Qualification receipt message is not valid JSON");
  }
  validateQualificationReceipt(receipt, { sha, version, nodeVersion, pnpmVersion });
  return { ...state, receipt };
}

function choosePreviousStableTag(tags, version) {
  let previous = null;
  for (const tag of tags) {
    if (!tag || !parseStableTriple(tag.name)) continue;
    const comparison = compareStableTriples(tag.name, version);
    if (comparison >= 0) continue;
    if (previous === null || compareStableTriples(tag.name, previous) > 0) previous = tag.name;
  }
  return previous;
}

async function requireArtifactsUnchanged(artifacts) {
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.size || digest !== artifact.sha256) {
      throw new Error(`Staged release asset changed after packaging: ${artifact.name}`);
    }
  }
}

function requireReleaseShape(release, { version, draft }) {
  if (!release || release.tag_name !== version) throw new Error("Release state does not match requested stable tag");
  if (release.prerelease !== false) throw new Error("Stable release must not be prerelease");
  if (release.draft !== draft) {
    throw new Error(draft ? "Expected an exact draft release" : "Post-publication release is not published");
  }
}

const DEFAULT_SERVICES = Object.freeze({
  requireCleanMaster,
  requireCanonicalOriginEndpoints,
  readRemoteMasterSha,
  readReleaseMetadata,
  validateReleaseMetadata,
  readPnpmVersion: defaultReadPnpmVersion,
  requireGithubPublicationAuth,
  listRemoteStableTags,
  readStableRef,
  readReleaseState,
  fetchAndInspectObservedQualificationTag,
  runPnpmGate,
  packagePlugin,
  createStableRef,
  createDraftArgs,
  runGitHubCli,
  verifyReleaseAssets,
  publishDraftArgs,
});

export async function releaseLocal({
  cwd = process.cwd(),
  version,
  runner = runCommand,
  env = process.env,
  runtimeNodeVersion = process.version,
  platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
  services = {},
  onProgress = () => {},
} = {}) {
  if (!parseStableTriple(version)) throw new Error(`Release version must be x.y.z: ${version}`);
  const s = { ...DEFAULT_SERVICES, ...services };
  const phase = name => onProgress({ phase: name });

  phase("preflight");
  const sha = s.requireCleanMaster({ runner, cwd });
  s.requireCanonicalOriginEndpoints({ runner, cwd });
  if (s.readRemoteMasterSha({ runner, cwd }) !== sha) throw new Error("Remote master does not equal local HEAD");
  const metadata = s.validateReleaseMetadata(await s.readReleaseMetadata(cwd), { requestedVersion: version });
  const runtimePnpmVersion = s.readPnpmVersion({ runner, cwd, env, platform, comspec });
  requireExactToolchain(metadata, { runtimeNodeVersion, runtimePnpmVersion });
  s.requireGithubPublicationAuth({ runner, repo: CANONICAL_REPOSITORY, env, cwd });

  const remoteStableTags = s.listRemoteStableTags({ runner, cwd });
  for (const tag of remoteStableTags) {
    if (compareStableTriples(version, tag.name) <= 0) {
      throw new Error(`Requested version ${version} must be greater than every remote stable tag`);
    }
  }
  if (s.readStableRef({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd }).kind !== "absent") {
    throw new Error(`Stable ref ${version} already exists; inspect partial/concurrent publication state`);
  }
  if (s.readReleaseState({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd }).kind !== "absent") {
    throw new Error(`Release ${version} already exists; inspect partial/concurrent publication state`);
  }

  phase("qualification-snapshot");
  const qualificationRef = qualificationRefName(version, sha);
  const initialQualification = validateQualificationState(
    s.fetchAndInspectObservedQualificationTag({ runner, cwd, ref: qualificationRef }),
    { sha, version, nodeVersion: metadata.nodeVersion, pnpmVersion: metadata.pnpmVersion },
  );
  const qualificationTagObjectSha = initialQualification.objectSha;

  phase("publication-gates");
  for (const gate of PUBLICATION_GATES) {
    const result = s.runPnpmGate(gate, { cwd, env, platform, comspec, runner });
    requireSuccess(result, `Publication gate ${gate}`);
  }

  phase("package");
  const packaged = await s.packagePlugin({ cwd, version, runner });
  if (!packaged || !Array.isArray(packaged.assets) || packaged.assets.length !== 4) {
    throw new Error("Release packaging did not produce the exact four-asset manifest");
  }

  const recheckSourceAndEvidence = async ({ requireStable, requireReleaseAbsent = false, requireDraft = false } = {}) => {
    const currentSha = s.requireCleanMaster({ runner, cwd });
    if (currentSha !== sha) throw new Error("Local HEAD changed during release");
    s.requireCanonicalOriginEndpoints({ runner, cwd });
    if (s.readRemoteMasterSha({ runner, cwd }) !== sha) throw new Error("Remote master changed during release");
    const currentMetadata = s.validateReleaseMetadata(await s.readReleaseMetadata(cwd), { requestedVersion: version });
    const currentPnpm = s.readPnpmVersion({ runner, cwd, env, platform, comspec });
    requireExactToolchain(currentMetadata, { runtimeNodeVersion, runtimePnpmVersion: currentPnpm });
    const qualification = validateQualificationState(
      s.fetchAndInspectObservedQualificationTag({ runner, cwd, ref: qualificationRef }),
      { sha, version, nodeVersion: currentMetadata.nodeVersion, pnpmVersion: currentMetadata.pnpmVersion },
    );
    if (qualification.objectSha !== qualificationTagObjectSha) throw new Error("Qualification evidence object changed during release");
    const stable = s.readStableRef({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
    if (requireStable) {
      if (stable.kind !== "present" || stable.sha !== sha) throw new Error("Stable ref changed or does not target the qualified SHA");
    } else if (stable.kind !== "absent") {
      throw new Error("Stable ref appeared before the create-only claim");
    }
    const releaseState = s.readReleaseState({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
    if (requireReleaseAbsent && releaseState.kind !== "absent") throw new Error("Release appeared before draft creation");
    if (requireDraft) {
      if (releaseState.kind !== "present") throw new Error("Draft release disappeared before publication");
      requireReleaseShape(releaseState.release, { version, draft: true });
    }
    await requireArtifactsUnchanged(packaged.assets);
    return releaseState;
  };

  phase("final-pre-mutation-check");
  await recheckSourceAndEvidence({ requireStable: false, requireReleaseAbsent: true });

  phase("stable-ref-create");
  s.createStableRef({ runner, repo: CANONICAL_REPOSITORY, version, sha, env, cwd });

  phase("post-ref-recheck");
  await recheckSourceAndEvidence({ requireStable: true, requireReleaseAbsent: true });

  phase("draft-create");
  const previousStableTag = choosePreviousStableTag(remoteStableTags, version);
  const draftArgs = s.createDraftArgs({
    repo: CANONICAL_REPOSITORY,
    version,
    previousStableTag,
    stagedAssetPaths: packaged.assets.map(artifact => artifact.path),
  });
  const draftResult = s.runGitHubCli({ runner, args: draftArgs, env, cwd });
  if (!draftResult || draftResult.status !== 0) {
    let observed;
    try {
      observed = s.readReleaseState({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
    } catch (error) {
      throw new Error(`Draft creation failed with unknown remote release state: ${error.message}`);
    }
    const description = observed.kind === "present" ? "a release/draft is now visible" : "no release is currently visible";
    throw new Error(`Draft creation failed; ${description}. Stop for inspection; do not retry or delete automatically.`);
  }
  const draftState = s.readReleaseState({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
  if (draftState.kind !== "present") throw new Error("Draft creation returned success but no release is visible");
  requireReleaseShape(draftState.release, { version, draft: true });

  phase("draft-asset-verify");
  await s.verifyReleaseAssets({
    runner, repo: CANONICAL_REPOSITORY, version, release: draftState.release,
    localArtifacts: packaged.assets, tempRoot: join(packaged.stagingDir, "verify"), env, cwd,
  });

  phase("final-publish-check");
  const finalDraftState = await recheckSourceAndEvidence({ requireStable: true, requireDraft: true });
  await s.verifyReleaseAssets({
    runner, repo: CANONICAL_REPOSITORY, version, release: finalDraftState.release,
    localArtifacts: packaged.assets, tempRoot: join(packaged.stagingDir, "verify-final"), env, cwd,
  });

  phase("publish");
  const publishResult = s.runGitHubCli({ runner, args: s.publishDraftArgs({ repo: CANONICAL_REPOSITORY, version }), env, cwd });

  phase("post-verify");
  const finalQualification = validateQualificationState(
    s.fetchAndInspectObservedQualificationTag({ runner, cwd, ref: qualificationRef }),
    { sha, version, nodeVersion: metadata.nodeVersion, pnpmVersion: metadata.pnpmVersion },
  );
  if (finalQualification.objectSha !== qualificationTagObjectSha) throw new Error("Qualification evidence changed by post-publication verification");
  const finalStable = s.readStableRef({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
  if (finalStable.kind !== "present" || finalStable.sha !== sha) throw new Error("Post-publication stable ref verification failed");
  const finalReleaseState = s.readReleaseState({ runner, repo: CANONICAL_REPOSITORY, version, env, cwd });
  if (finalReleaseState.kind !== "present") throw new Error("Post-publication release is absent");
  requireReleaseShape(finalReleaseState.release, { version, draft: false });
  await requireArtifactsUnchanged(packaged.assets);
  await s.verifyReleaseAssets({
    runner, repo: CANONICAL_REPOSITORY, version, release: finalReleaseState.release,
    localArtifacts: packaged.assets, tempRoot: join(packaged.stagingDir, "verify-post"), env, cwd,
  });
  const postPublicationRemoteMaster = s.readRemoteMasterSha({ runner, cwd });
  const releaseUrl = finalReleaseState.release.html_url;
  if (typeof releaseUrl !== "string" || releaseUrl === "") throw new Error("Published release is missing its GitHub URL");

  return {
    version,
    sha,
    qualificationTagObjectSha,
    releaseUrl,
    reconciledPublish: !publishResult || publishResult.status !== 0,
    postPublicationRemoteMaster,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: pnpm release:local -- <x.y.z>");
  const result = await releaseLocal({
    version: args[0],
    onProgress: event => console.log(`release phase: ${event.phase}`),
  });
  console.log(`released: ${result.version} ${result.sha}`);
  console.log(`qualification object: ${result.qualificationTagObjectSha}`);
  console.log(`release: ${result.releaseUrl}`);
  if (result.reconciledPublish) console.log("publish command was ambiguous; exact final GitHub state reconciled as success");
  console.log(`post-publication remote master: ${result.postPublicationRemoteMaster}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(error => {
    console.error(`Local release failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
