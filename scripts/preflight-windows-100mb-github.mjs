#!/usr/bin/env node
// Read-only GitHub E2E identity preflight; no secrets in output and no mutations.
import { spawnSync } from "node:child_process";
import { loadGitHubE2EEnv, requireGitHubE2EConfig } from "./github-e2e-env.mjs";
import { preflightE2ERemote, readE2ERepository, readE2EBranch } from "./github-e2e-remote.mjs";
import { readOriginFetchRepository } from "./github-repo.mjs";

try {
  const cwd = process.cwd();
  const source = readOriginFetchRepository({
    runner: (command, args, options) => spawnSync(command, args, { ...options, shell: false }), cwd,
  });
  const loaded = await loadGitHubE2EEnv({ cwd, env: process.env });
  const pinFlag = process.argv.slice(2).find(arg => arg.startsWith("--expected-repo-id="));
  if (pinFlag && !loaded.env.GITHUB_E2E_EXPECTED_REPO_ID) {
    const value = pinFlag.slice("--expected-repo-id=".length);
    if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("Expected numeric pinned test repository ID");
    loaded.env.GITHUB_E2E_EXPECTED_REPO_ID = value;
  }
  const branchFlag = process.argv.slice(2).find(arg => arg.startsWith("--branch="));
  if (branchFlag) {
    const candidate = branchFlag.slice("--branch=".length);
    if (!/^obsidian-sync-e2e\/local-[a-z0-9-]{8,80}$/u.test(candidate)) {
      throw new Error("Explicit branch must be a namespaced disposable local branch");
    }
    loaded.env.GITHUB_E2E_BRANCH = candidate;
  }
  const cfg = requireGitHubE2EConfig(loaded.env, { currentSourceRepo: source });
  if (!cfg.branch.startsWith("obsidian-sync-e2e/local-")) {
    throw new Error("Test branch must be within obsidian-sync-e2e/local-");
  }
  const [owner, repo] = source.split("/");
  const sourceRepo = await readE2ERepository({ owner, repo });
  const target = await preflightE2ERemote({ config: { ...cfg, currentSourceRepoId: sourceRepo.id } });
  const branch = await readE2EBranch({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: cfg.token });
  if (branch.kind !== "absent") throw new Error("Test branch exists; refusing overwrite without an explicit verified cleanup");
  console.log(JSON.stringify({
    status: "PASS", action: "read-only-preflight", verifiedTargetRepositoryId: target.id,
    testBranch: cfg.branch, testBranchAbsent: true, defaultBranchRefReadable: true, mutations: 0,
  }));
} catch (error) {
  console.error("Read-only GitHub test preflight FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
