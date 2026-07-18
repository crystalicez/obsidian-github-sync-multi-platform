import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../github-git-types";

export interface V4GitTreeProgressItem { fileId: string; path: string; }
export interface V4GitTreeFile { path: string; bytes: Uint8Array; progressItems?: V4GitTreeProgressItem[]; }
export interface V4GitTreeWriteInput {
  message: string;
  files: V4GitTreeFile[];
  deletions?: string[];
  expectedHeadSha?: string | null;
  onLogicalFileUploadStarted?: (item: V4GitTreeProgressItem) => void;
  onLogicalFileUploaded?: (item: V4GitTreeProgressItem) => void;
  onUploadsComplete?: () => void;
}
export interface V4GitTreeWriteResult {
  previousHeadSha?: string;
  baseTreeSha?: string;
  treeSha: string;
  commitSha: string;
  fileShas: Record<string, string>;
}

export interface V4GitTreeGithub {
  getGitRefOrNull(): Promise<GitHubGitRef | null>;
  ensureGitRepositoryInitialized?(): Promise<GitHubGitRef | null>;
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
  let failed = false;
  let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }));
  if (failed) throw firstError;
  return results;
}

function invokeProgressCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Progress reporting must never affect Git writes.
  }
}

export async function publishV4TreeChanges(github: V4GitTreeGithub, input: V4GitTreeWriteInput): Promise<V4GitTreeWriteResult> {
  let ref = await github.getGitRefOrNull();
  if (input.expectedHeadSha !== undefined && (ref?.sha ?? null) !== input.expectedHeadSha) {
    throw new Error("V4 branch head changed before atomic publish.")
  }
  if (!ref && github.ensureGitRepositoryInitialized) ref = await github.ensureGitRepositoryInitialized();
  const baseTreeSha = ref ? (await github.getGitCommit(ref.sha)).treeSha : undefined;
  const progressItemsByFile = input.files.map(file => {
    const seen = new Set<string>();
    return (file.progressItems ?? []).filter(item => {
      if (seen.has(item.fileId)) return false;
      seen.add(item.fileId);
      return true;
    });
  });
  const remainingBlobsByFileId = new Map<string, number>();
  for (const progressItems of progressItemsByFile) {
    for (const item of progressItems) {
      remainingBlobsByFileId.set(item.fileId, (remainingBlobsByFileId.get(item.fileId) ?? 0) + 1);
    }
  }
  const startedFileIds = new Set<string>();
  const blobWrites = await mapWithConcurrency(input.files.map((file, index) => ({ file, progressItems: progressItemsByFile[index] })), 4, async ({ file, progressItems }) => {
    for (const item of progressItems) {
      if (startedFileIds.has(item.fileId)) continue;
      startedFileIds.add(item.fileId);
      invokeProgressCallback(() => input.onLogicalFileUploadStarted?.(item));
    }
    const sha = await github.createGitBlob(file.bytes);
    for (const item of progressItems) {
      const remaining = (remainingBlobsByFileId.get(item.fileId) ?? 1) - 1;
      remainingBlobsByFileId.set(item.fileId, remaining);
      if (remaining === 0) invokeProgressCallback(() => input.onLogicalFileUploaded?.(item));
    }
    return { file, sha };
  });
  const fileShas: Record<string, string> = {};
  const entries: GitHubCreateTreeEntry[] = blobWrites.map(({ file, sha }) => {
    fileShas[file.path] = sha;
    return { path: file.path, mode: "100644", type: "blob", sha };
  });
  for (const path of input.deletions ?? []) entries.push({ path, mode: "100644", type: "blob", sha: null });
  invokeProgressCallback(input.onUploadsComplete);
  const treeSha = await github.createGitTree(entries, baseTreeSha);
  const commitSha = await github.createGitCommit(input.message, treeSha, ref ? [ref.sha] : []);
  if (ref) await github.updateGitRef(commitSha, ref.sha);
  else await github.createGitRef(commitSha);
  return { previousHeadSha: ref?.sha, baseTreeSha, treeSha, commitSha, fileShas };
}
