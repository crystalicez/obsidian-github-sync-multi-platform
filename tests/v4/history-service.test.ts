import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class HistoryMemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { return new Uint8Array(this.files.get(path)!.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? 0 }); }
  async trash(path: string) { this.files.delete(path); }
}

class HistoryMemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();
  commitPageRequests: number[] = [];

  reachableCommits() {
    const reachable: Array<[string, { treeSha: string; parents: string[]; message: string }]> = [];
    const pending = this.ref ? [this.ref.sha] : [];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const sha = pending.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commits.get(sha);
      if (!commit) continue;
      reachable.push([sha, commit]);
      pending.push(...commit.parents);
    }
    return reachable;
  }
  async listCommits({ page = 1, perPage = 50 }: { page?: number; perPage?: number } = {}) {
    this.commitPageRequests.push(page);
    const commits = this.reachableCommits().map(([sha, commit], index) => ({ sha, message: commit.message, authorName: "A", authoredAt: new Date(this.commits.size - index).toISOString(), parentShas: commit.parents }));
    return commits.slice((page - 1) * perPage, page * perPage);
  }
  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined;
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path);
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) { const commit = this.commits.get(sha)!; return { sha, treeSha: commit.treeSha, parentShas: commit.parents, message: commit.message }; }
  async getTreeAt(treeSha: string) {
    const tree = this.trees.get(treeSha) ?? new Map();
    return { sha: treeSha, url: "", truncated: false, tree: [...tree.entries()].map(([path, bytes], index) => ({ path, mode: "100644", type: "blob" as const, sha: `tree-blob-${index}`, size: bytes.byteLength, url: "" })) };
  }
  async getBlob() { throw new Error("History rename test does not load previews."); }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) { const sha = `commit-${this.commits.size + 1}`; this.commits.set(sha, { treeSha, parents, message }); return sha; }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { assert.equal(this.ref?.sha, expected); await this.createGitRef(sha); }
}

function historyRecordByPath(index: V4LocalIndex, path: string) {
  const record = Object.values(index.shards).flatMap(shard => Object.values(shard.records)).find(candidate => !candidate.deleted && candidate.path === path);
  assert.ok(record, `missing history record for ${path}`);
  return record;
}

