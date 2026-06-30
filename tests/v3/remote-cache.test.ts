import assert from "node:assert/strict";
import test from "node:test";
import { loadRemoteTreeWithCache } from "../../src/lib/v3/remote-cache";
import type { GitHubTree } from "../../src/lib/github-api";

class FakeRemoteCacheGitHub {
  headSha = "head-a";
  getRefCount = 0;
  getTreeCount = 0;
  tree: GitHubTree = { sha: "tree-a", url: "", truncated: false, tree: [] };

  async getGitRef() {
    this.getRefCount += 1;
    return { ref: "refs/heads/main", sha: this.headSha, type: "commit" };
  }

  async getTree() {
    this.getTreeCount += 1;
    return this.tree;
  }
}

test("loadRemoteTreeWithCache skips recursive tree when branch head is unchanged", async () => {
  const github = new FakeRemoteCacheGitHub();
  const first = await loadRemoteTreeWithCache(github, null);
  assert.equal(first.fromCache, false);
  assert.equal(github.getTreeCount, 1);

  const second = await loadRemoteTreeWithCache(github, first.cache);
  assert.equal(second.fromCache, true);
  assert.equal(second.tree.sha, "tree-a");
  assert.equal(github.getRefCount, 2);
  assert.equal(github.getTreeCount, 1);
});

test("loadRemoteTreeWithCache refreshes cache when branch head changes", async () => {
  const github = new FakeRemoteCacheGitHub();
  const first = await loadRemoteTreeWithCache(github, null);
  github.headSha = "head-b";
  github.tree = { sha: "tree-b", url: "", truncated: false, tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-a", url: "" }] };

  const second = await loadRemoteTreeWithCache(github, first.cache);
  assert.equal(second.fromCache, false);
  assert.equal(second.cache.headSha, "head-b");
  assert.equal(second.tree.sha, "tree-b");
  assert.equal(github.getTreeCount, 2);
});

test("loadRemoteTreeWithCache refuses truncated recursive trees", async () => {
  const github = new FakeRemoteCacheGitHub();
  github.tree = { sha: "tree-a", url: "", truncated: true, tree: [] };
  await assert.rejects(() => loadRemoteTreeWithCache(github, null), /truncated remote tree/u);
});