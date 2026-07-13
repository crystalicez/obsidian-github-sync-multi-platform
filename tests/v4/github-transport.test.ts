import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler";

test("GitHubClient pins the API version and paginates commit history", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    requests.push(options as Record<string, any>);
    return {
      status: 200,
      text: "",
      headers: {},
      json: [{
        sha: "commit-1",
        commit: { message: "obsidian-sync-v4:journal-1", author: { date: "2026-07-13T00:00:00Z", name: "Sync" } },
        parents: [{ sha: "parent-1" }],
      }],
    };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
    const commits = await client.listCommits({ page: 2, perPage: 50 });

    assert.equal(commits[0].sha, "commit-1");
    assert.deepEqual(commits[0].parentShas, ["parent-1"]);
    assert.match(requests[0].url, /commits\?sha=main&per_page=50&page=2/u);
    assert.equal(requests[0].headers["X-GitHub-Api-Version"], "2026-03-10");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient reads historical trees and can create a branch ref", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.method === "POST") return { status: 201, text: "", headers: {}, json: { ref: "refs/heads/v4", object: { sha: "root" } } };
    return { status: 200, text: "", headers: {}, json: { sha: "tree-old", url: "", tree: [], truncated: false } };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4" });
    const tree = await client.getTreeAt("tree-old", false);
    await client.createGitRef("root");

    assert.equal(tree.sha, "tree-old");
    assert.equal(requests[0].url.endsWith("/git/trees/tree-old"), true);
    assert.deepEqual(JSON.parse(requests[1].body), { ref: "refs/heads/v4", sha: "root" });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("V4 request scheduler retries rate limits after the requested delay", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const scheduler = new V4RequestScheduler({
    readConcurrency: 2,
    writeConcurrency: 1,
    sleep: async ms => { sleeps.push(ms); },
  });
  const result = await scheduler.run("write", async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("rate limited") as Error & { status?: number; headers?: Record<string, string> };
      error.status = 429;
      error.headers = { "retry-after": "2" };
      throw error;
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("GitHubClient routes REST calls through rate-limit retries", async () => {
  let attempts = 0;
  setRequestUrlHandler(async () => {
    attempts += 1;
    if (attempts === 1) return { status: 429, text: "limited", headers: { "retry-after": "0" }, json: {} };
    return { status: 200, text: "", headers: {}, json: [] };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
    assert.deepEqual(await client.listCommits(), []);
    assert.equal(attempts, 2);
  } finally {
    setRequestUrlHandler(null);
  }
});