test("v4 history paginates 50 commits, reads journal changes, and loads preview lazily", async () => {
  let blobReads = 0;
  const journalRefs: Array<string | undefined> = [];
  const journal = { journalId: "j1", page: 0, pageCount: 1, changes: [{ fileId: "f1", kind: "modify", path: "note.md", after: { remotePath: "note.md", sha: "", size: 5, pathId: "p", plaintextSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", remoteVersion: "j1", storage: "single", mtime: 1 } }] };
  const commits = Array.from({ length: 70 }, (_, index) => ({ sha: `c${index}`, message: index === 0 ? "obsidian-sync-v4:j1" : `external ${index}`, authorName: "A", authoredAt: new Date(index).toISOString(), parentShas: [] }));
  const github = {
    async listCommits({ page, perPage }: { page?: number; perPage?: number }) { const start = ((page ?? 1) - 1) * (perPage ?? 50); return commits.slice(start, start + (perPage ?? 50)); },
    async getFileBytes(path: string, ref?: string) { journalRefs.push(ref); return path.includes("journals/j1/") ? { bytes: enc(JSON.stringify(journal)), sha: "journal" } : null; },
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
  assert.deepEqual(journalRefs, ["c0"]);
  assert.equal(blobReads, 0);
  const preview = await service.previewChange(page.items[0], changes[0]);
  assert.equal(preview.kind, "text");
  assert.equal(preview.text, "hello");
  assert.equal(blobReads, 1);
});

for (const mode of ["plaintext", "encrypted"] as const) {
  test(`v4 history previews a deleted ${mode} file from the parent commit`, async () => {
    const repoId = "o/r#main";
    const keyring = mode === "encrypted"
      ? await deriveV4Keyring({ passphrase: "pass", repoId, salt: enc("salt"), iterations: 10 })
      : undefined;
    const config: V4RemoteConfig = mode === "encrypted"
      ? { formatVersion: V4_FORMAT_VERSION, mode, repoId, pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" } }
      : { formatVersion: V4_FORMAT_VERSION, mode, repoId };
    const prepared = await new V4StorageCodec({ mode, pathLayout: expectedV4PathLayout(mode), keyring }).prepare("deleted.md", enc("before delete"), "version-1", 1, "file-1");
    const stored = prepared.files[0];
    const descriptor = { ...prepared.record, sha: "blob-before" };
    const github = {
      async listCommits() { return []; },
      async getFileBytes() { return null; },
      async getGitCommit(sha: string) {
        return sha === "delete-commit"
          ? { sha, treeSha: "tree-after", parentShas: ["parent-commit"] }
          : { sha, treeSha: "tree-before", parentShas: [] };
      },
      async getTreeAt(treeSha: string) {
        return { sha: treeSha, url: "", truncated: false, tree: treeSha === "tree-before" ? [{ path: stored.path, mode: "100644", type: "blob" as const, sha: "blob-before", size: stored.bytes.byteLength, url: "" }] : [] };
      },
      async getBlob(sha: string) { assert.equal(sha, "blob-before"); return stored.bytes; },
    };
    const service = new V4HistoryService({ github, config, keyring });
    const commit = { sha: "delete-commit", message: "obsidian-sync-v4:j-delete", authorName: "A", authoredAt: "", parentShas: ["parent-commit"], source: "plugin" as const, journalId: "j-delete" };
    const preview = await service.previewChange(commit, { source: "plugin", fileId: "file-1", kind: "delete", path: "deleted.md", before: descriptor });
    assert.equal(preview.kind, "text");
    assert.equal(preview.text, "before delete");
  });
}

test("v4 encrypted history follows one fileId across file and folder renames", async () => {
  const repoId = "o/r#main";
  const keyring = await deriveV4Keyring({ passphrase: "pass", repoId, salt: enc("salt"), iterations: 10 });
  const config: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId,
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const github = new HistoryMemoryGitHub();
  const vault = new HistoryMemoryVault();
  const index = createEmptyV4LocalIndex({ repoId, deviceId: "history-device", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  let clock = 100;
  const session = () => new V4SyncSession({ github, vault, index, config, keyring, conflictPolicy: "copy", abortChangePercent: 0, now: () => clock++ });

  vault.files.set("Projects/Secret/note.md", { bytes: enc("private body"), mtime: 1 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const initial = { ...historyRecordByPath(index, "Projects/Secret/note.md") };

  const file = vault.files.get("Projects/Secret/note.md")!;
  vault.files.delete("Projects/Secret/note.md");
  vault.files.set("Archive/Secret/note.md", { ...file, mtime: 2 });
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "folderRename", oldPath: "Projects", path: "Archive", mtime: 2 }] });

  vault.files.delete("Archive/Secret/note.md");
  vault.files.set("Archive/Secret/renamed.txt", { ...file, mtime: 3 });
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "Archive/Secret/note.md", path: "Archive/Secret/renamed.txt", mtime: 3 }] });

  for (let filler = 0; filler < 49; filler++) {
    const parentSha = github.ref!.sha;
    const treeSha = github.commits.get(parentSha)!.treeSha;
    const fillerSha = await github.createGitCommit(`external filler ${filler}`, treeSha, [parentSha]);
    await github.updateGitRef(fillerSha, parentSha);
  }

  const versions = await new V4HistoryService({ github, config, keyring }).getFileVersions(initial.fileId);
  assert.deepEqual(github.commitPageRequests, [1, 2]);
  assert.deepEqual(versions.map(version => version.change.path), [
    "Projects/Secret/note.md",
    "Archive/Secret/note.md",
    "Archive/Secret/renamed.txt",
  ]);
  assert.equal(new Set(versions.map(version => (version.change.after ?? version.change.before)!.remotePath)).size, 1);
  assert.equal((versions.at(-1)!.change.after ?? versions.at(-1)!.change.before)!.remotePath, initial.remotePath);
});
