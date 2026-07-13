import assert from "node:assert/strict";
import test from "node:test";

import { V4HistoryService } from "../../src/lib/v4/history-service";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";

const enc = (value: string) => new TextEncoder().encode(value);

test("v4 history paginates 50 commits, reads journal changes, and loads preview lazily", async () => {
  let blobReads = 0;
  const journal = { journalId: "j1", page: 0, pageCount: 1, changes: [{ fileId: "f1", kind: "modify", path: "note.md", after: { remotePath: "note.md", sha: "", size: 5, pathId: "p", plaintextSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", remoteVersion: "j1", storage: "single", mtime: 1 } }] };
  const commits = Array.from({ length: 70 }, (_, index) => ({ sha: `c${index}`, message: index === 0 ? "obsidian-sync-v4:j1" : `external ${index}`, authorName: "A", authoredAt: new Date(index).toISOString(), parentShas: [] }));
  const github = {
    async listCommits({ page, perPage }: { page?: number; perPage?: number }) { const start = ((page ?? 1) - 1) * (perPage ?? 50); return commits.slice(start, start + (perPage ?? 50)); },
    async getFileBytes(path: string) { return path.includes("journals/j1/") ? { bytes: enc(JSON.stringify(journal)), sha: "journal" } : null; },
    async getGitCommit(sha: string) { return { sha, treeSha: `tree-${sha}`, parentShas: [] }; },
    async getTreeAt() { return { sha: "tree", url: "", truncated: false, tree: [{ path: "note.md", mode: "100644", type: "blob" as const, sha: "blob-note", size: 5, url: "" }] }; },
    async getBlob() { blobReads++; return enc("hello"); },
  };
  const config: V4RemoteConfig = { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" };
  const service = new V4HistoryService({ github, config });
  const page = await service.listCommits(1);
  assert.equal(page.items.length, 50);
  assert.equal(page.hasMore, true);
  assert.equal(page.items[0].source, "plugin");
  const changes = await service.getCommitChanges(page.items[0]);
  assert.equal(changes[0].path, "note.md");
  assert.equal(blobReads, 0);
  const preview = await service.previewChange(page.items[0], changes[0]);
  assert.equal(preview.kind, "text");
  assert.equal(preview.text, "hello");
  assert.equal(blobReads, 1);
});
