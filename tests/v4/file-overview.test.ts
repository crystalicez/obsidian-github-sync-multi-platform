import assert from "node:assert/strict";
import test from "node:test";
import { buildV4FileOverview, countV4FileOverview, filterV4FileOverview, treeV4FileOverview } from "../../src/lib/v4/file-overview";

test("classifies local-only, remote-only, changed and baseline-matching paths without conflating them", () => {
  const model = buildV4FileOverview({
    remoteCommitSha: "immutable-commit",
    localFiles: [
      { path: "a/added.md", size: 1, mtime: 1 },
      { path: "b/change.md", size: 4, mtime: 6 },
      { path: "b/track.md", size: 5, mtime: 7 },
    ],
    remoteFiles: [
      { path: "b/change.md", remoteVersion: "remote-updated" },
      { path: "b/track.md", remoteVersion: "unchanged" },
      { path: "c/remote.md", remoteVersion: "remote" },
    ],
    baselineFiles: [
      { path: "b/change.md", remoteVersion: "old", size: 4, mtime: 6 },
      { path: "b/track.md", remoteVersion: "unchanged", size: 5, mtime: 7 },
    ],
  });
  assert.deepEqual(model.entries.map(({ path, status }) => [path, status]), [
    ["a/added.md", "local-only"], ["b/change.md", "changed"],
    ["b/track.md", "synced"], ["c/remote.md", "remote-only"],
  ]);
  assert.deepEqual(countV4FileOverview(model.entries), { all: 4, changed: 1, "local-only": 1, "remote-only": 1, synced: 1 });
  assert.deepEqual(filterV4FileOverview(model.entries, "all", "B/"), model.entries.slice(1, 3));
  assert.deepEqual(filterV4FileOverview(model.entries, "remote-only", ""), [model.entries[3]]);
  assert.deepEqual(treeV4FileOverview(model.entries).map(node => ({ name: node.name, paths: node.children.map(child => child.path) })), [
    { name: "a", paths: ["a/added.md"] }, { name: "b", paths: ["b/change.md", "b/track.md"] }, { name: "c", paths: ["c/remote.md"] },
  ]);
});

test("local stat divergence and unknown baseline remain changed, never assert synced without evidence", () => {
  const model = buildV4FileOverview({
    remoteCommitSha: "head",
    localFiles: [{ path: "same.md", size: 11, mtime: 9 }, { path: "unknown.md", size: 0, mtime: 0 }],
    remoteFiles: [{ path: "same.md", remoteVersion: "v1" }, { path: "unknown.md", remoteVersion: "v1" }],
    baselineFiles: [{ path: "same.md", size: 11, mtime: 8, remoteVersion: "v1" }],
  });
  assert.ok(model.entries.every(entry => entry.status === "changed"));
});


test("tracked one-sided deletions are changes, not new Local only or Remote-only files", () => {
  const overview = buildV4FileOverview({
    remoteCommitSha: "immutable-head",
    localFiles: [
      { path: "tracked-remote-removed.md", size: 9, mtime: 100 },
      { path: "new-local.md", size: 3, mtime: 200 },
    ],
    remoteFiles: [
      { path: "tracked-local-removed.md", remoteVersion: "version-1" },
      { path: "new-remote.md", remoteVersion: "version-2" },
    ],
    baselineFiles: [
      { path: "tracked-remote-removed.md", remoteVersion: "version-1", size: 9, mtime: 100 },
      { path: "tracked-local-removed.md", remoteVersion: "version-1", size: 8, mtime: 50 },
    ],
  });
  const byPath = new Map(overview.entries.map(entry => [entry.path, entry]));
  assert.deepEqual([byPath.get("tracked-remote-removed.md")?.status, byPath.get("tracked-remote-removed.md")?.reason], ["changed", "remote-deleted"]);
  assert.deepEqual([byPath.get("tracked-local-removed.md")?.status, byPath.get("tracked-local-removed.md")?.reason], ["changed", "local-deleted"]);
  assert.equal(byPath.get("new-local.md")?.status, "local-only");
  assert.equal(byPath.get("new-remote.md")?.status, "remote-only");
  assert.deepEqual(countV4FileOverview(overview.entries), { all: 4, changed: 2, "local-only": 1, "remote-only": 1, synced: 0 });
});

