import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const TREE_SHA = "a".repeat(40);
const BLOB_SHA = "b".repeat(40);
const DIR_SHA = "c".repeat(40);

const blob = (path: string) => ({ path, type: "blob", mode: "100644", sha: BLOB_SHA, size: 3, url: "" });
const directory = (path: string) => ({ path, type: "tree", mode: "040000", sha: DIR_SHA, url: "" });

async function readTree(entries: object[], recursive: boolean) {
  setRequestUrlHandler(async () => ({
    status: 200,
    text: "",
    headers: {},
    json: { sha: TREE_SHA, url: "", truncated: false, tree: entries },
  }));
  try {
    const client = new GitHubClient(
      { owner: "owner", repo: "repo", branch: "main", token: "fake" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    return await client.getTreeAt(TREE_SHA, recursive);
  } finally {
    setRequestUrlHandler(null);
  }
}

test("non-recursive Git trees must not accept nested paths as direct children", async () => {
  await assert.rejects(
    () => readTree([blob("Notes/deep.md")], false),
    /malformed.*tree.*path|tree.*path.*invalid|non-recursive.*path/iu,
  );
  const result = await readTree([directory("Notes"), blob("hello.md")], false);
  assert.deepEqual(result.tree.map(node => node.path), ["Notes", "hello.md"]);
});

test("recursive Git trees reject a blob pretending to be a directory ancestor", async () => {
  await assert.rejects(
    () => readTree([blob("Notes"), blob("Notes/deep.md")], true),
    /malformed.*tree.*path|tree.*path.*invalid|ancestor.*blob/iu,
  );
  await assert.rejects(
    () => readTree([blob("Notes/deep.md"), blob("Notes")], true),
    /malformed.*tree.*path|tree.*path.*invalid|ancestor.*blob/iu,
  );
});

test("recursive Git trees reject empty and navigation path segments", async () => {
  for (const path of ["Notes//deep.md", "/absolute.md", "Notes/../escape.md", "Notes/./deep.md", "Notes/trailing/", "Notes/zero\u0000.md"]) {
    await assert.rejects(
      () => readTree([blob(path)], true),
      /malformed.*tree.*path|tree.*path.*invalid/iu,
      path,
    );
  }
});

test("recursive Git trees preserve valid Unicode, punctuation, and directory descendants", async () => {
  const tree = await readTree([
    directory("Notes"),
    blob("Notes/ภาษาไทย.md"),
    directory("Notes/sub dir"),
    blob("Notes/sub dir/💎 \u0023(1).md"),
    blob("root+test & (backup).md"),
  ], true);
  assert.deepEqual(tree.tree.map(node => node.path), [
    "Notes", "Notes/ภาษาไทย.md", "Notes/sub dir", "Notes/sub dir/💎 #(1).md", "root+test & (backup).md",
  ]);
});
