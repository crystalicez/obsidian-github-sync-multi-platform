import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

test("GitHubClient treats HTTP 409 from an empty Git database as an absent configured ref", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; method?: string };
    assert.match(request.url, /\/git\/ref\/heads\/main/u);
    return {
      status: 409,
      text: "Git Repository is empty.",
      headers: {},
      json: {},
    };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );

    assert.equal(await client.getGitRefOrNull(), null);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient keeps a non-empty 409 ref conflict fail-closed instead of entering bootstrap", async () => {
  setRequestUrlHandler(async () => ({
    status: 409,
    text: "Git Repository is temporarily unavailable.",
    headers: {},
    json: {},
  }));
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );

    await assert.rejects(
      () => client.getGitRefOrNull(),
      /409|unavailable|conflict/iu,
    );
  } finally {
    setRequestUrlHandler(null);
  }
});
