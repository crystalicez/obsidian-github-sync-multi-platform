import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex, type V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { V4_LARGE_FILE_THRESHOLD_BYTES } from "../../src/lib/v4/large-files";
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, V4_HEAD_PATH, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { decodeV4RemoteHead, decodeV4RemoteShard, v4RemoteShardPath } from "../../src/lib/v4/remote-index";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const encode = (value: string) => new TextEncoder().encode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { return new Uint8Array(this.files.get(path)!.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? 0 }); }
  async trash(path: string) { this.files.delete(path); }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();

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
    const newestFirst = this.reachableCommits().map(([sha, commit], index) => ({
      sha,
      message: commit.message,
      authorName: "A",
      authoredAt: new Date(this.commits.size - index).toISOString(),
      parentShas: commit.parents,
    }));
    return newestFirst.slice((page - 1) * perPage, page * perPage);
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
  async getBlob() { throw new Error("Opaque leakage gate does not load content previews."); }
  async createGitBlob(bytes: Uint8Array) { const sha = `blob-${this.blobs.size + 1}`; this.blobs.set(sha, new Uint8Array(bytes)); return sha; }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha, parents, message });
    return sha;
  }
  async createGitRef(sha: string) { this.ref = { ref: "refs/heads/main", sha, type: "commit" }; this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha)); }
  async updateGitRef(sha: string, expected?: string) { assert.equal(this.ref?.sha, expected); await this.createGitRef(sha); }
}

function recordByPath(index: ReturnType<typeof createEmptyV4LocalIndex>, path: string): V4IndexFileRecord {
  const record = Object.values(index.shards).flatMap(shard => Object.values(shard.records)).find(candidate => !candidate.deleted && candidate.path === path);
  assert.ok(record, `missing encrypted record for ${path}`);
  return record;
}

function bytesContain(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(Buffer.from(needle, "utf8"));
}

function hasEncryptedHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && Buffer.from(bytes.buffer, bytes.byteOffset, 4).equals(Buffer.from("OGS4", "ascii"));
}

