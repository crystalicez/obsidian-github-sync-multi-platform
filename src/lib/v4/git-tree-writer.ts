import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../github-git-types";

export interface V4GitTreeFile { path: string; bytes: Uint8Array; }
export interface V4GitTreeWriteInput { message: string; files: V4GitTreeFile[]; deletions?: string[]; expectedHeadSha?: string | null; }
export interface V4GitTreeWriteResult {
  previousHeadSha?: string;
  baseTreeSha?: string;
  treeSha: string;
  commitSha: string;
  fileShas: Record<string, string>;
}

export interface V4GitTreeGithub {
  getGitRefOrNull(): Promise<GitHubGitRef | null>;
  getGitCommit(sha: string): Promise<GitHubGitCommit>;
  createGitBlob(bytes: Uint8Array): Promise<string>;
  createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string): Promise<string>;
  createGitCommit(message: string, tree: string, parents: string[]): Promise<string>;
  createGitRef(sha: string): Promise<void>;
  updateGitRef(sha: string, expectedSha?: string): Promise<void>;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export async function publishV4TreeChanges(github: V4GitTreeGithub, input: V4GitTreeWriteInput): Promise<V4GitTreeWriteResult> {
  const ref = await github.getGitRefOrNull();
  if (input.expectedHeadSha !== undefined && (ref?.sha ?? null) !== input.expectedHeadSha) {
    throw new Error("V4 branch head changed before atomic publish.")
  }
  const baseTreeSha = ref ? (await github.getGitCommit(ref.sha)).treeSha : undefined;
  const blobWrites = await mapWithConcurrency(input.files, 4, async file => ({ file, sha: await github.createGitBlob(file.bytes) }));
  const fileShas: Record<string, string> = {};
  const entries: GitHubCreateTreeEntry[] = blobWrites.map(({ file, sha }) => {
    fileShas[file.path] = sha;
    return { path: file.path, mode: "100644", type: "blob", sha };
  });
  for (const path of input.deletions ?? []) entries.push({ path, mode: "100644", type: "blob", sha: null });
  const treeSha = await github.createGitTree(entries, baseTreeSha);
  const commitSha = await github.createGitCommit(input.message, treeSha, ref ? [ref.sha] : []);
  if (ref) await github.updateGitRef(commitSha, ref.sha);
  else await github.createGitRef(commitSha);
  return { previousHeadSha: ref?.sha, baseTreeSha, treeSha, commitSha, fileShas };
}
