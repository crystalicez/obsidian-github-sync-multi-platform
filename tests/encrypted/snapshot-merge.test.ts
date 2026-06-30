import assert from "node:assert/strict";
import test from "node:test";

import { mergeEncryptedSnapshots } from "../../src/lib/encrypted/snapshot-merge";
import type { EncryptedSnapshotFileRecord, EncryptedSnapshotManifest } from "../../src/lib/encrypted/snapshot-types";

function record(path: string, hash: string, deleted = false): EncryptedSnapshotFileRecord {
  return {
    path,
    objectId: `object-${hash}`,
    storage: "object",
    plaintextSha256: hash.repeat(64).slice(0, 64),
    size: deleted ? 0 : hash.length,
    mtime: hash.charCodeAt(0),
    deleted,
    deletedAt: deleted ? hash.charCodeAt(0) : undefined,
  };
}

function snapshot(snapshotId: string, generation: number, files: Record<string, EncryptedSnapshotFileRecord>): EncryptedSnapshotManifest {
  return {
    formatVersion: 2,
    snapshotId,
    parentSnapshotIds: generation === 1 ? [] : [`snap-${generation - 1}`],
    generation,
    createdAt: generation,
    files,
  };
}

test("snapshot merge preserves independent stale-device additions", () => {
  const base = snapshot("base", 1, { "Notes/a.md": record("Notes/a.md", "a") });
  const local = snapshot("local", 2, { ...base.files, "Notes/local.md": record("Notes/local.md", "l") });
  const remote = snapshot("remote", 3, { ...base.files, "Notes/remote.md": record("Notes/remote.md", "r") });

  const result = mergeEncryptedSnapshots({ base, local, remote, snapshotId: "merged", now: 10 });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.snapshot.generation, 4);
  assert.deepEqual(result.snapshot.parentSnapshotIds, ["local", "remote"]);
  assert.equal(result.snapshot.files["Notes/local.md"].plaintextSha256, record("Notes/local.md", "l").plaintextSha256);
  assert.equal(result.snapshot.files["Notes/remote.md"].plaintextSha256, record("Notes/remote.md", "r").plaintextSha256);
});

test("snapshot merge reports same-path divergent edits as conflicts", () => {
  const base = snapshot("base", 1, { "Notes/a.md": record("Notes/a.md", "a") });
  const local = snapshot("local", 2, { "Notes/a.md": record("Notes/a.md", "l") });
  const remote = snapshot("remote", 3, { "Notes/a.md": record("Notes/a.md", "r") });

  const result = mergeEncryptedSnapshots({ base, local, remote, snapshotId: "merged", now: 10 });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, "Notes/a.md");
  assert.equal(result.snapshot.files["Notes/a.md"].plaintextSha256, remote.files["Notes/a.md"].plaintextSha256);
});

test("snapshot merge preserves delete tombstones across devices", () => {
  const base = snapshot("base", 1, { "Notes/a.md": record("Notes/a.md", "a"), "Notes/b.md": record("Notes/b.md", "b") });
  const local = snapshot("local", 2, { ...base.files, "Notes/a.md": record("Notes/a.md", "d", true) });
  const remote = snapshot("remote", 3, { ...base.files, "Notes/c.md": record("Notes/c.md", "c") });

  const result = mergeEncryptedSnapshots({ base, local, remote, snapshotId: "merged", now: 10 });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.snapshot.files["Notes/a.md"].deleted, true);
  assert.equal(result.snapshot.files["Notes/c.md"].deleted, false);
});

test("snapshot merge keeps rename representation as tombstone plus create", () => {
  const base = snapshot("base", 1, { "Notes/old.md": record("Notes/old.md", "a") });
  const local = snapshot("local", 2, {
    "Notes/old.md": record("Notes/old.md", "d", true),
    "Notes/new.md": record("Notes/new.md", "a"),
  });
  const remote = snapshot("remote", 3, { ...base.files, "Notes/remote.md": record("Notes/remote.md", "r") });

  const result = mergeEncryptedSnapshots({ base, local, remote, snapshotId: "merged", now: 10 });

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.snapshot.files["Notes/old.md"].deleted, true);
  assert.equal(result.snapshot.files["Notes/new.md"].deleted, false);
  assert.equal(result.snapshot.files["Notes/remote.md"].deleted, false);
});