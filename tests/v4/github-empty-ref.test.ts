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

test("GitHubClient does not bootstrap when any-ref preflight returns a non-empty 409", async () => {
  let puts = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; method?: string };
    if ((request.method ?? "GET") === "GET" && request.url.includes("/git/refs?")) {
      return {
        status: 409,
        text: "Git Repository is temporarily unavailable.",
        headers: {},
        json: {},
      };
    }
    if (request.method === "PUT") {
      puts++;
      return { status: 500, text: "bootstrap must not run", headers: {}, json: {} };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );

    await assert.rejects(() => client.ensureGitRepositoryInitialized());
    assert.equal(puts, 0, "generic ref conflicts must fail before Contents bootstrap mutation");
  } finally {
    setRequestUrlHandler(null);
  }
});
