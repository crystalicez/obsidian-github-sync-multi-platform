import assert from "node:assert/strict";
import test from "node:test";

import { deriveEncryptionKey } from "../../src/lib/encrypted/crypto";
import { GitHubClient } from "../../src/lib/github-api";
import { SnapshotHeadCasError, V2_HEAD_PATH, V2_SNAPSHOTS_ROOT, EncryptedSnapshotStore } from "../../src/lib/encrypted/snapshot-store";
import { WrongPassphraseError } from "../../src/lib/encrypted/sync-errors";
import type { EncryptedRepoConfig } from "../../src/lib/encrypted/types";
import type { EncryptedSnapshotManifest } from "../../src/lib/encrypted/snapshot-types";

class SnapshotMemoryGitHub {
  blobs = new Map<string, { content: string; sha: string }>();
  counter = 0;

  async getFile(path: string) {
    const item = this.blobs.get(path);
    if (!item) return null;
    return { path, content: item.content, sha: item.sha, size: item.content.length };
  }

  async getFileBytes(path: string) {
    const item = this.blobs.get(path);
    if (!item) return null;
    return { bytes: new TextEncoder().encode(item.content), sha: item.sha };
  }

  async putFileCas(path: string, content: string | ArrayBuffer, expectedSha?: string) {
    const existing = this.blobs.get(path);
    if ((existing?.sha ?? undefined) !== expectedSha) {
      const error = new Error("stale sha") as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    const value = typeof content === "string" ? content : new TextDecoder().decode(content);
    const sha = `sha-${++this.counter}`;
    this.blobs.set(path, { content: value, sha });
    return sha;
  }

  async putFile(path: string, content: string | ArrayBuffer, sha?: string) {
    return this.putFileCas(path, content, sha);
  }
}

async function snapshotKey() {
  const config: EncryptedRepoConfig = {
    formatVersion: 1,
    indexMode: "single",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1, salt: "snapshot-test-salt" },
    createdAt: 1,
    updatedAt: 1,
  };
  return deriveEncryptionKey("snapshot-password", config);
}

function sampleSnapshot(snapshotId = "snap-1", generation = 1): EncryptedSnapshotManifest {
  return {
    formatVersion: 2,
    snapshotId,
    parentSnapshotIds: [],
    generation,
    createdAt: generation,
    files: {
      "Notes/a.md": {
        path: "Notes/a.md",
        objectId: "object-a",
        storage: "object",
        plaintextSha256: "a".repeat(64),
        size: 5,
        mtime: 10,
      },
    },
  };
}

test("snapshot store writes encrypted snapshots and head without plaintext metadata", async () => {
  const github = new SnapshotMemoryGitHub();
  const store = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());

  assert.equal(await store.loadHead(), null);
  const written = await store.writeSnapshot(sampleSnapshot());
  const headSha = await store.updateHeadCas({ formatVersion: 2, snapshotId: written.snapshot.snapshotId, generation: 1, updatedAt: 2 }, undefined);
  const loadedHead = await store.loadHead();
  const loadedSnapshot = await store.loadSnapshot(written.snapshot.snapshotId);

  assert.equal(written.path, `${V2_SNAPSHOTS_ROOT}/${written.snapshot.snapshotId}.enc`);
  assert.equal(loadedHead?.sha, headSha);
  assert.equal(loadedHead?.head.snapshotId, written.snapshot.snapshotId);
  assert.deepEqual(loadedSnapshot, written.snapshot);
  assert.equal(github.blobs.get(V2_HEAD_PATH)?.content.includes("Notes/a.md"), false);
  assert.equal(github.blobs.get(written.path)?.content.includes("Notes/a.md"), false);
});

test("snapshot head update uses strict CAS and rejects stale devices", async () => {
  const github = new SnapshotMemoryGitHub();
  const storeA = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const storeB = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());

  const first = await storeA.writeSnapshot(sampleSnapshot("snap-a", 1));
  const shaA = await storeA.updateHeadCas({ formatVersion: 2, snapshotId: first.snapshot.snapshotId, generation: 1, updatedAt: 1 }, undefined);
  const staleHead = await storeB.loadHead();
  assert.equal(staleHead?.sha, shaA);

  const second = await storeA.writeSnapshot(sampleSnapshot("snap-b", 2));
  await storeA.updateHeadCas({ formatVersion: 2, snapshotId: second.snapshot.snapshotId, generation: 2, updatedAt: 2 }, shaA);

  const staleWrite = storeB.updateHeadCas({ formatVersion: 2, snapshotId: "snap-stale", generation: 2, updatedAt: 3 }, staleHead?.sha);
  await assert.rejects(staleWrite, SnapshotHeadCasError);
  const current = await storeA.loadHead();
  assert.equal(current?.head.snapshotId, "snap-b");
});
test("snapshot store reports wrong passphrase for undecryptable v2 metadata", async () => {
  const github = new SnapshotMemoryGitHub();
  const correct = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const wrongConfig: EncryptedRepoConfig = {
    formatVersion: 1,
    indexMode: "single",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1, salt: "snapshot-test-salt" },
    createdAt: 1,
    updatedAt: 1,
  };
  const wrongKey = await deriveEncryptionKey("wrong-password", wrongConfig);

  const written = await correct.writeSnapshot(sampleSnapshot("secret-snap", 1));
  await correct.updateHeadCas({ formatVersion: 2, snapshotId: written.snapshot.snapshotId, generation: 1, updatedAt: 1 }, undefined);

  const wrong = new EncryptedSnapshotStore(github as unknown as GitHubClient, wrongKey);
  await assert.rejects(() => wrong.loadHead(), WrongPassphraseError);
  await assert.rejects(() => wrong.loadSnapshot("secret-snap"), WrongPassphraseError);
});

