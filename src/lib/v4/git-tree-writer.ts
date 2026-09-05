import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "../github-git-types";
import type { V4StreamObject } from "./object-stream";
import { isV4GitMutationOutcomeUnknownError } from "./git-mutation-policy";
import { reconcileV4CandidatePublication } from "./publish-reconciler";
import { V4PublicationRaceError, isV4PublicationRaceError } from "./publication-race";
import { throwIfV4Aborted } from "./cancellation";

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
  withBlobTransport?: (bytes: Uint8Array, task: () => Promise<string>) => Promise<string>;
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
  createGitCommit(message: string, tree: string, parents: string[], options?: { originalCannotBeReachable?: boolean }): Promise<string>;
  createGitRef(sha: string): Promise<void>;
  updateGitRef(sha: string, expectedSha?: string): Promise<void>;
}

export interface V4PublicationBase {
  ref: GitHubGitRef | null;
  previousHeadSha?: string;
  baseTreeSha?: string;
}

export interface V4UploadedTreeFiles {
  entries: GitHubCreateTreeEntry[];
  fileShas: Record<string, string>;
}

export interface V4CandidateCommit {
  previousHeadSha?: string;
  baseTreeSha?: string;
  treeSha: string;
  commitSha: string;
  message: string;
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

export async function resolveV4PublicationBase(
  github: V4GitTreeGithub,
  expectedHeadSha?: string | null,
): Promise<V4PublicationBase> {
  let ref = await github.getGitRefOrNull();
  if (expectedHeadSha !== undefined && (ref?.sha ?? null) !== expectedHeadSha) {
    throw new V4PublicationRaceError({
      phase: "pre-publish",
      expectedHeadSha,
      observedHeadSha: ref?.sha ?? null,
      publicationOutcome: "not-published",
      evidence: "pre-publish-head-mismatch",
      message: "V4 branch head changed before atomic publish.",
    });
  }
  if (!ref && github.ensureGitRepositoryInitialized) {
    try {
      ref = await github.ensureGitRepositoryInitialized();
    } catch (error) {
      let observed: GitHubGitRef | null;
      try {
        observed = await github.getGitRefOrNull();
      } catch {
        throw error;
      }
      if (!observed) throw error;
      throw new V4PublicationRaceError({
        phase: "bootstrap-publish",
        expectedHeadSha: null,
        observedHeadSha: observed.sha,
        publicationOutcome: "unknown",
        evidence: "bootstrap-head-appeared",
        cause: error,
        message: "V4 branch head changed during repository bootstrap.",
      });
    }
  }
  const baseTreeSha = ref ? (await github.getGitCommit(ref.sha)).treeSha : undefined;
  return { ref, previousHeadSha: ref?.sha, baseTreeSha };
}

export async function uploadV4TreeFiles(
  github: V4GitTreeGithub,
  input: Pick<V4GitTreeWriteInput, "files" | "onLogicalFileUploadStarted" | "onLogicalFileUploaded" | "onUploadsComplete" | "withBlobTransport">,
): Promise<V4UploadedTreeFiles> {
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
    const createBlob = () => github.createGitBlob(file.bytes);
    const sha = input.withBlobTransport
      ? await input.withBlobTransport(file.bytes, createBlob)
      : await createBlob();
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
  invokeProgressCallback(input.onUploadsComplete);
  return { entries, fileShas };
}

export async function uploadV4ObjectStream(
  github: V4GitTreeGithub,
  input: {
    objects: AsyncIterable<V4StreamObject>;
    progressItem?: V4GitTreeProgressItem;
    onLogicalFileUploadStarted?: (item: V4GitTreeProgressItem) => void;
    onLogicalFileUploaded?: (item: V4GitTreeProgressItem) => void;
    withBlobTransport?: (bytes: Uint8Array, task: () => Promise<string>) => Promise<string>;
  },
): Promise<V4UploadedTreeFiles> {
  const entries: GitHubCreateTreeEntry[] = [];
  const fileShas: Record<string, string> = {};
  let started = false;
  for await (const object of input.objects) {
    if (!started && input.progressItem) {
      started = true;
      invokeProgressCallback(() => input.onLogicalFileUploadStarted?.(input.progressItem!));
    }
    try {
      const createBlob = () => github.createGitBlob(object.bytes);
      const sha = input.withBlobTransport
        ? await input.withBlobTransport(object.bytes, createBlob)
        : await createBlob();
      fileShas[object.path] = sha;
      entries.push({ path: object.path, mode: "100644", type: "blob", sha });
    } finally {
      object.release?.();
    }
  }
  if (input.progressItem && started) invokeProgressCallback(() => input.onLogicalFileUploaded?.(input.progressItem!));
  return { entries, fileShas };
}

export async function createV4CandidateCommit(
  github: V4GitTreeGithub,
  input: {
    base: V4PublicationBase;
    message: string;
    entries: GitHubCreateTreeEntry[];
    deletions?: string[];
  },
): Promise<V4CandidateCommit> {
  const entries = [...input.entries];
  for (const path of input.deletions ?? []) entries.push({ path, mode: "100644", type: "blob", sha: null });
  const treeSha = await github.createGitTree(entries, input.base.baseTreeSha);
  const parents = input.base.ref ? [input.base.ref.sha] : [];
  const commitSha = await github.createGitCommit(input.message, treeSha, parents, { originalCannotBeReachable: true });
  return {
    previousHeadSha: input.base.previousHeadSha,
    baseTreeSha: input.base.baseTreeSha,
    treeSha,
    commitSha,
    message: input.message,
  };
}

function postMutationRacePhase(expectedHeadSha: string | null): "bootstrap-publish" | "post-publish" {
  return expectedHeadSha === null ? "bootstrap-publish" : "post-publish";
}

export async function publishV4CandidateRef(github: V4GitTreeGithub, candidate: V4CandidateCommit, signal?: AbortSignal): Promise<void> {
  throwIfV4Aborted(signal);
  const expectedHead = candidate.previousHeadSha ?? null;
  const journalId = candidate.message.startsWith("obsidian-sync-v4:") ? candidate.message.slice("obsidian-sync-v4:".length) : undefined;
  const assertExpectedHead = async (): Promise<void> => {
    throwIfV4Aborted(signal);
    const current = await github.getGitRefOrNull();
    if ((current?.sha ?? null) !== expectedHead) {
      throw new V4PublicationRaceError({
        phase: "pre-publish",
        expectedHeadSha: expectedHead,
        observedHeadSha: current?.sha ?? null,
        publicationOutcome: "not-published",
        evidence: "pre-publish-head-mismatch",
        message: "V4 branch head changed before atomic publish.",
      });
    }
  };
  const mutate = async (): Promise<void> => {
    if (candidate.previousHeadSha !== undefined) await github.updateGitRef(candidate.commitSha, candidate.previousHeadSha);
    else await github.createGitRef(candidate.commitSha);
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    throwIfV4Aborted(signal);
    await assertExpectedHead();
    try {
      await mutate();
      return;
    } catch (error) {
      if (isV4PublicationRaceError(error)) throw error;

      let reconciled;
      try {
        reconciled = await reconcileV4CandidatePublication(github, {
          candidateCommitSha: candidate.commitSha,
          expectedHeadSha: expectedHead,
          journalId,
          signal,
        });
      } catch {
        // If even the current branch head cannot be established, the mutation failure
        // remains the most trustworthy evidence. Do not manufacture a race result.
        throw error;
      }

      if (reconciled.status === "published" && reconciled.publishedCommitSha === candidate.commitSha) return;
      if (reconciled.status === "published-advanced") {
        throw new V4PublicationRaceError({
          phase: postMutationRacePhase(expectedHead),
          expectedHeadSha: expectedHead,
          observedHeadSha: reconciled.currentHeadSha,
          publicationOutcome: "published",
          evidence: reconciled.evidence,
          cause: error,
          message: "V4 branch head changed after candidate publication.",
        });
      }
      if (reconciled.status === "not-published" && reconciled.currentHeadSha === expectedHead) {
        if (attempt === 1 && isV4GitMutationOutcomeUnknownError(error)) continue;
        throw error;
      }
      if (reconciled.currentHeadSha !== expectedHead) {
        throw new V4PublicationRaceError({
          phase: postMutationRacePhase(expectedHead),
          expectedHeadSha: expectedHead,
          observedHeadSha: reconciled.currentHeadSha,
          publicationOutcome: "unknown",
          evidence: reconciled.evidence,
          cause: error,
          message: "V4 branch head changed during candidate publication.",
        });
      }
      throw error;
    }
  }
}

export async function publishV4TreeChanges(github: V4GitTreeGithub, input: V4GitTreeWriteInput): Promise<V4GitTreeWriteResult> {
  const base = await resolveV4PublicationBase(github, input.expectedHeadSha);
  const uploaded = await uploadV4TreeFiles(github, input);
  const candidate = await createV4CandidateCommit(github, {
    base,
    message: input.message,
    entries: uploaded.entries,
    deletions: input.deletions,
  });
  await publishV4CandidateRef(github, candidate);
  return { ...candidate, fileShas: uploaded.fileShas };
}
