import assert from "node:assert/strict";
import test from "node:test";

import { EncryptedChangeQueue } from "../../src/lib/encrypted/change-queue";

test("encrypted change queue batches thousands of creates into one change set", () => {
  const queue = new EncryptedChangeQueue();
  for (let index = 0; index < 2_000; index++) {
    queue.enqueue({ type: "modify", path: `Notes/note-${index}.md`, mtime: index });
  }

  const batch = queue.flush();

  assert.equal(batch.length, 2_000);
  assert.equal(queue.size, 0);
  assert.equal(batch[0].path, "Notes/note-0.md");
  assert.equal(batch.at(-1)?.path, "Notes/note-1999.md");
});

test("encrypted change queue collapses repeated typing to the latest modify", () => {
  const queue = new EncryptedChangeQueue();

  queue.enqueue({ type: "modify", path: "Notes/live.md", mtime: 1 });
  queue.enqueue({ type: "modify", path: "Notes/live.md", mtime: 2 });
  queue.enqueue({ type: "modify", path: "Notes/live.md", mtime: 3 });

  const batch = queue.flush();

  assert.deepEqual(batch, [{ type: "modify", path: "Notes/live.md", mtime: 3 }]);
});

test("encrypted change queue coalesces rename plus modify to final path", () => {
  const queue = new EncryptedChangeQueue();

  queue.enqueue({ type: "rename", oldPath: "Notes/draft.md", path: "Notes/final.md", mtime: 10 });
  queue.enqueue({ type: "modify", path: "Notes/final.md", mtime: 11 });

  const batch = queue.flush();

  assert.deepEqual(batch, [{ type: "rename", oldPath: "Notes/draft.md", path: "Notes/final.md", mtime: 11 }]);
});

test("encrypted change queue delete removes pending modify for the same path", () => {
  const queue = new EncryptedChangeQueue();

  queue.enqueue({ type: "modify", path: "Notes/remove.md", mtime: 1 });
  queue.enqueue({ type: "delete", path: "Notes/remove.md", mtime: 2 });

  const batch = queue.flush();

  assert.deepEqual(batch, [{ type: "delete", path: "Notes/remove.md", mtime: 2 }]);
});