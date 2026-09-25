import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileGitHubE2EBundles, writeGitHubE2EInputManifest } from "./github-e2e-input.mjs";
import { loadGitHubE2EEnv, requireGitHubE2EConfig, sanitizeGitHubE2ELiveEnv } from "./github-e2e-env.mjs";
import { preflightE2ERemote, readE2ERepository } from "./github-e2e-remote.mjs";
import { readOriginFetchRepository } from "./github-repo.mjs";

const root = process.cwd();
const compileOnly = process.argv.includes("--compile-only") || process.env.GITHUB_E2E_COMPILE_ONLY === "1";

function optionValue(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, { ...options, shell: false });
}

const requestedOutDir = optionValue("out-dir");
const writeInputManifest = process.argv.includes("--write-input-manifest");

let liveEnv = process.env;
if (!compileOnly) {
  try {
    const currentSourceRepo = readOriginFetchRepository({ runner: runCommand, cwd: root });
    const loaded = await loadGitHubE2EEnv({ cwd: root, env: process.env });
    const config = requireGitHubE2EConfig(loaded.env, { currentSourceRepo });
    const [sourceOwner, sourceRepo, ...extra] = currentSourceRepo.split("/");
    if (!sourceOwner || !sourceRepo || extra.length) throw new Error("Current source repository is malformed");
    const sourceIdentity = await readE2ERepository({ fetchImpl: fetch, owner: sourceOwner, repo: sourceRepo });
    await preflightE2ERemote({ fetchImpl: fetch, config: { ...config, currentSourceRepoId: sourceIdentity.id } });
    liveEnv = sanitizeGitHubE2ELiveEnv(loaded.env);
  } catch (error) {
    console.error(`GitHub E2E preflight failed: ${error instanceof Error ? error.message : String(error)}`);
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
  env: liveEnv,
  shell: false,
});
process.exit(result.status ?? 1);
