import type { V4ChangeKind } from "./planner";

export interface V4VersionDescriptor {
  remotePath: string;
  sha: string;
  size: number;
  partShas?: string[];
  packId?: string;
  pathId?: string;
  plaintextSha256?: string;
  remoteVersion?: string;
  storage?: "single" | "chunked" | "pack";
  partPaths?: string[];
  mtime?: number;
}

export interface V4JournalChange {
  fileId: string;
  kind: V4ChangeKind;
  path: string;
  previousPath?: string;
  before?: V4VersionDescriptor;
  after?: V4VersionDescriptor;
}

export interface V4JournalPage {
  journalId: string;
  page: number;
  pageCount: number;
  changes: V4JournalChange[];
}

export interface V4JournalCommit {
  commitSha: string;
  authoredAt: number;
  changes: V4JournalChange[];
}

export interface V4FileVersion {
  commitSha: string;
  authoredAt: number;
  path: string;
  kind: V4ChangeKind;
  descriptor?: V4VersionDescriptor;
}

export function buildV4JournalPages(journalId: string, changes: V4JournalChange[], pageSize = 500): V4JournalPage[] {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("V4 journal page size must be positive.");
  const pageCount = Math.max(1, Math.ceil(changes.length / pageSize));
  return Array.from({ length: pageCount }, (_, page) => ({
    journalId,
    page,
    pageCount,
    changes: changes.slice(page * pageSize, (page + 1) * pageSize),
  }));
}

export function fileVersionsFromV4Journals(fileId: string, commits: V4JournalCommit[]): V4FileVersion[] {
  return [...commits]
    .sort((a, b) => a.authoredAt - b.authoredAt)
    .flatMap(commit => commit.changes
      .filter(change => change.fileId === fileId)
      .map(change => ({
        commitSha: commit.commitSha,
        authoredAt: commit.authoredAt,
        path: change.path,
        kind: change.kind,
        descriptor: change.after ?? change.before,
      })));
}
