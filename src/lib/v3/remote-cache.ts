import type { GitHubTree } from "../github-api";
import type { GitHubGitRef } from "../github-git-types";

export interface RemoteTreeCache {
  headSha: string;
  tree: GitHubTree;
}

export interface RemoteTreeGithub {
  getGitRef(): Promise<GitHubGitRef>;
  getTree(): Promise<GitHubTree>;
}

export interface RemoteTreeLoadResult {
  headSha: string;
  tree: GitHubTree;
  cache: RemoteTreeCache;
  fromCache: boolean;
}

export async function loadRemoteTreeWithCache(github: RemoteTreeGithub, cache: RemoteTreeCache | null | undefined): Promise<RemoteTreeLoadResult> {
  const ref = await github.getGitRef();
  if (cache && cache.headSha === ref.sha) {
    return { headSha: ref.sha, tree: cache.tree, cache, fromCache: true };
  }

  const tree = await github.getTree();
  if (tree.truncated) throw new Error("Cannot sync safely from a truncated remote tree.");
  const nextCache = { headSha: ref.sha, tree };
  return { headSha: ref.sha, tree, cache: nextCache, fromCache: false };
}