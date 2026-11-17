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

test("D314 exported E2E GitHub readers refuse URL-normalizing coordinates and ref paths before credentialed I/O", async () => {
  const unsafeCoordinates = [
    ["..", "repo"], [".", "repo"], ["test", ".."], ["test", "."],
    ["test", "%2e%2e"], ["te?st", "repo"], ["test", "repo#fragment"],
    ["test", "repo\\other"],
  ];
  const escapedUrl = new URL("https://api.github.com/repos/../repo").pathname;
  assert.equal(escapedUrl, "/repo", "dot owner would redirect the requested API path");
  for (const [owner, repo] of unsafeCoordinates) {
    const calls = [];
    await assert.rejects(() => readE2ERepository({
      fetchImpl: fakeFetch([], calls), owner, repo, token: "private-token",
    }), /invalid|unsafe/i, owner + "/" + repo);
    assert.equal(calls.length, 0, "unsafe repository coordinates must not send credentials");
    await assert.rejects(() => readE2EBranch({
      fetchImpl: fakeFetch([], calls), owner, repo, branch: "e2e/safe",
      token: "private-token",
    }), /invalid|unsafe/i);
    assert.equal(calls.length, 0, "unsafe ref lookup must not send credentials");
  }
  for (const branch of ["e2e/../../protected", "safe/./protected", "safe/%2e%2e/protected"]) {
    const calls = [];
    await assert.rejects(() => readE2EBranch({
      fetchImpl: fakeFetch([], calls), owner: "test", repo: "repo",
      branch, token: "private-token",
    }), /invalid|unsafe/i, branch);
    assert.equal(calls.length, 0, "unsafe ref path must not send credentials");
  }
});

test("D314 E2E preflight and cleanup reject unsafe repository coordinates before even the first GET", async () => {
  for (const [owner, repo] of [["..", "repo"], ["test", ".."], ["test", "repo#fragment"]]) {
    const calls = [];
    await assert.rejects(() => preflightE2ERemote({
      fetchImpl: fakeFetch([], calls),
      config: {...config(), owner, repo},
    }), /invalid|unsafe/i);
    await assert.rejects(() => cleanupE2EBranch({
      fetchImpl: fakeFetch([], calls), owner, repo,
      branch: "obsidian-sync-e2e/local-123456abcdef-fixture",
      token: "private-token", expectedRepoId: "123", currentSourceRepoId: "777",
      sleep: async () => {},
    }), /invalid|unsafe/i);
    assert.equal(calls.length, 0, "a dangerous target path must fail closed before any API request");
  }
});

test("D312 direct remote preflight rejects an unsafe branch without any network requests", async () => {
  const calls = [];
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([], calls),
    config: config("e2e/../../trunk"),
  }), /unsafe|invalid.*branch/i);
  assert.equal(calls.length, 0);
});

test("D312 remote repository metadata refuses a URL-normalizing default branch", async () => {
  const calls = [];
  await assert.rejects(() => preflightE2ERemote({
    fetchImpl: fakeFetch([repo(123, "e2e/../../protected"), ref()], calls),
    config: config(),
  }), /default branch|unsafe/i);
  assert.equal(calls.length, 1,
    "an untrusted remote default-branch name must not be turned into a Git ref request");
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

test("D312 destructive E2E cleanup rejects a dot-segment branch before contacting GitHub", async () => {
  const branch = "obsidian-sync-e2e/local-safe/../../protected";
  const rawDelete = "https://api.github.com/repos/test/repo/git/refs/heads/" + branch;
  assert.equal(new URL(rawDelete).pathname, "/repos/test/repo/git/refs/heads/protected",
    "URL normalization would redirect deletion from the disposable prefix to an unrelated Git branch");
  const calls = [];
  const fetchImpl = fakeFetch([
    repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }),
    response(204), repo(), ref(), response(404),
  ], calls);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch,
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  }), /restricted|unsafe|invalid.*branch/i);
  assert.equal(calls.length, 0, "ref-path validation must run before any network request, especially DELETE");
});

