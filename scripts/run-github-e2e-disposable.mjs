// Explicit opt-in manual E2E wrapper for user-approved disposable test repo.
// No GH Actions or credential storage. Never targets the source/default branch.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { compileGitHubE2EBundles } from "./github-e2e-input.mjs";
import { loadGitHubE2EEnv } from "./github-e2e-env.mjs";
import { CANONICAL_REPOSITORY_ID } from "./github-repo.mjs";
import { cleanupE2EBranch, preflightE2ERemote, readE2EBranch } from "./github-e2e-remote.mjs";

const allowed = new Map([
  ["rename-plaintext", "rename-vs-stale-edit-plaintext"],
  ["rename-encrypted", "rename-vs-stale-edit-encrypted"],
  ["delete-plaintext", "delete-recreate-plaintext"],
  ["diagnostic-missing-plaintext", "diagnostic-missing-plaintext"],
  ["delete-encrypted", "delete-recreate-encrypted"],
  ["full", null],
]);
const mode = process.argv[2];
if (!allowed.has(mode) || process.argv.length !== 3) {
  console.error("Usage: node scripts/run-github-e2e-disposable.mjs rename-plaintext|rename-encrypted|delete-plaintext|delete-encrypted|diagnostic-missing-plaintext|full");
  process.exitCode = 2;
} else {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readWithRetry = async args => {
    for (let i = 0; i < 5; i += 1) {
      try { return await readE2EBranch(args); }
      catch (error) {
        if (i === 4) throw error;
        await sleep((i + 1) * 1_000);
      }
    }
    throw new Error("Unreachable retry state");
  };

  const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false });
  if (sourceSha.status !== 0 || !/^[a-f0-9]{40}$/u.test(sourceSha.stdout?.trim() ?? "")) {
    throw new Error("Cannot identify tested audit source SHA");
  }
  const branch = `obsidian-sync-e2e/local-${sourceSha.stdout.trim().slice(0, 12)}-d24-${mode}-${randomBytes(6).toString("hex")}`;
  const rootEnvPath = resolve(process.cwd(), "..", "..", ".env.github-e2e");
  const { env } = await loadGitHubE2EEnv({ cwd: process.cwd(), env: process.env, envFile: rootEnvPath });
  if (env.GITHUB_E2E_OWNER !== "diamond-crystal"
    || env.GITHUB_E2E_REPO !== "test-vault-obsidian-encrypted-github-sync-multi-platform"
    || !env.GITHUB_E2E_TOKEN
    || (env.GITHUB_E2E_EXPECTED_REPO_ID && env.GITHUB_E2E_EXPECTED_REPO_ID !== "1284153873")) {
    throw new Error("Refusing test run: approved GitHub test repository/credentials/identity mismatch");
  }
  if (env.GITHUB_E2E_REQUIRED_BRANCH && env.GITHUB_E2E_REQUIRED_BRANCH !== branch)
    throw new Error("Refusing test run: a pinned required branch conflicts with the generated disposable branch");
  const config = {
    owner: env.GITHUB_E2E_OWNER, repo: env.GITHUB_E2E_REPO,
    token: env.GITHUB_E2E_TOKEN, branch,
    expectedRepoId: "1284153873",
    currentSourceRepoId: CANONICAL_REPOSITORY_ID,
  };
  const target = await preflightE2ERemote({ config });
  if (target.id !== "1284153873") throw new Error("Test repository ID mismatch");
  const ref = { owner: config.owner, repo: config.repo, branch, token: config.token };
  const first = await readWithRetry(ref);
  const second = await readWithRetry(ref);
  if (first.kind !== "absent" || second.kind !== "absent") {
    throw new Error("Refusing to use pre-existing or unverified disposable branch");
  }
  console.log(JSON.stringify({ status: "ABSENT_FIRST", sourceSha: sourceSha.stdout.trim(), branch, mode, repoId: target.id }));
  const childEnv = { ...env, GITHUB_E2E_BRANCH: branch, GITHUB_E2E_EXPECTED_REPO_ID: target.id };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  delete childEnv.GH_ENTERPRISE_TOKEN;
  delete childEnv.GITHUB_ENTERPRISE_TOKEN;
  if (allowed.get(mode)) childEnv.GITHUB_E2E_ONLY_SCENARIO = allowed.get(mode);
  else delete childEnv.GITHUB_E2E_ONLY_SCENARIO;
  // Prevent stale user-local selector from silently forcing a different branch.
  if (childEnv.GITHUB_E2E_REQUIRED_BRANCH && childEnv.GITHUB_E2E_REQUIRED_BRANCH !== branch)
    throw new Error("A pre-existing required branch conflicts with the generated isolated branch");

  let result;
  let cleaned = false;
  let focusedOutDir;
  try {
    if (mode === "full") {
      result = spawnSync(process.execPath, ["scripts/run-github-e2e.mjs"], {
        cwd: process.cwd(), env: childEnv, stdio: "inherit", shell: false, timeout: 1_200_000,
      });
    } else {
      // Running only the applicable test avoids unrelated long GitHub E2E
      // suites; full mode still runs the unchanged entire acceptance matrix.
      focusedOutDir = resolve(process.cwd(), ".tmp", "github-e2e",
        `d24-focused-${process.pid}-${randomBytes(5).toString("hex")}`);
      const bundles = await compileGitHubE2EBundles({ root: process.cwd(), outDir: focusedOutDir });
      result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", bundles[0]], {
        cwd: process.cwd(), env: childEnv, stdio: "inherit", shell: false, timeout: 420_000,
      });
    }
  } finally {
    try {
      // Child test hook normally removes the ref itself. Prove that first;
      // do not make needless delete requests when the branch is already gone.
      const firstAfter = await readWithRetry(ref);
      if (firstAfter.kind === "present") {
        try { await cleanupE2EBranch({ ...config, maxAttempts: 5 }); }
        catch {
          // A network error after DELETE can still mean cleanup succeeded;
          // verify GitHub twice rather than guessing or blindly retrying DELETE.
        }
      }
      const after1 = await readWithRetry(ref);
      const after2 = await readWithRetry(ref);
      if (after1.kind !== "absent" || after2.kind !== "absent")
        throw new Error("Disposable branch remains after test");
      cleaned = true;
      console.log(JSON.stringify({ status: "CLEANUP_VERIFIED_TWICE", branch, repoId: target.id }));
    } catch (error) {
      console.error(`CRITICAL E2E cleanup not independently verified for ${branch}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 3;
    }
    if (focusedOutDir) {
      await rm(focusedOutDir, { recursive: true, force: true })
        .catch(error => console.error(`Could not remove test-only compilation directory: ${error.code ?? "unknown"}`));
    }
  }
  if (cleaned) {
    if (result?.error || result?.status !== 0) {
      console.error(`E2E ${mode} FAILED with verified cleanup: ${result?.error?.code ?? result?.status ?? "unknown"}`);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ status: "LIVE_E2E_PASS", mode, branch }));
    }
  }
}
