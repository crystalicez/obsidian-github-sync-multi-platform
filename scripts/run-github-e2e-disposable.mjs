// Explicit opt-in manual E2E wrapper for user-approved disposable test repo.
// No GH Actions or credential storage. Never targets the source/default branch.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileGitHubE2EBundles } from "./github-e2e-input.mjs";
import { deriveGitHubE2EDestinationBranch, deriveGitHubE2EFrozenBackupBranch, loadGitHubE2EEnv } from "./github-e2e-env.mjs";
import { CANONICAL_REPOSITORY_ID } from "./github-repo.mjs";
import { cleanupE2EBranch, preflightE2ERemote, readE2EBranch } from "./github-e2e-remote.mjs";

const allowed = new Map([
  ["rename-plaintext", "rename-vs-stale-edit-plaintext"],
  ["rename-encrypted", "rename-vs-stale-edit-encrypted"],
  ["readonly-rekey-encrypted", "readonly-rekey-encrypted"],
  ["installed-source-parity-encrypted", "installed-source-parity-encrypted"],
  ["installed-source-backup-handoff-encrypted", "installed-source-backup-handoff-encrypted"],
  ["frozen-backup-encrypted", "frozen-backup-encrypted"],
  ["wal-backup-encrypted", "wal-backup-encrypted"],
  ["wal-backup-ambiguous", "wal-backup-ambiguous"],
  ["wal-stage-encrypted", "wal-stage-encrypted"],
  ["wal-candidate-encrypted", "wal-candidate-encrypted"],
  ["wal-scratch-encrypted", "wal-scratch-encrypted"],
  ["wal-publish-encrypted", "wal-publish-encrypted"],
  ["wal-publish-lost-response", "wal-publish-lost-response"],
  ["wal-publish-process-loss", "wal-publish-process-loss"],
  ["wal-publish-process-loss-negative", "wal-publish-process-loss-negative"],
  ["newkey-destination-encrypted", "newkey-destination-encrypted"],
  ["frozen-backup-crash", "frozen-backup-encrypted"],
  ["orphan-root-encrypted", "orphan-root-encrypted"],
  ["delete-plaintext", "delete-recreate-plaintext"],
  ["diagnostic-missing-plaintext", "diagnostic-missing-plaintext"],
  ["delete-encrypted", "delete-recreate-encrypted"],
  ["full", null],
]);
const mode = process.argv[2];
if (!allowed.has(mode) || process.argv.length !== 3) {
  console.error("Usage: node scripts/run-github-e2e-disposable.mjs orphan-root-encrypted|readonly-rekey-encrypted|installed-source-parity-encrypted|installed-source-backup-handoff-encrypted|frozen-backup-encrypted|wal-backup-encrypted|wal-backup-ambiguous|wal-stage-encrypted|wal-candidate-encrypted|wal-scratch-encrypted|wal-publish-encrypted|wal-publish-lost-response|wal-publish-process-loss|wal-publish-process-loss-negative|frozen-backup-crash|newkey-destination-encrypted|rename-plaintext|rename-encrypted|delete-plaintext|delete-encrypted|diagnostic-missing-plaintext|full");
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
  // The frozen-Backup scenario creates a second, derived disposable ref.
  // Preflight BOTH names before any child writes, and let the OUTER runner
  // clean both even if the child crashes before its own finally hook.
  const refs = (mode === "newkey-destination-encrypted" || mode === "wal-stage-encrypted" || mode === "wal-candidate-encrypted" || mode === "wal-scratch-encrypted" || mode === "wal-publish-encrypted" || mode === "wal-publish-lost-response" || mode === "wal-publish-process-loss" || mode === "wal-publish-process-loss-negative" || mode === "full"
    ? [branch, deriveGitHubE2EFrozenBackupBranch(branch), deriveGitHubE2EDestinationBranch(branch)]
    : (mode === "installed-source-backup-handoff-encrypted" || mode === "frozen-backup-encrypted" || mode === "wal-backup-encrypted" || mode === "wal-backup-ambiguous" || mode === "frozen-backup-crash"
      ? [branch, deriveGitHubE2EFrozenBackupBranch(branch)] : [branch]))
    .map(name => ({ owner: config.owner, repo: config.repo, branch: name, token: config.token }));
  for (const ref of refs) {
    const first = await readWithRetry(ref);
    const second = await readWithRetry(ref);
    if (first.kind !== "absent" || second.kind !== "absent") {
      throw new Error(`Refusing to use pre-existing or unverified disposable branch: ${ref.branch}`);
    }
  }
  console.log(JSON.stringify({ status: "ABSENT_FIRST", sourceSha: sourceSha.stdout.trim(), branch, mode, repoId: target.id }));
  const childEnv = { ...env, GITHUB_E2E_BRANCH: branch, GITHUB_E2E_EXPECTED_REPO_ID: target.id };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  delete childEnv.GH_ENTERPRISE_TOKEN;
  delete childEnv.GITHUB_ENTERPRISE_TOKEN;
  if (allowed.get(mode)) childEnv.GITHUB_E2E_ONLY_SCENARIO = allowed.get(mode);
  else delete childEnv.GITHUB_E2E_ONLY_SCENARIO;
  // Only this explicit owner-approved synthetic run may exit before child cleanup.
  if (mode === "frozen-backup-crash") childEnv.GITHUB_E2E_SIMULATE_EXIT_AFTER_BACKUP = "1";
  else delete childEnv.GITHUB_E2E_SIMULATE_EXIT_AFTER_BACKUP;
  // Prevent stale user-local selector from silently forcing a different branch.
  if (childEnv.GITHUB_E2E_REQUIRED_BRANCH && childEnv.GITHUB_E2E_REQUIRED_BRANCH !== branch)
    throw new Error("A pre-existing required branch conflicts with the generated isolated branch");

  let d385Root;
  // Both child processes receive the same RANDOM synthetic WAL key and new
  // passphrase through process env ONLY. Neither is written to a file/log.
  if (mode === "wal-publish-process-loss" || mode === "wal-publish-process-loss-negative") {
    const tmp = resolve(process.cwd(), ".tmp");
    await mkdir(tmp, { recursive: true });
    const stat = await lstat(tmp);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("D385 refuses a linked/non-directory test temp root");
    d385Root = await mkdtemp(join(tmp, "d385-owned-"));
    childEnv.GITHUB_E2E_D385_ROOT = d385Root;
    childEnv.GITHUB_E2E_D385_JOURNAL_KEY_B64 = randomBytes(32).toString("base64url");
    childEnv.GITHUB_E2E_D385_NEW_PASSPHRASE =
      "d385-disposable-" + randomBytes(18).toString("base64url");
  } else {
    delete childEnv.GITHUB_E2E_D385_ROOT;
    delete childEnv.GITHUB_E2E_D385_JOURNAL_KEY_B64;
    delete childEnv.GITHUB_E2E_D385_NEW_PASSPHRASE;
  }

  let result;
  let cleaned = false;
  let d385Recovered = false;
  let focusedOutDir;
  let focusedBundles;
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
      focusedBundles = await compileGitHubE2EBundles({ root: process.cwd(), outDir: focusedOutDir });
      result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", focusedBundles[0]], {
        cwd: process.cwd(), env: childEnv, stdio: "inherit", shell: false,
        timeout: (mode === "wal-publish-encrypted" || mode === "wal-publish-lost-response"
          || mode === "wal-publish-process-loss"
          || mode === "wal-publish-process-loss-negative")
          ? 840_000 : 420_000,
      });
    }
    if (d385Root) {
      // The first process was deliberately TERMINATED after GitHub returned
      // success, BEFORE the WAL recorded the destination ref readback. Node
      // --test may map worker exit(86) to parent exit(1), so require separate
      // positive on-disk and real-remote proof before any recovery action.
      if (result?.error || ![1, 86].includes(result?.status))
        throw new Error("D385 expected an interrupted child, not a normal test completion");
      const markerFile = join(d385Root, "post-confirmed.json");
      const evidenceFile = join(d385Root, "recovery-evidence.json");
      for (const filename of [markerFile, evidenceFile]) {
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || stat.size <= 20 || stat.size > 512 * 1024)
          throw new Error("D385 interrupted process left an unsafe test-only evidence file");
      }
      const posted = JSON.parse(await readFile(markerFile, "utf8"));
      const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
      const ref = await readWithRetry(refs[2]);
      if (posted?.schemaVersion !== 1 || evidence?.schemaVersion !== 1
        || posted?.createAttempts !== 1
        || posted.destinationCommitSha !== evidence.prepared?.commitSha
        || posted.sourceCommitSha !== evidence.sourceCommitSha
        || evidence.orphanPlan?.destinationBranch !== refs[2].branch
        || evidence.backupPlan?.backupBranch !== refs[1].branch
        || evidence.backupPlan?.sourceRepoId !== `${config.owner}/${config.repo}#${config.branch}`
        || ref.kind !== "present" || ref.sha !== posted.destinationCommitSha)
        throw new Error("D385 will not recover without exact child-created GitHub ref evidence");

      // PRODUCTION NEVER RECLAIMS A STALE WAL LOCK. This is a narrowly
      // scoped SIMULATED MANUAL decision for one verified dead, child-owned
      // process and one disposable WAL root; no user Vault or persistent
      // plugin-private WAL is ever inspected or modified here.
      const leaf = join(d385Root, "wal-root", "reencryption", "wal");
      const entries = (await readdir(leaf)).sort();
      if (JSON.stringify(entries) !== JSON.stringify(
        [".exclusive.lock", "slot-0.json", "slot-1.json"]))
        throw new Error("D385 WAL has unknown files; do not reclaim test lock");
      for (const filename of entries) {
        const stat = await lstat(join(leaf, filename));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || (filename !== ".exclusive.lock" && (stat.size <= 0 || stat.size > 2 * 1024 * 1024)))
          throw new Error("D385 refuses an unsafe synthetic WAL slot or lock");
      }
      const previousLock = await readFile(join(leaf, ".exclusive.lock"), "utf8");
      if (!/^[A-Za-z0-9_-]{32}$/u.test(previousLock))
        throw new Error("D385 test-owned WAL lock token malformed");
      await rename(join(leaf, ".exclusive.lock"),
        join(d385Root, "quarantined-dead-test-child-lock.txt"));
      console.log(JSON.stringify({
        stage: "D385_TEST_ONLY_SIMULATED_MANUAL_STALE_LOCK_QUARANTINE",
        priorChildStopped: true, remoteDestinationCommitSha: ref.sha,
        productionAutomaticLockReclamation: false,
      }));
      const recoveryEnv = {
        ...childEnv,
        GITHUB_E2E_ONLY_SCENARIO: mode === "wal-publish-process-loss-negative"
          ? "wal-recover-process-loss-negative" : "wal-recover-process-loss",
      };
      result = spawnSync(process.execPath,
        ["--test", "--test-concurrency=1", focusedBundles[0]], {
          cwd: process.cwd(), env: recoveryEnv, stdio: "inherit",
          shell: false, timeout: 600_000,
        });
      if (result.error || result.status !== 0)
        throw new Error("D385 independent-process WAL recovery did not finish successfully");
      d385Recovered = true;
    }
  } finally {
    const cleanupErrors = [];
    // Always attempt every owned ref: a failure cleaning Source must not skip
    // the frozen Backup. The extra branch exists ONLY in approved E2E modes.
    for (const ref of refs) {
      try {
        const firstAfter = await readWithRetry(ref);
        if (firstAfter.kind === "present") {
          try { await cleanupE2EBranch({ ...config, branch: ref.branch, maxAttempts: 5 }); }
          catch {
            // Unknown DELETE response: verify twice, never assume success.
          }
        }
        const after1 = await readWithRetry(ref);
        const after2 = await readWithRetry(ref);
        if (after1.kind !== "absent" || after2.kind !== "absent")
          throw new Error("Disposable branch remains after test");
        console.log(JSON.stringify({ status: "CLEANUP_VERIFIED_TWICE", branch: ref.branch, repoId: target.id }));
      } catch (error) {
        cleanupErrors.push({ branch: ref.branch, reason: error instanceof Error ? error.message : String(error) });
        console.error(`CRITICAL E2E cleanup not independently verified for ${ref.branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    cleaned = cleanupErrors.length === 0;
    if (!cleaned) process.exitCode = 3;
    if (focusedOutDir) {
      await rm(focusedOutDir, { recursive: true, force: true })
        .catch(error => console.error(`Could not remove test-only compilation directory: ${error.code ?? "unknown"}`));
    }
  }
  if (d385Root && d385Recovered && cleaned) {
    await rm(d385Root, { recursive: true, force: true });
    console.log(JSON.stringify({
      stage: "D385_TEST_ONLY_LOCAL_WAL_CLEANUP",
      recoveryCompleted: true, remoteRefsAbsentTwice: true,
    }));
  } else if (d385Root) {
    console.error("D385 retains its synthetic local WAL evidence for explicit review: " + d385Root);
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
