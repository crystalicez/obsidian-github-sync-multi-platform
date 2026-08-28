import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_REPOSITORY,
  parseGitHubRemote,
  readOriginFetchRepository,
  requireCanonicalOriginEndpoints,
} from "../../scripts/github-repo.mjs";
import {
  loadGitHubE2EEnv,
  parseEnvLine,
  qualificationE2EBranch,
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
    owner: "fork-owner", repo: "obsidian-github-sync-multi-platform", branch: "e2e-destructive", token: "secret",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("manual E2E from a fork also rejects canonical source target case-insensitively", () => {
  assert.throws(() => validateGitHubE2EConfig({
    owner: "CrystalIceZ", repo: "Obsidian-GitHub-Sync-Multi-Platform", branch: "e2e-destructive", token: "secret",
    currentSourceRepo: "fork-owner/obsidian-github-sync-multi-platform",
  }), /source repository/i);
});

test("E2E config rejects missing credentials and protected branches", () => {
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "main", token: "secret" }), /protected-looking/i);
  assert.throws(() => validateGitHubE2EConfig({ owner: "owner", repo: "repo", branch: "e2e", token: "" }), /token/i);
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