test("encrypted V4 remote paths and payloads contain no logical path or content fixture", async () => {
  const repoId = "opaque-owner/opaque-repo#main";
  const config: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId,
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "b3BhcXVlLXNhbHQ" },
  };
  const keyring = await deriveV4Keyring({ passphrase: "opaque-passphrase", repoId, salt: encode("opaque-salt"), iterations: 10 });
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({ repoId, deviceId: "leakage-gate-device", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  let clock = 1_000;
  const session = () => new V4SyncSession({ github, vault, index, config, keyring, conflictPolicy: "copy", abortChangePercent: 0, now: () => clock++ });

  const packFolder = "PackGalleryLongFixture";
  const packMarker = "PACK-CONTENT-MARKER-6F943A2E";
  for (let item = 0; item < 64; item++) {
    vault.files.set(`${packFolder}/private-record-${item}.opaque-note-fixture`, { bytes: encode(`${packMarker}-${item}`), mtime: 1 });
  }
  const chunkPath = "ChunkedArchiveLongFixture/massive-secret.binaryfixture";
  const chunkMarker = "CHUNKED-CONTENT-MARKER-4E71C8D9";
  const chunkBytes = new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1);
  chunkBytes.set(encode(chunkMarker));
  chunkBytes.fill(0xa5, chunkMarker.length);
  vault.files.set(chunkPath, { bytes: chunkBytes, mtime: 1 });
  await session().sync({ operation: "forcePush", allowThresholdOverride: false });

  const singlePath = "SingleArchiveLongFixture/live-secret.opaque-note-fixture";
  const singleMarker = "SINGLE-CONTENT-MARKER-3B82D7A1";
  const deletedPath = "DeletedArchiveLongFixture/removed-secret.opaque-note-fixture";
  const deletedMarker = "DELETED-CONTENT-MARKER-9C15E4B7";
  vault.files.set(singlePath, { bytes: encode(singleMarker), mtime: 2 });
  vault.files.set(deletedPath, { bytes: encode(deletedMarker), mtime: 2 });
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [
    { type: "modify", path: singlePath, mtime: 2 },
    { type: "modify", path: deletedPath, mtime: 2 },
  ] });
  const deletedRecord = { ...recordByPath(index, deletedPath) };

  vault.files.delete(deletedPath);
  await session().sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "delete", path: deletedPath, mtime: 3 }] });

  const reachableCommits = github.reachableCommits();
  const reachableShas = new Set(reachableCommits.map(([sha]) => sha));
  const historicalEntries = reachableCommits.flatMap(([, commit]) => [...github.trees.get(commit.treeSha)!]);
  const categories = {
    single: historicalEntries.some(([path]) => path.includes("/data/")),
    chunked: historicalEntries.some(([path]) => path.includes("/parts/")),
    pack: historicalEntries.some(([path]) => path.includes("/packs/")),
    config: historicalEntries.some(([path]) => path === V4_CONFIG_PATH),
    head: historicalEntries.some(([path]) => path === V4_HEAD_PATH),
    index: historicalEntries.some(([path]) => path.includes("/index/")),
    journal: historicalEntries.some(([path]) => path.includes("/journals/")),
  };
  assert.deepEqual(categories, { single: true, chunked: true, pack: true, config: true, head: true, index: true, journal: true });
  assert.equal(github.files.has(deletedRecord.remotePath), false, "deleted object must be absent from the tip");
  assert.equal([...github.commits.values()].some(commit => github.trees.get(commit.treeSha)!.has(deletedRecord.remotePath)), true, "deleted object must remain covered through its historical tree");

  const forbidden = [
    packFolder,
    "private-record-",
    "opaque-note-fixture",
    packMarker,
    "ChunkedArchiveLongFixture",
    "massive-secret.binaryfixture",
    chunkMarker,
    "SingleArchiveLongFixture",
    "live-secret.opaque-note-fixture",
    singleMarker,
    "DeletedArchiveLongFixture",
    "removed-secret.opaque-note-fixture",
    deletedMarker,
    chunkPath,
    singlePath,
    deletedPath,
  ];
  for (const [path, bytes] of historicalEntries) {
    for (const fixture of forbidden) {
      assert.equal(path.includes(fixture), false, `remote path leaked ${fixture}: ${path}`);
      assert.equal(bytesContain(bytes, fixture), false, `stored bytes leaked ${fixture}: ${path}`);
    }
    if (path !== V4_CONFIG_PATH) assert.equal(hasEncryptedHeader(bytes), true, `encrypted remote payload expected at ${path}`);
  }
  for (const [sha, bytes] of github.blobs) {
    for (const fixture of forbidden) assert.equal(bytesContain(bytes, fixture), false, `uploaded blob leaked ${fixture}: ${sha}`);
  }

  const head = await decodeV4RemoteHead(github.files.get(V4_HEAD_PATH)!, config, keyring);
  const liveRecords: V4IndexFileRecord[] = [];
  for (const bucket of Object.keys(head.shardHashes)) {
    const shard = await decodeV4RemoteShard(github.files.get(v4RemoteShardPath(bucket, "encrypted"))!, bucket, config, keyring);
    liveRecords.push(...Object.values(shard.records));
  }
  const livePaths = liveRecords.map(record => record.path);
  assert.equal(livePaths.includes(chunkPath), true);
  assert.equal(livePaths.includes(singlePath), true);
  assert.equal(livePaths.includes(deletedPath), false);

  const tipCommit = github.commits.get(github.ref!.sha)!;
  const tipTree = github.trees.get(tipCommit.treeSha)!;
  const readFromReachableTip = async (path: string) => {
    const bytes = tipTree.get(path);
    assert.ok(bytes, `descriptor path missing from reachable tip tree: ${path}`);
    return new Uint8Array(bytes);
  };
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const singleRecord = liveRecords.find(record => record.path === singlePath);
  const chunkedRecord = liveRecords.find(record => record.path === chunkPath);
  const packedPath = `${packFolder}/private-record-42.opaque-note-fixture`;
  const packedRecord = liveRecords.find(record => record.path === packedPath);
  assert.ok(singleRecord, `missing single record for ${singlePath}`);
  assert.ok(chunkedRecord, `missing chunked record for ${chunkPath}`);
  assert.ok(packedRecord, `missing packed record for ${packedPath}`);
  assert.equal(singleRecord.storage, "single");
  assert.equal(chunkedRecord.storage, "chunked");
  assert.equal(packedRecord.storage, "pack");
  assert.deepEqual(await codec.read(singleRecord, readFromReachableTip), encode(singleMarker));
  assert.equal(Buffer.from(await codec.read(chunkedRecord, readFromReachableTip)).equals(Buffer.from(chunkBytes)), true);
  assert.deepEqual(await codec.read(packedRecord, readFromReachableTip), encode(`${packMarker}-42`));

  const history = new V4HistoryService({ github, config, keyring });
  const deletedVersions = await history.getFileVersions(deletedRecord.fileId);
  const deletion = deletedVersions.find(version => version.change.kind === "delete");
  assert.equal(deletion?.change.path, deletedPath);
  assert.equal(deletion?.change.before?.remotePath, deletedRecord.remotePath);
  const parentSha = deletion!.commit.parentShas[0];
  assert.equal(reachableShas.has(parentSha), true);
  const parentTree = github.trees.get(github.commits.get(parentSha)!.treeSha)!;
  assert.equal(parentTree.has(deletion!.change.before!.remotePath), true);
});
