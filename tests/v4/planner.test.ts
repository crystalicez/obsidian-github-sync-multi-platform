import assert from "node:assert/strict";
import test from "node:test";
import { planV4Sync, type V4LogicalFile } from "../../src/lib/v4/planner";

function file(path: string, fileId: string, hash: string, mtime = 1): V4LogicalFile {
  return { path, fileId, hash, size: 1, mtime };
}

test("v4 planner pulls remote changes before independent local pushes", () => {
  const base = [file("remote.md", "remote", "a"), file("local.md", "local", "a")];
  const local = [file("remote.md", "remote", "a"), file("local.md", "local", "local-new")];
  const remote = [file("remote.md", "remote", "remote-new"), file("local.md", "local", "a")];
  const plan = planV4Sync({ operation: "normal", base, local, remote });

  assert.deepEqual(plan.pulls.map(change => change.path), ["remote.md"]);
  assert.deepEqual(plan.pushes.map(change => change.path), ["local.md"]);
  assert.equal(plan.conflicts.length, 0);
});

test("v4 planner detects divergent same-file edits as a conflict", () => {
  const base = [file("note.md", "note", "base")];
  const local = [file("note.md", "note", "local")];
  const remote = [file("note.md", "note", "remote")];
  const plan = planV4Sync({ operation: "normal", base, local, remote });

  assert.equal(plan.pulls.length, 0);
  assert.equal(plan.pushes.length, 0);
  assert.equal(plan.conflicts[0].fileId, "note");
});

test("v4 planner treats a rename as one logical push", () => {
  const plan = planV4Sync({
    operation: "normal",
    base: [file("old.md", "note", "same")],
    local: [file("new.md", "note", "same")],
    remote: [file("old.md", "note", "same")],
  });

  assert.deepEqual(plan.pushes.map(change => ({ kind: change.kind, path: change.path, previousPath: change.previousPath })), [
    { kind: "rename", path: "new.md", previousPath: "old.md" },
  ]);
  assert.equal(plan.changedFiles, 1);
});

test("v4 normal sync rejects different identities that collide across local and remote namespaces", () => {
  for (const [localPath, remotePath] of [
    ["note.md", "note.md"],
    ["Foo.md", "foo.md"],
    ["é.md", "e\u0301.md"],
  ] as const) {
    assert.throws(
      () => planV4Sync({
        operation: "normal",
        base: [],
        local: [file(localPath, "local-id", "local")],
        remote: [file(remotePath, "remote-id", "remote")],
      }),
      /V4 path collision across local\/remote state/u,
    );
  }
});

test("v4 planner allows a same-identity case-only rename", () => {
  const plan = planV4Sync({
    operation: "normal",
    base: [file("Foo.md", "note", "same")],
    local: [file("foo.md", "note", "same")],
    remote: [file("Foo.md", "note", "same")],
  });

  assert.deepEqual(plan.pushes.map(change => ({ kind: change.kind, path: change.path, previousPath: change.previousPath })), [
    { kind: "rename", path: "foo.md", previousPath: "Foo.md" },
  ]);
});

test("v4 force operations can resolve cross-side namespace divergence", () => {
  const local = [file("Foo.md", "local-id", "local")];
  const remote = [file("foo.md", "remote-id", "remote")];

  assert.doesNotThrow(() => planV4Sync({ operation: "forcePush", base: [], local, remote }));
  assert.doesNotThrow(() => planV4Sync({ operation: "forcePull", base: [], local, remote }));
});

test("v4 normal sync allows a local delete-recreate when remote still matches the base", () => {
  const plan = planV4Sync({
    operation: "normal",
    base: [file("same.md", "old-id", "base")],
    local: [file("same.md", "new-id", "local-new")],
    remote: [file("same.md", "old-id", "base")],
  });

  assert.deepEqual(plan.pushes.map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path })), [
    { fileId: "old-id", kind: "delete", path: "same.md" },
    { fileId: "new-id", kind: "create", path: "same.md" },
  ]);
  assert.equal(plan.pulls.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("v4 normal sync allows a remote delete-recreate when local still matches the base", () => {
  const plan = planV4Sync({
    operation: "normal",
    base: [file("same.md", "old-id", "base")],
    local: [file("same.md", "old-id", "base")],
    remote: [file("same.md", "new-id", "remote-new")],
  });

  assert.deepEqual(plan.pulls.map(change => ({ fileId: change.fileId, kind: change.kind, path: change.path })), [
    { fileId: "old-id", kind: "delete", path: "same.md" },
    { fileId: "new-id", kind: "create", path: "same.md" },
  ]);
  assert.equal(plan.pushes.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("v4 normal sync rejects replacement colliding with a concurrently changed base lineage", () => {
  assert.throws(
    () => planV4Sync({
      operation: "normal",
      base: [file("same.md", "old-id", "base")],
      local: [file("same.md", "new-id", "local-new")],
      remote: [file("same.md", "old-id", "remote-edited")],
    }),
    /V4 path collision across local\/remote state/u,
  );
});

test("v4 normal sync rejects two independent replacements of the same base namespace", () => {
  assert.throws(
    () => planV4Sync({
      operation: "normal",
      base: [file("same.md", "old-id", "base")],
      local: [file("same.md", "local-new-id", "local-new")],
      remote: [file("same.md", "remote-new-id", "remote-new")],
    }),
    /V4 path collision across local\/remote state/u,
  );
});
