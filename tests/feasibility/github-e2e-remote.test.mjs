import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupE2EBranch,
  preflightE2ERemote,
  readE2EBranch,
  readE2ERepository,
} from "../../scripts/github-e2e-remote.mjs";

const DEFAULT_SHA = "d".repeat(40);
const PRESENT_SHA = "a".repeat(40);

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

const repo = (id = 123, defaultBranch = "trunk") => response(200, { id, default_branch: defaultBranch });
const ref = (sha = DEFAULT_SHA) => response(200, { object: { sha } });
const config = (branch = "e2e/run-1", expectedRepoId = "123") => ({
  owner: "test", repo: "repo", branch, token: "secret", expectedRepoId,
});

test("remote preflight rejects actual default branch before mutation", async () => {
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo()]),
    config: config("trunk"),
  }), /default branch/i);
});

test("remote preflight rejects a repository route whose numeric ID changed", async () => {
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo(999)]),
    config: config(),
  }), /repository ID/i);
});

test("remote preflight rejects canonical and current source repository IDs", async () => {
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo(1282135059)]),
    config: config("e2e/run-1", "1282135059"),
  }), /source repository ID/i);
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo(777)]),
    config: { ...config("e2e/run-1", "777"), currentSourceRepoId: "777" },
  }), /source repository ID/i);
});

test("remote preflight requires readable default-ref capability", async () => {
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo(), response(404)]),
    config: config(),
  }), /default Git ref/i);
});

test("remote preflight accepts only a pinned safe non-default branch", async () => {
  const result = await preflightE2ERemote({
    fetchImpl: fakeFetch([repo(), ref()]),
    config: config(),
  });
  assert.deepEqual(result, { id: "123", defaultBranch: "trunk", defaultBranchSha: DEFAULT_SHA });
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
    fetchImpl: fakeFetch([response(200, { id: 123, default_branch: "" })]), owner: "test", repo: "repo", token: "secret",
  }), /default branch/i);
  await assert.rejects(() => readE2ERepository({
    fetchImpl: fakeFetch([response(200, { id: 0, default_branch: "trunk" })]), owner: "test", repo: "repo", token: "secret",
  }), /repository ID/i);
});

test("branch lookup distinguishes absent, present, and unknown", async () => {
  assert.deepEqual(await readE2EBranch({
    fetchImpl: fakeFetch([response(404)]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), { kind: "absent" });
  assert.deepEqual(await readE2EBranch({
    fetchImpl: fakeFetch([response(200, { object: { sha: PRESENT_SHA } })]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), { kind: "present", sha: PRESENT_SHA });
  await assert.rejects(() => readE2EBranch({
    fetchImpl: fakeFetch([response(500, {})]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), /HTTP 500/i);
  await assert.rejects(() => readE2EBranch({
    fetchImpl: fakeFetch([new Error("network")]), owner: "test", repo: "repo", branch: "x/y", token: "secret",
  }), /network error/i);
});

test("cleanup rejects non-local branch namespaces before any remote request", async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "feature/do-not-delete",
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  }), /restricted.*local/i);
  assert.equal(fetchImpl.remaining(), 0);
});

test("cleanup deletes a present unique branch, verifies absence, and re-proves pinned target capability", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }),
    response(204),
    response(404),
    repo(), ref(),
  ], calls);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-abc-run",
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  });
  assert.match(calls[2].url, /\/git\/ref\/heads\/obsidian-sync-e2e\/local-abc-run$/u);
  assert.equal(calls[3].options.method, "DELETE");
  assert.match(calls[4].url, /\/git\/ref\/heads\/obsidian-sync-e2e\/local-abc-run$/u);
  assert.equal(fetchImpl.remaining(), 0);
});

test("cleanup succeeds for an absent branch only after pinned target capability is proved twice", async () => {
  const fetchImpl = fakeFetch([repo(), ref(), response(404), repo(), ref()]);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-gone", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  });
  assert.equal(fetchImpl.remaining(), 0);
});

test("cleanup retries a failed server-side delete after verifying the branch remains", async () => {
  const sleeps = [];
  const fetchImpl = fakeFetch([
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }), response(500), response(200, { object: { sha: PRESENT_SHA } }),
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }), response(204), response(404),
    repo(), ref(),
  ]);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-retry", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777",
    sleep: async ms => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [2000]);
});

test("cleanup fails if the branch persists after bounded attempts", async () => {
  const present = () => response(200, { object: { sha: PRESENT_SHA } });
  const fetchImpl = fakeFetch([
    repo(), ref(),
    present(), response(204), present(),
    repo(), ref(),
    present(), response(204), present(),
  ]);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-stuck", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777",
    sleep: async () => {}, maxAttempts: 2,
  }), /still exists/i);
});

test("cleanup fails closed if target identity changes during post-delete verification", async () => {
  const fetchImpl = fakeFetch([
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }), response(204), response(404),
    repo(999),
  ]);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-x", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  }), /repository ID/i);
});

test("cleanup treats auth and network failures as unknown, not success", async () => {
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl: fakeFetch([repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }), response(403)]),
    owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-x", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  }), /HTTP 403/i);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl: fakeFetch([new Error("offline")]),
    owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-x", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
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
