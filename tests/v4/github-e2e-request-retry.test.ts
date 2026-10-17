import assert from "node:assert/strict";
import test from "node:test";

import { fetchGitHubE2EWithRetry } from "../github-e2e/support/request-retry";

test("GitHub E2E does not replay an uncertain ref PATCH after HTTP 503", async () => {
  const methods: string[] = [];
  const response = await fetchGitHubE2EWithRetry(
    "https://api.github.com/repos/test/repo/git/refs/heads/e2e",
    { method: "PATCH", body: JSON.stringify({ sha: "a".repeat(40), force: false }) },
    async (_url, init) => {
      methods.push(init.method ?? "GET");
      return new Response("", { status: methods.length === 1 ? 503 : 200 });
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(methods, ["PATCH"]);
});

test("GitHub E2E does not replay POST blob or commit creation after HTTP 503", async () => {
  let calls = 0;
  const response = await fetchGitHubE2EWithRetry(
    "https://api.github.com/repos/test/repo/git/commits",
    { method: "POST", body: "{}" },
    async () => {
      calls++;
      return new Response("", { status: calls === 1 ? 503 : 201 });
    },
  );
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("GitHub E2E may retry read-only GET after a transient server error", async () => {
  let calls = 0;
  const response = await fetchGitHubE2EWithRetry(
    "https://api.github.com/repos/test/repo/git/ref/heads/e2e",
    { method: "GET" },
    async () => {
      calls++;
      return new Response("", { status: calls === 1 ? 503 : 200 });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("GitHub E2E leaves an unauthorized read un-retried", async () => {
  let calls = 0;
  const response = await fetchGitHubE2EWithRetry(
    "https://api.github.com/repos/test/repo/git/ref/heads/e2e",
    { method: "GET" },
    async () => {
      calls++;
      return new Response("", { status: 401 });
    },
  );
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("GitHub E2E never replays any write method on a throttled response", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let calls = 0;
    const response = await fetchGitHubE2EWithRetry(
      "https://api.github.com/repos/test/repo/git/refs/heads/e2e",
      { method },
      async () => {
        calls++;
        return new Response("", { status: calls === 1 ? 429 : 200 });
      },
    );
    assert.equal(response.status, 429, method);
    assert.equal(calls, 1, method);
  }
});

test("GitHub E2E does not replay a mutation after an unknown network outcome", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGitHubE2EWithRetry(
      "https://api.github.com/repos/test/repo/git/refs/heads/e2e",
      { method: "PATCH" },
      async () => {
        calls++;
        throw new Error("connection dropped after remote mutation");
      },
    ),
    /connection dropped after remote mutation/u,
  );
  assert.equal(calls, 1);
});
