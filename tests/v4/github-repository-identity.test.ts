import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { GitHubClient } from "../../src/lib/github-api";

const makeClient = () => new GitHubClient({
  owner: "owner", repo: "repo", branch: "main", token: "synthetic",
}, { transportPolicy: { mutationSpacingMs: 0 } });
const respond = (json: unknown, status = 200) => ({
  status, json, text: status === 200 ? "" : "unavailable",
  headers: {}, arrayBuffer: new ArrayBuffer(0),
});

test("D72 verifies numeric GitHub repository identity via a single authenticated read-only GET", async () => {
  const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
  setRequestUrlHandler(async value => {
    const req = value as { url: string; method?: string; body?: unknown };
    seen.push(req);
    return respond({ id: 1284153873, full_name: "Owner/Repo" });
  });
  try {
    const value = await makeClient().getRepositoryIdentity();
    assert.deepEqual(value, { id: 1284153873, fullName: "Owner/Repo" });
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /^https:\/\/api\.github\.com\/repos\/owner\/repo$/);
    assert.equal(seen[0]!.method, "GET");
    assert.equal(seen[0]!.body, undefined);
  } finally { setRequestUrlHandler(null); }
});

test("D72 rejects malformed repository ids and full_name rather than guessing", async () => {
  const bad = [
    { id: null, full_name: "owner/repo" },
    { id: "1284153873", full_name: "owner/repo" },
    { id: 0, full_name: "owner/repo" },
    { id: -1, full_name: "owner/repo" },
    { id: 1.5, full_name: "owner/repo" },
    { id: Number.MAX_SAFE_INTEGER + 1, full_name: "owner/repo" },
    { id: 42, full_name: "" },
    { id: 42, full_name: "owner/repo#main" },
    { id: 42, full_name: "../repo" },
    { id: 42, full_name: "owner/other/path" },
  ];
  try {
    for (const body of bad) {
      setRequestUrlHandler(async () => respond(body));
      await assert.rejects(() => makeClient().getRepositoryIdentity(), /GitHub repository identity/i);
    }
    setRequestUrlHandler(async () => respond({}, 404));
    await assert.rejects(() => makeClient().getRepositoryIdentity(), /repository identity|HTTP 404/i);
  } finally { setRequestUrlHandler(null); }
});
