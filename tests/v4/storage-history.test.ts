import assert from "node:assert/strict";
import test from "node:test";
import { buildV4PartPaths, joinAndVerifyV4Parts, splitV4Parts } from "../../src/lib/v4/large-files";
import { buildV4JournalPages, fileVersionsFromV4Journals } from "../../src/lib/v4/history-journal";
import { sha256Hex } from "../../src/lib/bytes";

test("v4 large-file helpers create ordered parts and verify the full hash", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const parts = splitV4Parts(bytes, 3);
  const paths = buildV4PartPaths({ mode: "plaintext", logicalPath: "Media/movie.bin", version: "v1", partCount: parts.length });

  assert.deepEqual(parts.map(part => [...part]), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepEqual(paths.map(path => path.split("/").at(-1)), ["000001.part", "000002.part", "000003.part"]);
  assert.deepEqual(await joinAndVerifyV4Parts(parts, await sha256Hex(bytes)), bytes);
  await assert.rejects(() => joinAndVerifyV4Parts(parts, "bad"), /hash mismatch/iu);
});

test("v4 journals page large changes and preserve file history across rename", () => {
  const changes = [
    { fileId: "note", kind: "create" as const, path: "old.md", after: { remotePath: "old.md", sha: "a", size: 1 } },
    { fileId: "note", kind: "rename" as const, path: "new.md", previousPath: "old.md", before: { remotePath: "old.md", sha: "a", size: 1 }, after: { remotePath: "new.md", sha: "b", size: 1 } },
    { fileId: "other", kind: "create" as const, path: "other.md", after: { remotePath: "other.md", sha: "c", size: 1 } },
  ];
  const pages = buildV4JournalPages("journal", changes, 2);
  const versions = fileVersionsFromV4Journals("note", [
    { commitSha: "c1", authoredAt: 1, changes: pages[0].changes },
    { commitSha: "c2", authoredAt: 2, changes: pages[1].changes },
  ]);

  assert.equal(pages.length, 2);
  assert.deepEqual(versions.map(version => version.path), ["old.md", "new.md"]);
});
