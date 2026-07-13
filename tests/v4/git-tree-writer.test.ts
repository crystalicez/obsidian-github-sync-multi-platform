import assert from "node:assert/strict";
import test from "node:test";

import { publishV4TreeChanges } from "../../src/lib/v4/git-tree-writer";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class MemoryV4GitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  blobs: Uint8Array[] = [];
  trees: Array<{ entries: GitHubCreateTreeEntry[]; baseTree?: string }> = [];
  commits: Array<{ message: string; tree: string; parents: string[] }> = [];
  createdRefs: string[] = [];
  updatedRefs: Array<{ sha: string; expected?: string }> = [];
  initializedRef: { ref: string; sha: string; type: string } | null = null;

  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { this.ref = this.initializedRef; return this.ref; }
  async getGitCommit(sha: string) { return { sha, treeSha: "base-tree", parentShas: [] }; }
  async createGitBlob(bytes: Uint8Array) { this.blobs.push(new Uint8Array(bytes)); return `blob-${this.blobs.length}`; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) { this.trees.push({ entries, baseTree }); return `tree-${this.trees.length}`; }
  async createGitCommit(message: string, tree: string, parents: string[]) { this.commits.push({ message, tree, parents }); return `commit-${this.commits.length}`; }
  async createGitRef(sha: string) { this.createdRefs.push(sha); }
  async updateGitRef(sha: string, expected?: string) { this.updatedRefs.push({ sha, expected }); }
}

test("V4 tree writer initializes an empty branch with a root commit", async () => {
  const github = new MemoryV4GitHub();
  const result = await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-1",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("a") }],
  });

  assert.equal(result.commitSha, "commit-1");
  assert.equal(github.trees[0].baseTree, undefined);
  assert.deepEqual(github.commits[0].parents, []);
  assert.deepEqual(github.createdRefs, ["commit-1"]);
  assert.deepEqual(github.updatedRefs, []);
});

test("V4 tree writer updates an existing branch with CAS", async () => {
  const github = new MemoryV4GitHub();
  github.ref = { ref: "refs/heads/main", sha: "commit-old", type: "commit" };
  const result = await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-2",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("b") }],
    deletions: ["Notes/old.md"],
  });

  assert.equal(result.previousHeadSha, "commit-old");
  assert.equal(github.trees[0].baseTree, "base-tree");
  assert.deepEqual(github.commits[0].parents, ["commit-old"]);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expected: "commit-old" }]);
  assert.deepEqual(github.trees[0].entries.at(-1), { path: "Notes/old.md", mode: "100644", type: "blob", sha: null });
});

test("V4 tree writer builds on the bootstrap commit for a truly empty repository", async () => {
  const github = new MemoryV4GitHub();
  github.initializedRef = { ref: "refs/heads/main", sha: "bootstrap", type: "commit" };

  await publishV4TreeChanges(github, {
    message: "obsidian-sync-v4:journal-bootstrap",
    files: [{ path: "Notes/a.md", bytes: new TextEncoder().encode("a") }],
    expectedHeadSha: null,
  });

  assert.equal(github.trees[0].baseTree, "base-tree");
  assert.deepEqual(github.commits[0].parents, ["bootstrap"]);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expected: "bootstrap" }]);
  assert.deepEqual(github.createdRefs, []);
});
