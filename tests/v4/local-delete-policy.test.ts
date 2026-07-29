import assert from "node:assert/strict";
import test from "node:test";

import { trashV4LocalUserFile } from "../../src/lib/v4/local-delete-policy";

test("v4 local user-file deletion delegates only to trash semantics", async () => {
  const operations: string[] = [];
  const io = {
    async trash(path: string) { operations.push(`trash:${path}`); },
  };

  await trashV4LocalUserFile(io, "Notes/a.md");

  assert.deepEqual(operations, ["trash:Notes/a.md"]);
});

test("v4 local user-file trash is idempotent when the target is already absent", async () => {
  const files = new Set<string>();
  let calls = 0;
  const io = {
    async trash(path: string) { calls++; files.delete(path); },
  };

  await trashV4LocalUserFile(io, "missing.md");
  await trashV4LocalUserFile(io, "missing.md");

  assert.equal(calls, 2);
  assert.equal(files.has("missing.md"), false);
});
