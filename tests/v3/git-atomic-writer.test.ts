import assert from "node:assert/strict";
import test from "node:test";
import { commitGitTreeChanges, GitAtomicRefConflictError } from "../../src/lib/v3/git-atomic-writer";
import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";

class FakeGitHubForAtomicWriter {
  blobs: Uint8Array[] = [];
  trees: Array<{ tree: GitHubCreateTreeEntry[]; baseTree?: string }> = [];
  commits: Array<{ message: string; tree: string; parents: string[] }> = [];
  updatedRefs: Array<{ sha: string; expectedSha?: string }> = [];
  failUpdateStatus?: number;
  getTreeCount = 0;
  getCommitCount = 0;

  async getGitRef() {
    return { ref: "refs/heads/main", sha: "commit-old", type: "commit" };
  }

  async getGitCommit(sha: string) {
    this.getCommitCount += 1;
    return { sha, treeSha: "tree-old", parentShas: [] };
  }

  async getTree() {
    this.getTreeCount += 1;
    return { sha: "tree-old", url: "", truncated: false, tree: [] };
  }

  async createGitBlob(bytes: Uint8Array) {
    this.blobs.push(new Uint8Array(bytes));
    return `blob-${this.blobs.length}`;
  }

  async createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string) {
    this.trees.push({ tree, baseTree });
    return `tree-${this.trees.length}`;
  }

  async createGitCommit(message: string, tree: string, parents: string[]) {
    this.commits.push({ message, tree, parents });
    return `commit-${this.commits.length}`;
  }

  async updateGitRef(sha: string, expectedSha?: string) {
    this.updatedRefs.push({ sha, expectedSha });
    if (this.failUpdateStatus) {
      const error = new Error("Failed to update git ref") as Error & { status?: number };
      error.status = this.failUpdateStatus;
      throw error;
    }
  }
}

class DelayedBlobGitHubForAtomicWriter extends FakeGitHubForAtomicWriter {
  inFlight = 0;
  maxInFlight = 0;

  async createGitBlob(bytes: Uint8Array) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise(resolve => setTimeout(resolve, 10));
    this.inFlight -= 1;
    return super.createGitBlob(bytes);
  }
}

test("commitGitTreeChanges writes multiple files and deletions as one atomic commit", async () => {
  const github = new FakeGitHubForAtomicWriter();
  const result = await commitGitTreeChanges(github, {
    message: "sync: v3 batch",
    files: [
      { path: "Notes/a.md", bytes: new TextEncoder().encode("a") },
      { path: "Notes/b.md", bytes: new TextEncoder().encode("b") },
    ],
    deletions: ["Notes/old.md"],
  });

  assert.equal(result.previousHeadSha, "commit-old");
  assert.equal(result.commitSha, "commit-1");
  assert.equal(result.treeSha, "tree-1");
  assert.deepEqual(result.fileShas, { "Notes/a.md": "blob-1", "Notes/b.md": "blob-2" });
  assert.equal(github.getCommitCount, 1);
  assert.equal(github.getTreeCount, 0);
  assert.equal(github.blobs.length, 2);
  assert.equal(github.trees.length, 1);
  assert.deepEqual(github.trees[0].tree, [
    { path: "Notes/a.md", mode: "100644", type: "blob", sha: "blob-1" },
    { path: "Notes/b.md", mode: "100644", type: "blob", sha: "blob-2" },
    { path: "Notes/old.md", mode: "100644", type: "blob", sha: null },
  ]);
  assert.deepEqual(github.commits, [{ message: "sync: v3 batch", tree: "tree-1", parents: ["commit-old"] }]);
  assert.deepEqual(github.updatedRefs, [{ sha: "commit-1", expectedSha: "commit-old" }]);
});

test("commitGitTreeChanges maps stale ref update to GitAtomicRefConflictError", async () => {
  const github = new FakeGitHubForAtomicWriter();
  github.failUpdateStatus = 409;

  await assert.rejects(
    () => commitGitTreeChanges(github, { message: "sync: stale", files: [{ path: "a.md", bytes: new TextEncoder().encode("a") }] }),
    error => {
      assert.ok(error instanceof GitAtomicRefConflictError);
      assert.equal(error.previousHeadSha, "commit-old");
      assert.equal(error.attemptedCommitSha, "commit-1");
      return true;
    },
  );
});

test("commitGitTreeChanges creates blobs concurrently for large atomic commits", async () => {
  const github = new DelayedBlobGitHubForAtomicWriter();
  await commitGitTreeChanges(github, {
    message: "sync: many blobs",
    files: Array.from({ length: 24 }, (_, index) => ({ path: `file-${index}.bin`, bytes: new Uint8Array([index]) })),
  });

  assert.ok(github.maxInFlight > 1, `expected concurrent blob creation, got maxInFlight=${github.maxInFlight}`);
  assert.equal(github.blobs.length, 24);
});
