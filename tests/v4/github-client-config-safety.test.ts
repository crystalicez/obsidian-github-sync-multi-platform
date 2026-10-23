import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";

const baseline: GitHubConfig = { token: "synthetic-not-real", owner: "crystalicez", repo: "repo.test", branch: "main" };

test("GitHub client fails closed on malformed user-controlled repository coordinates and refs before any API request", () => {
  const invalid: Array<{ patch: Partial<GitHubConfig>; message: RegExp }> = [
    { patch: { owner: "../another" }, message: /Invalid GitHub owner/iu },
    { patch: { owner: "owner/child" }, message: /Invalid GitHub owner/iu },
    { patch: { owner: "a".repeat(40) }, message: /Invalid GitHub owner/iu },
    { patch: { repo: ".." }, message: /Invalid GitHub repository/iu },
    { patch: { repo: "wrong/repo" }, message: /Invalid GitHub repository/iu },
    { patch: { branch: "refs/heads/../main" }, message: /Invalid GitHub branch/iu },
    { patch: { branch: "feature//main" }, message: /Invalid GitHub branch/iu },
    { patch: { branch: "topic.lock" }, message: /Invalid GitHub branch/iu },
    { patch: { branch: "topic@{1}" }, message: /Invalid GitHub branch/iu },
    { patch: { branch: "contains space" }, message: /Invalid GitHub branch/iu },
  ];
  for (const { patch, message } of invalid) {
    assert.throws(() => new GitHubClient({ ...baseline, ...patch }), message, JSON.stringify(patch));
  }
});

test("GitHub client accepts valid nested feature branch and standard hyphenated organization", () => {
  assert.doesNotThrow(() => new GitHubClient({ ...baseline, owner: "valid-org", branch: "feature/rest-safe-8mib" }));
});