class SnapshotGitAtomicMemoryGitHub extends SnapshotMemoryGitHub {
  pendingBlobs = new Map<string, string>();
  commits: Array<{ message: string; tree: string; parents: string[] }> = [];
  trees: Array<{ tree: Array<{ path: string; sha?: string | null }>; baseTree?: string }> = [];
  updatedRefs: Array<{ sha: string; expectedSha?: string }> = [];
  headCommitSha = "commit-0";
  failUpdateStatus?: number;
  failUpdateStatusOnce?: number;

  async getGitRef() {
    return { ref: "refs/heads/main", sha: this.headCommitSha, type: "commit" };
  }

  async getTree() {
    return { sha: "tree-current", url: "", truncated: false, tree: [] };
  }

  async createGitBlob(bytes: Uint8Array) {
    const sha = `git-blob-${++this.counter}`;
    this.pendingBlobs.set(sha, new TextDecoder().decode(bytes));
    return sha;
  }

  async createGitTree(tree: Array<{ path: string; sha?: string | null }>, baseTree?: string) {
    this.trees.push({ tree, baseTree });
    for (const entry of tree) {
      if (entry.sha === null) {
        this.blobs.delete(entry.path);
      } else if (entry.sha) {
        const content = this.pendingBlobs.get(entry.sha);
        if (content !== undefined) this.blobs.set(entry.path, { content, sha: entry.sha });
      }
    }
    return `git-tree-${this.trees.length}`;
  }

  async createGitCommit(message: string, tree: string, parents: string[]) {
    this.commits.push({ message, tree, parents });
    return `git-commit-${this.commits.length}`;
  }

  async updateGitRef(sha: string, expectedSha?: string) {
    if (this.failUpdateStatusOnce) {
      const status = this.failUpdateStatusOnce;
      this.failUpdateStatusOnce = undefined;
      const error = new Error("transient stale git ref") as Error & { status?: number };
      error.status = status;
      throw error;
    }
    if (this.failUpdateStatus) {
      const error = new Error("stale git ref") as Error & { status?: number };
      error.status = this.failUpdateStatus;
      throw error;
    }
    this.updatedRefs.push({ sha, expectedSha });
    this.headCommitSha = sha;
  }
}

test("snapshot store can write snapshot and head in one atomic Git commit", async () => {
  const github = new SnapshotGitAtomicMemoryGitHub();
  const store = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const snapshot = sampleSnapshot("atomic-snap", 1);

  const written = await store.writeSnapshotAndHeadAtomic(snapshot, { formatVersion: 2, snapshotId: snapshot.snapshotId, generation: 1, updatedAt: 2 });
  const loadedHead = await store.loadHead();
  const loadedSnapshot = await store.loadSnapshot(snapshot.snapshotId);

  assert.equal(github.commits.length, 1);
  assert.equal(github.trees.length, 1);
  assert.deepEqual(github.updatedRefs, [{ sha: "git-commit-1", expectedSha: "commit-0" }]);
  assert.equal(written.headSha, github.blobs.get(V2_HEAD_PATH)?.sha);
  assert.equal(loadedHead?.head.snapshotId, snapshot.snapshotId);
  assert.deepEqual(loadedSnapshot, snapshot);
});

test("snapshot atomic write maps stale Git ref to SnapshotHeadCasError", async () => {
  const github = new SnapshotGitAtomicMemoryGitHub();
  github.failUpdateStatus = 409;
  const store = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const snapshot = sampleSnapshot("atomic-stale", 1);
  await assert.rejects(
    () => store.writeSnapshotAndHeadAtomic(snapshot, { formatVersion: 2, snapshotId: snapshot.snapshotId, generation: 1, updatedAt: 2 }, "expected-head"),
    SnapshotHeadCasError,
  );
});

test("snapshot atomic write retries a transient Git ref conflict when no expected head is required", async () => {
  const github = new SnapshotGitAtomicMemoryGitHub();
  github.failUpdateStatusOnce = 409;
  const store = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const snapshot = sampleSnapshot("atomic-retry", 1);

  const written = await store.writeSnapshotAndHeadAtomic(snapshot, { formatVersion: 2, snapshotId: snapshot.snapshotId, generation: 1, updatedAt: 2 });

  assert.equal(github.commits.length, 2);
  assert.equal(github.updatedRefs.length, 1);
  assert.equal(written.snapshot.snapshotId, snapshot.snapshotId);
});
test("snapshot atomic write serves fresh metadata from cache while GitHub contents reads lag", async () => {
  const github = new SnapshotGitAtomicMemoryGitHub();
  const store = new EncryptedSnapshotStore(github as unknown as GitHubClient, await snapshotKey());
  const snapshot = sampleSnapshot("atomic-cache", 1);

  await store.writeSnapshotAndHeadAtomic(snapshot, { formatVersion: 2, snapshotId: snapshot.snapshotId, generation: 1, updatedAt: 2 });
  github.blobs.clear();

  const loadedHead = await store.loadHead();
  const loadedSnapshot = await store.loadSnapshot(snapshot.snapshotId);
  assert.equal(loadedHead?.head.snapshotId, snapshot.snapshotId);
  assert.deepEqual(loadedSnapshot, snapshot);

  github.headCommitSha = "external-commit";
  assert.equal(await store.loadHead(), null);
});
