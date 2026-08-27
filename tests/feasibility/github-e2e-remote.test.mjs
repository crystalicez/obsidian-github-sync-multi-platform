import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupE2EBranch,
  preflightE2ERemote,
  readE2EBranch,
  readE2ERepository,
} from "../../scripts/github-e2e-remote.mjs";

function response(status, body) {
  return {
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function fakeFetch(sequence, calls = []) {
  let index = 0;
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    const next = sequence[index++];
    if (next instanceof Error) throw next;
    if (!next) throw new Error(`No fake response for call ${index}: ${url}`);
    return next;
  };
  fn.remaining = () => sequence.length - index;
  return fn;
}

test("remote preflight rejects actual default branch before mutation", async () => {
  const fetchImpl = fakeFetch([response(200, { default_branch: "trunk" })]);
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl,
    config: { owner: "test", repo: "repo", branch: "trunk", token: "secret" },
  }), /default branch/i);
});

test("remote preflight accepts a safe non-default branch", async () => {
  const fetchImpl = fakeFetch([response(200, { default_branch: "trunk" })]);
  const result = await preflightE2ERemote({
    fetchImpl,
    config: { owner: "test", repo: "repo", branch: "e2e/run-1", token: "secret" },
  });
  assert.equal(result.defaultBranch, "trunk");
});

test("repository lookup fails closed for HTTP errors and malformed responses", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(() => readE2ERepository({
      fetchImpl: fakeFetch([response(status, {})]), owner: "test", repo: "repo", token: "secret",
    }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(() => readE2ERepository({
    fetchImpl: fakeFetch([response(200, new Error("bad json"))]), owner: "test", repo: "repo", token: "secret",
  }), /malformed JSON/i);
  await assert.rejects(() => readE2ERepository({
    fetchImpl: fakeFetch([response(200, { default_branch: "" })]), owner: "test", repo: "repo", token: "secret",
  }), /default branch/i);
});

test("branch lookup distinguishes absent, present, and unknown", async () => {
  assert.deepEqual(await readE2EBranch({
    fetchImpl: fakeFetch([response(404)]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), { kind: "absent" });
  const sha = "a".repeat(40);
  assert.deepEqual(await readE2EBranch({
    fetchImpl: fakeFetch([response(200, { object: { sha } })]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), { kind: "present", sha });
  await assert.rejects(() => readE2EBranch({
    fetchImpl: fakeFetch([response(500, {})]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), /HTTP 500/i);
  await assert.rejects(() => readE2EBranch({
    fetchImpl: fakeFetch([new Error("network")]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), /network error/i);
});

test("cleanup deletes a present unique branch and verifies absence", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    response(200, { object: { sha: "a".repeat(40) } }),
    response(204),
    response(404),
  ], calls);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-abc-run", token: "secret", sleep: async () => {},
  });
  assert.equal(calls[1].options.method, "DELETE");
  assert.match(calls[0].url, /heads\/obsidian-sync-e2e\/local-abc-run$/u);
});

test("cleanup succeeds when the branch is already absent", async () => {
  const fetchImpl = fakeFetch([response(404)]);
  await cleanupE2EBranch({ fetchImpl, owner: "test", repo: "repo", branch: "gone", token: "secret", sleep: async () => {} });
  assert.equal(fetchImpl.remaining(), 0);
});

test("cleanup retries a failed server-side delete after verifying the branch remains", async () => {
  const sleeps = [];
  const fetchImpl = fakeFetch([
    response(200, { object: { sha: "a".repeat(40) } }), response(500), response(200, { object: { sha: "a".repeat(40) } }),
    response(200, { object: { sha: "a".repeat(40) } }), response(204), response(404),
  ]);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "e2e/retry", token: "secret", sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [2000]);
});

test("cleanup fails if the branch persists after bounded attempts", async () => {
  const present = () => response(200, { object: { sha: "a".repeat(40) } });
  const fetchImpl = fakeFetch([
    present(), response(204), present(),
    present(), response(204), present(),
  ]);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "e2e/stuck", token: "secret", sleep: async () => {}, maxAttempts: 2,
  }), /still exists/i);
});

test("cleanup treats auth and network failures as unknown, not success", async () => {
  const present = response(200, { object: { sha: "a".repeat(40) } });
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl: fakeFetch([present, response(403)]), owner: "test", repo: "repo", branch: "e2e/x", token: "secret", sleep: async () => {},
  }), /HTTP 403/i);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl: fakeFetch([new Error("offline")]), owner: "test", repo: "repo", branch: "e2e/x", token: "secret", sleep: async () => {},
  }), /network error/i);
});

test("branch path encodes each branch segment safely", async () => {
  const calls = [];
  await readE2EBranch({
    fetchImpl: fakeFetch([response(404)], calls), owner: "o wner", repo: "r#po", branch: "a b/x#y", token: "secret",
  });
  assert.match(calls[0].url, /repos\/o%20wner\/r%23po\/git\/ref\/heads\/a%20b\/x%23y$/u);
  assert.doesNotMatch(calls[0].url, /secret/u);
});
