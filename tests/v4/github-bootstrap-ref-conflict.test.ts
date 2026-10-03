import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

test("bootstrap ref creation reconciles a definitive already-exists conflict at the verified SHA", async () => {
  const bootstrapSha = "a".repeat(40);
  let configuredReads = 0;
  let createAttempts = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; method?: string };
    if ((request.method ?? "GET") === "GET" && request.url.includes("/git/ref/heads/main")) {
      configuredReads++;
      if (configuredReads === 1) return { status: 404, text: "missing", headers: {}, json: {} };
      return {
        status: 200,
        text: "",
        headers: {},
        json: { ref: "refs/heads/main", object: { sha: bootstrapSha, type: "commit" } },
      };
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) {
      createAttempts++;
      return { status: 422, text: "Reference already exists", headers: {}, json: {} };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    const internal = client as unknown as {
      ensureConfiguredBootstrapRef(commitSha: string): Promise<{ ref: string; sha: string; type: string }>;
    };

    const observed = await internal.ensureConfiguredBootstrapRef(bootstrapSha);

    assert.equal(observed.sha, bootstrapSha);
    assert.equal(createAttempts, 1);
    assert.equal(configuredReads, 2);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("bootstrap ref creation keeps a definitive conflict at a competitor SHA as a typed race", async () => {
  const bootstrapSha = "a".repeat(40);
  const competitorSha = "b".repeat(40);
  let configuredReads = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; method?: string };
    if ((request.method ?? "GET") === "GET" && request.url.includes("/git/ref/heads/main")) {
      configuredReads++;
      if (configuredReads === 1) return { status: 404, text: "missing", headers: {}, json: {} };
      return {
        status: 200,
        text: "",
        headers: {},
        json: { ref: "refs/heads/main", object: { sha: competitorSha, type: "commit" } },
      };
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) {
      return { status: 422, text: "Reference already exists", headers: {}, json: {} };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    const internal = client as unknown as {
      ensureConfiguredBootstrapRef(commitSha: string): Promise<{ ref: string; sha: string; type: string }>;
    };

    await assert.rejects(
      () => internal.ensureConfiguredBootstrapRef(bootstrapSha),
      (error: unknown) => {
        const candidate = error as { name?: string; observedRefSha?: string };
        assert.equal(candidate.name, "V4RepositoryBootstrapRaceError");
        assert.equal(candidate.observedRefSha, competitorSha);
        return true;
      },
    );
  } finally {
    setRequestUrlHandler(null);
  }
});
