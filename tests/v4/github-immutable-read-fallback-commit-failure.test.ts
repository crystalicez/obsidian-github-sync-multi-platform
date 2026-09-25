import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const COMMIT_SHA = "a".repeat(40);

function response(status: number, text = "", json?: unknown) {
  return { status, text, headers: {}, json, arrayBuffer: new ArrayBuffer(0) };
}

test("immutable Contents 404 propagates commit lookup failure without reading a tree", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    urls.push(request.url);
    if (request.url.includes("/contents/target.md?")) return response(404, "contents lag");
    if (request.url.endsWith(`/git/commits/${COMMIT_SHA}`)) return response(502, "commit unavailable");
    throw new Error(`Unexpected request: ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(
      () => client.getFileBytes("target.md", COMMIT_SHA),
      /Failed to get git commit.*502/iu,
    );
    assert.equal(urls.filter(url => url.includes("/git/commits/")).length, 1);
    assert.equal(urls.some(url => url.includes("/git/trees/")), false);
  } finally {
    setRequestUrlHandler(null);
  }
});
