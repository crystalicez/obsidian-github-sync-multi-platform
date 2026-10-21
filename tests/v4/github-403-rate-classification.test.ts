import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { GitHubClient } from "../../src/lib/github-api";

function client() {
  return new GitHubClient({ owner: "owner", repo: "repo", branch: "main", token: "token" }, {
    transportPolicy: {
      maxAttempts: 3,
      mutationSpacingMs: 0,
      secondaryLimitFallbackMs: 0,
      maxSecondaryCooldownMs: 0,
    },
    sleep: async () => {},
  });
}

test("403 permission-denied with ordinary GitHub x-ratelimit-reset must not be retried as a rate limit", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return {
      status: 403,
      text: '{"message":"Resource not accessible by integration"}',
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4800",
        "x-ratelimit-reset": "2000000000" },
      json: { message: "Resource not accessible by integration" },
    };
  });
  try {
    await assert.rejects(() => client().listCommits(), /403/);
    assert.equal(requests, 1,
      "Normal forbidden access must fail promptly rather than retry and cool down");
  } finally {
    setRequestUrlHandler(undefined);
  }
});

test("403 explicit primary rate exhaustion stops after one request under the cooldown policy", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return { status: 403, text: '{"message":"API rate limit exceeded"}',
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
      json: { message: "API rate limit exceeded" } };
  });
  try {
    await assert.rejects(() => client().listCommits(), /403/);
    assert.equal(requests, 1);
  } finally {
    setRequestUrlHandler(undefined);
  }
});

test("403 secondary limit with nonzero primary remaining stops without retry", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return { status: 403, text: '{"message":"You have exceeded a secondary rate limit."}',
      headers: { "x-ratelimit-remaining": "4800", "x-ratelimit-reset": "2000000000" },
      json: { message: "You have exceeded a secondary rate limit." } };
  });
  try {
    await assert.rejects(() => client().listCommits(), /403/);
    assert.equal(requests, 1);
  } finally {
    setRequestUrlHandler(undefined);
  }
});
