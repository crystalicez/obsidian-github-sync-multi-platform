import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_REPOSITORY,
  CANONICAL_REPOSITORY_ID,
  parseGitHubRemote,
  readOriginFetchRepository,
  requireCanonicalOriginEndpoints,
} from "../../scripts/github-repo.mjs";
import {
  loadGitHubE2EEnv,
  parseEnvLine,
  qualificationE2EBranch,
  deriveGitHubE2EFrozenBackupBranch,
  deriveGitHubE2EDestinationBranch,
  freshIsolatedGitHubE2EBranch,
  resolvePinnedGitHubE2ERepoId,
  sanitizeGitHubE2ELiveEnv,
  validateGitHubE2EConfig,
} from "../../scripts/github-e2e-env.mjs";

function fakeGit({ fetchUrls = [], pushUrls = [], status = 0 } = {}) {
  return (command, args) => {
    assert.equal(command, "git");
    if (args.join(" ") === "remote get-url --all origin") return { status, stdout: `${fetchUrls.join("\n")}${fetchUrls.length ? "\n" : ""}` };
    if (args.join(" ") === "remote get-url --push --all origin") return { status, stdout: `${pushUrls.join("\n")}${pushUrls.length ? "\n" : ""}` };
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
}

test("D373 frozen backup E2E branch is deterministic, isolated and bounded at maximum qualifier run ID", () => {
  const source = qualificationE2EBranch("a".repeat(40), "r".repeat(64));
  const derived = deriveGitHubE2EFrozenBackupBranch(source);
  assert.match(derived, /^obsidian-sync-e2e\/local-backup-[0-9a-f]{32}$/u);
  assert.ok(derived.length <= 105, "Derived backup branch must fit strict E2E reset limits");
  assert.equal(derived, deriveGitHubE2EFrozenBackupBranch(source));
  assert.notEqual(derived, source);
  assert.notEqual(derived, deriveGitHubE2EFrozenBackupBranch(source.replace(/r$/u, "s")));
  const destination = deriveGitHubE2EDestinationBranch(source);
  assert.match(destination, /^obsidian-sync-e2e\/local-destination-[0-9a-f]{32}$/u);
  assert.ok(destination.length <= 105);
  assert.equal(destination, deriveGitHubE2EDestinationBranch(source));
  assert.notEqual(destination, source);
  assert.notEqual(destination, derived);
  assert.notEqual(destination, deriveGitHubE2EDestinationBranch(source.replace(/r$/u, "s")));
  for (const unsafe of ["feature/important", "main", "obsidian-sync-e2e/local-../main", "obsidian-sync-e2e/local-", ""]) {
    assert.throws(() => deriveGitHubE2EFrozenBackupBranch(unsafe));
    assert.throws(() => deriveGitHubE2EDestinationBranch(unsafe));
  }
});

test("canonical source identity pins both name and stable numeric ID", () => {
  assert.equal(CANONICAL_REPOSITORY, "crystalicez/obsidian-github-sync-multi-platform");
  assert.equal(CANONICAL_REPOSITORY_ID, "1282135059");
});

test("supported GitHub remotes normalize to owner/repo", () => {
  assert.equal(parseGitHubRemote("https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
  assert.equal(parseGitHubRemote("git@github.com:crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
  assert.equal(parseGitHubRemote("ssh://git@github.com/crystalicez/obsidian-github-sync-multi-platform.git"), CANONICAL_REPOSITORY);
});

test("remote parser rejects credential URLs, lookalikes, ports, and extra path", () => {
  for (const value of [
    "https://token@github.com/crystalicez/obsidian-github-sync-multi-platform.git",
    "https://github.com.evil/crystalicez/obsidian-github-sync-multi-platform.git",
    "https://github.com:8443/crystalicez/obsidian-github-sync-multi-platform.git",
    "https://github.com/crystalicez/obsidian-github-sync-multi-platform/extra",
    "ssh://user@github.com/crystalicez/obsidian-github-sync-multi-platform.git",
  ]) assert.throws(() => parseGitHubRemote(value));
});

test("credential-bearing remote errors never echo the secret URL", () => {
  const secretUrl = "https://super-secret-token@github.com/crystalicez/obsidian-github-sync-multi-platform.git";
  assert.throws(() => parseGitHubRemote(secretUrl), error => {
    assert.doesNotMatch(error.message, /super-secret-token/u);
    return true;
  });
});

test("official origin accepts one canonical fetch and push endpoint", () => {
  const result = requireCanonicalOriginEndpoints({
    runner: fakeGit({
      fetchUrls: ["https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"],
      pushUrls: ["git@github.com:crystalicez/obsidian-github-sync-multi-platform.git"],
    }),
    cwd: "/repo",
  });
  assert.equal(result.fetchRepository, CANONICAL_REPOSITORY);
  assert.equal(result.pushRepository, CANONICAL_REPOSITORY);
});

test("official origin rejects divergent or ambiguous endpoints", () => {
  assert.throws(() => requireCanonicalOriginEndpoints({
    runner: fakeGit({
      fetchUrls: ["https://github.com/crystalicez/obsidian-github-sync-multi-platform.git"],
      pushUrls: ["git@github.com:someone-else/other.git"],
    }), cwd: "/repo",
  }), /push/i);
  assert.throws(() => requireCanonicalOriginEndpoints({
    runner: fakeGit({ fetchUrls: ["git@github.com:a/b.git", "git@github.com:c/d.git"], pushUrls: ["git@github.com:a/b.git"] }), cwd: "/repo",
  }), /exactly one.*fetch/i);
  assert.throws(() => requireCanonicalOriginEndpoints({
    runner: fakeGit({ fetchUrls: ["git@github.com:crystalicez/obsidian-github-sync-multi-platform.git"], pushUrls: ["git@github.com:a/b.git", "git@github.com:c/d.git"] }), cwd: "/repo",
  }), /exactly one.*push/i);
});

test("manual source detection permits non-canonical fork origin", () => {
  const repo = readOriginFetchRepository({ runner: fakeGit({ fetchUrls: ["git@github.com:fork-owner/fork.git"] }), cwd: "/repo" });
  assert.equal(repo, "fork-owner/fork");
});

test("manual E2E may run from a fork but cannot target the fork itself", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "fork-owner", repo: "obsidian-github-sync-multi-platform", branch: "e2e-destructive", token: "secret", expectedRepoId: "123",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("manual E2E from a fork also rejects canonical source target case-insensitively", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "CrystalIceZ", repo: "Obsidian-GitHub-Sync-Multi-Platform", branch: "e2e-destructive", token: "secret", expectedRepoId: "123",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("E2E config rejects missing credentials, invalid target IDs, and protected branches", () => {
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "main", token: "secret", expectedRepoId: "123" }), /protected-looking/i);
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "e2e", token: "", expectedRepoId: "123" }), /token/i);
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "e2e", token: "secret", expectedRepoId: "" }), /EXPECTED_REPO_ID/i);
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "e2e", token: "secret", expectedRepoId: "01" }), /EXPECTED_REPO_ID/i);
  assert.equal(validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "e2e", token: "secret", expectedRepoId: "123" }).expectedRepoId, "123");
});

