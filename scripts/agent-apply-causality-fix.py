from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one patch target, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/lib/v4/sync-coordinator.ts",
    '''  const priorRenameEndpoints = new Set<string>();
  const priorRenameDestinations = new Set<string>();
  for (const change of pathChanges) {
    if (change.type === "delete" && priorRenameDestinations.has(change.path)) {
      return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
    }
    if (change.type !== "rename") continue;
    if (priorRenameEndpoints.has(change.oldPath) || priorRenameEndpoints.has(change.path)) {
      return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
    }
    priorRenameEndpoints.add(change.oldPath);
    priorRenameEndpoints.add(change.path);
    priorRenameDestinations.add(change.path);
  }
''',
    '''  const isSimpleInverseRenameCycle = pathChanges.length === 2
    && pathChanges[0].type === "rename"
    && pathChanges[1].type === "rename"
    && pathChanges[0].oldPath === pathChanges[1].path
    && pathChanges[0].path === pathChanges[1].oldPath;
  if (!isSimpleInverseRenameCycle) {
    const priorRenameEndpoints = new Set<string>();
    const priorRenameDestinations = new Set<string>();
    for (const change of pathChanges) {
      if (change.type === "delete" && priorRenameDestinations.has(change.path)) {
        return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
      }
      if (change.type !== "rename") continue;
      if (priorRenameEndpoints.has(change.oldPath) || priorRenameEndpoints.has(change.path)) {
        return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
      }
      priorRenameEndpoints.add(change.oldPath);
      priorRenameEndpoints.add(change.path);
      priorRenameDestinations.add(change.path);
    }
  }
''',
)

replace_once(
    "src/lib/v4/sync-session.ts",
    '''    const identityByPath = new Map(baseRecords.map(record => [record.path, record]))
    for (const change of changes) {
      if (change.type === "replace") {
        identityByPath.delete(change.oldPath)
        identityByPath.delete(change.path)
        continue
      }
      if (change.type === "rename") {
        const record = identityByPath.get(change.oldPath)
        if (record) { identityByPath.delete(change.oldPath); identityByPath.set(change.path, record) }
        continue
      }
      if (change.type !== "folderRename") continue
      const oldPrefix = `${change.oldPath}/`
      for (const [path, record] of [...identityByPath]) {
        if (path !== change.oldPath && !path.startsWith(oldPrefix)) continue
        const suffix = path.slice(change.oldPath.length)
        identityByPath.delete(path)
        identityByPath.set(`${change.path}${suffix}`, record)
      }
    }
    const files = await this.localIo.listFiles()
    return boundedMap(files, this.resources.limits.maxVaultReads, async file => {
      this.report({ phase: "scanning-local", currentPath: file.path, currentDirection: undefined })
      const existing = identityByPath.get(file.path)
      const unchangedStat = existing && existing.size === file.size && existing.mtime === file.mtime
      if (!unchangedStat) this.report({ phase: "hashing", currentPath: file.path, currentDirection: undefined })
      return {
        path: file.path,
        fileId: identitySeedByPath?.get(file.path) ?? existing?.fileId ?? await this.newFileId(file.path),
''',
    '''    const identityByPath = new Map<string, V4IndexFileRecord | null>(baseRecords.map(record => [record.path, record]))
    const atOrBelow = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
    for (const change of changes) {
      if (change.type === "rescan") continue
      if (change.type === "delete") {
        identityByPath.delete(change.path)
        continue
      }
      if (change.type === "modify") {
        if (!identityByPath.has(change.path) && !identitySeedByPath?.has(change.path)) identityByPath.set(change.path, null)
        continue
      }
      if (change.type === "replace") {
        identityByPath.delete(change.oldPath)
        identityByPath.delete(change.path)
        identityByPath.set(change.path, null)
        continue
      }
      if (change.type === "rename") {
        const hadSource = identityByPath.has(change.oldPath)
        const record = identityByPath.get(change.oldPath)
        identityByPath.delete(change.oldPath)
        identityByPath.delete(change.path)
        if (hadSource) identityByPath.set(change.path, record ?? null)
        continue
      }
      if (change.type === "folderDelete") {
        for (const path of [...identityByPath.keys()]) if (atOrBelow(path, change.path)) identityByPath.delete(path)
        continue
      }
      if (change.type !== "folderRename") continue
      const moved: Array<[string, V4IndexFileRecord | null]> = []
      for (const [path, record] of [...identityByPath]) {
        if (!atOrBelow(path, change.oldPath)) continue
        identityByPath.delete(path)
        moved.push([`${change.path}${path.slice(change.oldPath.length)}`, record])
      }
      for (const path of [...identityByPath.keys()]) if (atOrBelow(path, change.path)) identityByPath.delete(path)
      for (const [path, record] of moved) identityByPath.set(path, record)
    }
    const files = await this.localIo.listFiles()
    return boundedMap(files, this.resources.limits.maxVaultReads, async file => {
      this.report({ phase: "scanning-local", currentPath: file.path, currentDirection: undefined })
      const identity = identityByPath.get(file.path)
      const existing = identity ?? undefined
      const unchangedStat = existing && existing.size === file.size && existing.mtime === file.mtime
      if (!unchangedStat) this.report({ phase: "hashing", currentPath: file.path, currentDirection: undefined })
      const fileId = identity === null
        ? await this.newFileId(file.path)
        : identitySeedByPath?.get(file.path) ?? existing?.fileId ?? await this.newFileId(file.path)
      return {
        path: file.path,
        fileId,
''',
)