test("wide tree preserves every file once without quadratic sibling searching", () => {
  const entries = Array.from({ length: 12000 }, (_, i) => ({
    path: `wide/${String(i).padStart(5, "0")}.md`, status: "changed" as const, local: true, remote: true,
  }));
  const tree = treeV4FileOverview(entries);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, entries.length);
  assert.equal(tree[0].children[0].entry?.path, entries[0].path);
  assert.equal(tree[0].children.at(-1)?.entry?.path, entries.at(-1)?.path);
});

test("tracked remote rename is identified by stable file ID, not mislabeled as deletion and unrelated download", () => {
  const model = buildV4FileOverview({
    remoteCommitSha: "pinned",
    localFiles: [{ path: "Notes/old.md", size: 11, mtime: 30 }],
    remoteFiles: [{ path: "Archive/new.md", remoteVersion: "v2", fileId: "stable-identity" }],
    baselineFiles: [{ path: "Notes/old.md", remoteVersion: "v1", fileId: "stable-identity", size: 11, mtime: 30 }],
  });
  const byPath = new Map(model.entries.map(entry => [entry.path, entry]));
  assert.deepEqual(
    [byPath.get("Notes/old.md")?.status, byPath.get("Notes/old.md")?.reason, byPath.get("Notes/old.md")?.relatedPath],
    ["changed", "remote-renamed-from", "Archive/new.md"],
  );
  assert.deepEqual(
    [byPath.get("Archive/new.md")?.status, byPath.get("Archive/new.md")?.reason, byPath.get("Archive/new.md")?.relatedPath],
    ["changed", "remote-renamed-to", "Notes/old.md"],
  );
  assert.deepEqual(countV4FileOverview(model.entries), { all: 2, changed: 2, "local-only": 0, "remote-only": 0, synced: 0 });
});

test("ambiguous or missing file identity never invents remote rename lineage", () => {
  const input = {
    remoteCommitSha: "pinned",
    localFiles: [{ path: "old.md", size: 2, mtime: 1 }],
    baselineFiles: [{ path: "old.md", remoteVersion: "one", fileId: "id", size: 2, mtime: 1 }],
  };
  const duplicate = buildV4FileOverview({ ...input, remoteFiles: [
    { path: "new.md", remoteVersion: "two", fileId: "id" },
    { path: "another.md", remoteVersion: "three", fileId: "id" },
  ] });
  assert.equal(duplicate.entries.find(entry => entry.path === "old.md")?.reason, "remote-deleted");
  assert.equal(duplicate.entries.find(entry => entry.path === "new.md")?.status, "remote-only");
  const unknown = buildV4FileOverview({ ...input, remoteFiles: [
    { path: "new.md", remoteVersion: "two" },
  ] });
  assert.equal(unknown.entries.find(entry => entry.path === "old.md")?.reason, "remote-deleted");
  assert.equal(unknown.entries.find(entry => entry.path === "new.md")?.status, "remote-only");
});

test("filtered tree keeps ancestors, individual path identities, and nested folders", () => {
  const files = [{ path: "A/B/1.md", status: "changed" as const, local: true, remote: true },
    { path: "A/B/2.md", status: "synced" as const, local: true, remote: true }];
  const tree = treeV4FileOverview(filterV4FileOverview(files, "changed", ""));
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children[0].path, "A/B");
  assert.equal(tree[0].children[0].children[0].entry?.path, "A/B/1.md");
  assert.equal(tree[0].children[0].children.length, 1);
});