test("D312 destructive E2E cleanup rejects disguised branch delimiters and extra path segments", async () => {
  for (const branch of [
    "obsidian-sync-e2e/local-safe/../protected",
    "obsidian-sync-e2e/local-safe/%2e%2e/protected",
    "obsidian-sync-e2e/local-safe/extra",
    "obsidian-sync-e2e/local-safe?ref=protected",
    "obsidian-sync-e2e/local-safe#protected",
    "obsidian-sync-e2e/local-safe\\..\\protected",
  ]) {
    const calls = [];
    await assert.rejects(() => cleanupE2EBranch({
      fetchImpl: fakeFetch([], calls), owner: "test", repo: "repo", branch,
      token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
    }), /restricted|unsafe|invalid.*branch/i, branch);
    assert.equal(calls.length, 0, "unsafe cleanup name must not generate even a GET request: " + branch);
  }
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
    repo(), ref(), response(404),
  ], calls);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-abc-run",
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  });
  assert.match(calls[2].url, /\/git\/ref\/heads\/obsidian-sync-e2e\/local-abc-run$/u);
  assert.equal(calls[3].options.method, "DELETE");
  assert.match(calls[6].url, /\/git\/ref\/heads\/obsidian-sync-e2e\/local-abc-run$/u);
  assert.equal(fetchImpl.remaining(), 0);
});

test("cleanup succeeds for an absent branch only when absence is re-read after the final target proof", async () => {
  const fetchImpl = fakeFetch([repo(), ref(), response(404), repo(), ref(), response(404)]);
  await cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-gone", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  });
  assert.equal(fetchImpl.remaining(), 0);
});

test("D311 cleanup never deletes a disposable-name branch which reappeared after confirmed absence", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    repo(), ref(), response(404),
    repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }),
    response(204),
    repo(), ref(), response(404),
  ], calls);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-recreated",
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
  }), /reappeared|unexpected branch|manual cleanup/i);
  assert.equal(calls.some(call => call.options?.method === "DELETE"), false,
    "a new unknown owner must never be deleted because its name matches the test prefix");
});

test("D311 cleanup never retries DELETE against a branch whose Git commit changed", async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }), response(500),
    repo(), ref(), response(200, { object: { sha: DEFAULT_SHA } }),
    repo(), ref(), response(200, { object: { sha: DEFAULT_SHA } }), response(204),
    repo(), ref(), response(404),
  ], calls);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-changed",
    token: "secret", expectedRepoId: "123", currentSourceRepoId: "777", sleep: async () => {},
    maxAttempts: 3,
  }), /changed|different commit|manual cleanup/i);
  assert.equal(calls.filter(call => call.options?.method === "DELETE").length, 1,
    "a changed branch may belong to another writer and cannot be deleted a second time");
});

test("cleanup retries a failed server-side delete after verifying the branch remains", async () => {
  const sleeps = [];
  const fetchImpl = fakeFetch([
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }), response(500),
    repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }),
    repo(), ref(), response(200, { object: { sha: PRESENT_SHA } }), response(204),
    repo(), ref(), response(404),
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
    repo(), ref(), present(), response(204),
    repo(), ref(), present(),
    repo(), ref(), present(), response(204),
    repo(), ref(), present(),
  ]);
  await assert.rejects(() => cleanupE2EBranch({
    fetchImpl, owner: "test", repo: "repo", branch: "obsidian-sync-e2e/local-stuck", token: "secret", expectedRepoId: "123", currentSourceRepoId: "777",
    sleep: async () => {}, maxAttempts: 2,
  }), /still exists/i);
});

test("cleanup fails closed if target identity changes during post-delete verification", async () => {
  const fetchImpl = fakeFetch([
    repo(), ref(),
    response(200, { object: { sha: PRESENT_SHA } }), response(204),
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

test("valid E2E branch path retains its exact repository and ref identity", async () => {
  const calls = [];
  await readE2EBranch({
    fetchImpl: fakeFetch([response(404)], calls),
    owner: "test-owner", repo: "repo.snapshot", branch: "e2e/safe-v1.2",
    token: "secret",
  });
  assert.equal(new URL(calls[0].url).pathname,
    "/repos/test-owner/repo.snapshot/git/ref/heads/e2e/safe-v1.2");
  assert.doesNotMatch(calls[0].url, /secret/u);
});