replace_once(
    "tests/v4/sync-coordinator.test.ts",
    '''test("v4 coalescing preserves identity discontinuity for replacement and rename-delete sequences", async () => {''',
    '''test("v4 coalescing preserves replacement identity discontinuity and rescans ambiguous rename-delete sequences", async () => {''',
)
replace_once(
    "tests/v4/sync-coordinator.test.ts",
    '''    [{ type: "delete", path: "old.md", mtime: 4 }],
  ]);
});

test("v4 coalescing preserves replacement identity break through a subsequent rename", () => {''',
    '''    [
      { type: "rename", oldPath: "old.md", path: "new.md", mtime: 3 },
      { type: "delete", path: "new.md", mtime: 4 },
      { type: "rescan", mtime: 4 },
    ],
  ]);
});

test("v4 coalescing preserves replacement identity break through a subsequent rename", () => {''',
)
replace_once(
    "tests/v4/sync-coordinator.test.ts",
    '''test("v4 coordinator collapses folder events to one full rescan", async () => {''',
    '''test("v4 coalescing falls back to a causal rescan when a rename cycle can hide an overwritten destination", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "delete", path: "B.md", mtime: 1 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 2 },
    { type: "rename", oldPath: "B.md", path: "A.md", mtime: 3 },
  ]), [
    { type: "delete", path: "B.md", mtime: 1 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 2 },
    { type: "rename", oldPath: "B.md", path: "A.md", mtime: 3 },
    { type: "rescan", mtime: 3 },
  ]);
});

test("v4 coordinator collapses folder events to one full rescan", async () => {''',
)
replace_once(
    "tests/v4/sync-coordinator.test.ts",
    '''test("v4 folder rename keeps descendant changes as one prefix mapping", () => {''',
    '''test("v4 folder changes preserve causal event order across delete-recreate interactions", () => {
  const changes: V4QueuedChange[] = [
    { type: "folderDelete", path: "F", mtime: 1 },
    { type: "folderRename", oldPath: "H", path: "F", mtime: 2 },
    { type: "folderDelete", path: "F", mtime: 3 },
    { type: "modify", path: "F/a.md", mtime: 4 },
    { type: "rename", oldPath: "F/a.md", path: "H/a.md", mtime: 5 },
  ];
  assert.deepEqual(coalesceV4Changes(changes), changes);
});

test("v4 folder rename keeps descendant changes as one prefix mapping", () => {''',
)

Path("tests/v4/sync-causality.test.ts").write_text('''import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { createEmptyV4LocalIndex, type V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { coalesceV4Changes } from "../../src/lib/v4/sync-coordinator";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const enc = (value: string) => new TextEncoder().encode(value);

class MemoryVault implements V4SessionVault {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { return new Uint8Array(this.files.get(path)!.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime: mtime ?? Date.now() }); }
  async trash(path: string) { this.files.delete(path); }
}

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined;
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path);
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) {
    const value = this.commits.get(sha)!;
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message };
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) entry.sha === null ? tree.delete(entry.path) : tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, tree: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha: tree, parents, message });
    return sha;
  }
  async createGitRef(sha: string) {
    this.ref = { ref: "refs/heads/main", sha, type: "commit" };
    this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha));
  }
  async updateGitRef(sha: string, expected?: string) {
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref");
    await this.createGitRef(sha);
  }
}

function config(): V4RemoteConfig {
  return { formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main" };
}

function recordByPath(index: ReturnType<typeof createEmptyV4LocalIndex>, path: string): V4IndexFileRecord {
  const record = Object.values(index.shards)
    .flatMap(shard => Object.values(shard.records))
    .find(candidate => !candidate.deleted && candidate.path === path);
  assert.ok(record, `missing index record for ${path}`);
  return record;
}

test("v4 ambiguous rename-chain rescan preserves recreate identity discontinuity", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  vault.files.set("A.md", { bytes: enc("old A"), mtime: 1 });
  vault.files.set("B.md", { bytes: enc("old B"), mtime: 1 });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" });
  const session = () => new V4SyncSession({ github, vault, index, config: config(), conflictPolicy: "copy", abortChangePercent: 0 });

  await session().sync({ operation: "forcePush", allowThresholdOverride: false });
  const beforeA = { ...recordByPath(index, "A.md") };
  const beforeB = { ...recordByPath(index, "B.md") };

  vault.files.delete("A.md");
  vault.files.delete("B.md");
  vault.files.set("C.md", { bytes: enc("new identity"), mtime: 5 });

  const changes = coalesceV4Changes([
    { type: "delete", path: "A.md", mtime: 2 },
    { type: "modify", path: "A.md", mtime: 3 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 4 },
    { type: "rename", oldPath: "B.md", path: "C.md", mtime: 5 },
  ]);
  assert.equal(changes.some(change => change.type === "rescan"), true);

  await session().sync({ operation: "normal", allowThresholdOverride: false, changes });

  const after = recordByPath(index, "C.md");
  assert.notEqual(after.fileId, beforeA.fileId);
  assert.notEqual(after.fileId, beforeB.fileId);
  assert.equal(github.files.has("A.md"), false);
  assert.equal(github.files.has("B.md"), false);
  assert.equal(github.files.has("C.md"), true);
});
''')

Path("scripts/agent-apply-causality-fix.py").unlink()
Path(".github/workflows/agent-apply-causality-fix.yml").unlink()