test("D314 E2E config rejects URL-normalizing owner or repo path segments", () => {
  const base = { owner: "owner", repo: "repo", branch: "e2e/run", token: "secret", expectedRepoId: "123" };
  for (const [owner, repo] of [
    ["..", "repo"], [".", "repo"], ["owner", ".."], ["owner", "."],
    ["ow?ner", "repo"], ["owner", "repo#fragment"], ["owner", "repo\\other"],
    ["owner", "%2e%2e"], ["owner", "repo "],
  ]) assert.throws(() => validateGitHubE2EConfig({...base, owner, repo}),
    /invalid|unsafe/i, owner + "/" + repo);
  assert.equal(validateGitHubE2EConfig({
    ...base, owner: "legitimate-org", repo: "vault.snapshot-2",
  }).targetRepository, "legitimate-org/vault.snapshot-2");
});

test("D312 E2E connection rejects URL-normalizing Git ref paths before credentialed network use", () => {
  const base = { owner: "owner", repo: "repo", token: "secret", expectedRepoId: "123" };
  for (const branch of [
    "e2e/../../main",
    "obsidian-sync-e2e/local-safe/../../protected",
    "e2e/%2e%2e/main",
    "e2e/./trunk",
    "e2e//trunk",
    "e2e/test?branch=main",
    "e2e/test#main",
    "e2e\\..\\main",
  ]) {
    assert.throws(() => validateGitHubE2EConfig({ ...base, branch }),
      /invalid|unsafe|branch/i, branch);
  }
  assert.equal(validateGitHubE2EConfig({
    ...base, branch: "obsidian-sync-e2e/local-aaaaaaaaaaaa-safe_run",
  }).branch, "obsidian-sync-e2e/local-aaaaaaaaaaaa-safe_run");
  assert.equal(validateGitHubE2EConfig({
    ...base, branch: "test/rekey-v1.2",
  }).branch, "test/rekey-v1.2");
});

