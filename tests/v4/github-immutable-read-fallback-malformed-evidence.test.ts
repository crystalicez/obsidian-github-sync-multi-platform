import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const COMMIT_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);

function response(status: number, json?: unknown, text = "") {
  return { status, json, text, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

async function rejectsMalformedUnrelated(entry: Record<string, unknown>): Promise<void> {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    if (request.url.includes("/contents/missing.md?")) return response(404);
    if (request.url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response(200, { sha: COMMIT_SHA, tree: { sha: TREE_SHA }, parents: [] });
    }
    if (request.url.endsWith(`/git/trees/${TREE_SHA}`)) {
      return response(200, { sha: TREE_SHA, url: "", truncated: false, tree: [entry] });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(
      () => client.getFileBytes("missing.md", COMMIT_SHA),
      /immutable.*tree.*malformed|malformed.*immutable|unsupported.*git.*object/iu,
    );
  } finally {
    setRequestUrlHandler(null);
  }
}

test("complete absence is not inferred from a tree containing malformed or unsupported unrelated entries", async () => {
  await rejectsMalformedUnrelated({ path: "other.md", type: "tag", mode: "100644", sha: OTHER_SHA, url: "" });
  await rejectsMalformedUnrelated({ path: "other.md", type: "blob", mode: 100644, sha: OTHER_SHA, url: "" });
  await rejectsMalformedUnrelated({ path: "other.md", type: "blob", mode: "100644", sha: "short", url: "" });
  await rejectsMalformedUnrelated({ path: "other.md", type: "blob", mode: "040000", sha: OTHER_SHA, url: "" });
  await rejectsMalformedUnrelated({ path: "other.md", type: "blob", mode: "100600", sha: OTHER_SHA, url: "" });
});
