import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../github-git-types";
import type { GitHubTree } from "../github-api";

export interface GitAtomicWriteFile {
  path: string;
  bytes: Uint8Array;
}

export interface GitAtomicWriteInput {
  message: string;
  files: GitAtomicWriteFile[];
  deletions?: string[];
}

export interface GitAtomicWriteResult {
  previousHeadSha: string;
  baseTreeSha: string;
  treeSha: string;
  commitSha: string;
  fileShas: Record<string, string>;
}

export interface GitAtomicGithub {
  getGitRef(): Promise<GitHubGitRef>;
  getTree(): Promise<GitHubTree>;
  getGitCommit?: (sha: string) => Promise<GitHubGitCommit>;
  createGitBlob(bytes: Uint8Array): Promise<string>;
  createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string): Promise<string>;
  createGitCommit(message: string, tree: string, parents: string[]): Promise<string>;
  updateGitRef(sha: string, expectedSha?: string): Promise<void>;
}

export class GitAtomicRefConflictError extends Error {
  constructor(
    public readonly previousHeadSha: string,
    public readonly attemptedCommitSha: string,
    public readonly causeError: unknown,
  ) {
    super("Git branch head changed before the atomic sync commit could be published.");
    this.name = "GitAtomicRefConflictError";
  }
}

function isRefConflict(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  return status === 409 || status === 422;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function commitGitTreeChanges(github: GitAtomicGithub, input: GitAtomicWriteInput): Promise<GitAtomicWriteResult> {
  const ref = await github.getGitRef();
  let baseTreeSha: string;
  if (typeof github.getGitCommit === "function") {
    baseTreeSha = (await github.getGitCommit(ref.sha)).treeSha;
  } else {
    const baseTree = await github.getTree();
    if (baseTree.truncated) throw new Error("Cannot create atomic sync commit from a truncated remote tree.");
    baseTreeSha = baseTree.sha;
  }

  const tree: GitHubCreateTreeEntry[] = [];
  const fileShas: Record<string, string> = {};
  const blobWrites = await mapWithConcurrency(input.files, 8, async (file) => ({
    file,
    sha: await github.createGitBlob(file.bytes),
  }));
  for (const { file, sha } of blobWrites) {
    fileShas[file.path] = sha;
    tree.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  for (const path of input.deletions ?? []) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }

  const treeSha = await github.createGitTree(tree, baseTreeSha);
  const commitSha = await github.createGitCommit(input.message, treeSha, [ref.sha]);
  try {
    await github.updateGitRef(commitSha, ref.sha);
  } catch (error) {
    if (isRefConflict(error)) throw new GitAtomicRefConflictError(ref.sha, commitSha, error);
    throw error;
  }

  return { previousHeadSha: ref.sha, baseTreeSha, treeSha, commitSha, fileShas };
}