test("D371 fresh GitHub E2E branch must use an isolated random-size ref name", () => {
  const branch = freshIsolatedGitHubE2EBranch("a".repeat(32));
  assert.equal(branch, "obsidian-sync-e2e/local-" + "a".repeat(32));
  assert.equal(validateGitHubE2EConfig({
    owner: "isolated-owner", repo: "isolated-repo", branch, token: "dummy",
    expectedRepoId: "123456",
  }).branch, branch);
  for (const unsafe of ["", "abcd", "A".repeat(32), "x".repeat(32), "a".repeat(33),
    "../".repeat(8), "a".repeat(31) + "/", undefined]) {
    assert.throws(() => freshIsolatedGitHubE2EBranch(unsafe),
      /random|128-bit/i, "must refuse predictable, malformed or unsafe run IDs");
  }
});

test("native GUI E2E requires a pinned repository ID and rejects conflicting pins", () => {
  assert.equal(resolvePinnedGitHubE2ERepoId("1284153873", undefined), "1284153873");
  assert.equal(resolvePinnedGitHubE2ERepoId(undefined, "1284153873"), "1284153873");
  assert.equal(resolvePinnedGitHubE2ERepoId("1284153873", "1284153873"), "1284153873");
  assert.throws(() => resolvePinnedGitHubE2ERepoId("1284153873", "1284153874"), /conflicting/i);
  for (const value of ["", "0", "01", "-5", "  "]) {
    assert.throws(() => resolvePinnedGitHubE2ERepoId(undefined, value), /EXPECTED_REPO_ID/);
  }
  assert.throws(() => resolvePinnedGitHubE2ERepoId(undefined, undefined), /EXPECTED_REPO_ID/);
});

test("manual live E2E env keeps only the dedicated target token among standard GitHub tokens", () => {
  const source = {
    PATH: "/bin",
    GITHUB_E2E_TOKEN: "e2e-target",
    GH_TOKEN: "source-gh",
    GITHUB_TOKEN: "source-actions",
    GH_ENTERPRISE_TOKEN: "source-enterprise",
    GITHUB_ENTERPRISE_TOKEN: "source-enterprise-actions",
  };
  const sanitized = sanitizeGitHubE2ELiveEnv(source);
  assert.equal(sanitized.GITHUB_E2E_TOKEN, "e2e-target");
  assert.equal(sanitized.GH_TOKEN, undefined);
  assert.equal(sanitized.GITHUB_TOKEN, undefined);
  assert.equal(sanitized.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(sanitized.GITHUB_ENTERPRISE_TOKEN, undefined);
  assert.equal(sanitized.PATH, "/bin");
  assert.equal(source.GH_TOKEN, "source-gh", "sanitizer must not mutate caller env");
});

test("env parser preserves shell-env-wins behavior", async () => {
  assert.deepEqual(parseEnvLine("export FOO='bar'"), ["FOO", "bar"]);
  const cwd = await mkdtemp(join(tmpdir(), "github-e2e-env-"));
  await writeFile(join(cwd, ".env.github-e2e"), "GITHUB_E2E_OWNER=file-owner\nGITHUB_E2E_REPO=file-repo\n");
  const { env } = await loadGitHubE2EEnv({ cwd, env: { GITHUB_E2E_OWNER: "shell-owner" } });
  assert.equal(env.GITHUB_E2E_OWNER, "shell-owner");
  assert.equal(env.GITHUB_E2E_REPO, "file-repo");
});

test("explicit missing env file is an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "github-e2e-env-missing-"));
  await assert.rejects(() => loadGitHubE2EEnv({ cwd, env: { GITHUB_E2E_ENV_FILE: "missing.env" } }), /not found/i);
});

test("qualification branch is deterministic for injected run id and validates inputs", () => {
  assert.equal(qualificationE2EBranch("a".repeat(40), "run_123"), "obsidian-sync-e2e/local-aaaaaaaaaaaa-run_123");
  assert.notEqual(qualificationE2EBranch("a".repeat(40), "run_123"), qualificationE2EBranch("a".repeat(40), "run_124"));
  assert.throws(() => qualificationE2EBranch("ABC", "run_123"), /lowercase commit SHA/i);
  assert.throws(() => qualificationE2EBranch("a".repeat(40), "bad/id"), /run id/i);
});
