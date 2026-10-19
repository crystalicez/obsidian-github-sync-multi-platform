import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const TREE_SHA = "4".repeat(40);
const ENTRY_SHA = "5".repeat(40);

test("GitHubClient rejects tree entries whose Git mode disagrees with their object type", async () => {
  for (const [label, entry] of [
    ["blob reported as directory mode", { mode: "040000", type: "blob", size: 1 }],
    ["tree reported as regular-file mode", { mode: "100644", type: "tree" }],
    ["gitlink reported as regular-file mode", { mode: "100644", type: "commit" }],
  ] as const) {
    setRequestUrlHandler(async () => ({
      status: 200,
      text: "",
      headers: {},
      json: {
        sha: TREE_SHA,
        url: "",
        truncated: false,
        tree: [{ path: "node", sha: ENTRY_SHA, url: "", ...entry }],
      },
    }));
    try {
      const client = new GitHubClient(
        { token: "token", owner: "owner", repo: "repo", branch: "main" },
        { transportPolicy: { mutationSpacingMs: 0 } },
      );
      await assert.rejects(
        () => client.getTreeAt(TREE_SHA, true),
        /tree entry.*mode|mode.*type|type.*mode|malformed/iu,
        label,
      );
    } finally {
      setRequestUrlHandler(null);
    }
  }
});
