import assert from "node:assert/strict";
import test from "node:test";
import { coalesceV4Changes, V4SyncCoordinator, type V4QueuedChange, type V4SyncRequest } from "../../src/lib/v4/sync-coordinator";

class FakeTimers {
  next = 1;
  timers = new Map<number, { callback: () => void; delay: number }>();
  schedule = (callback: () => void, delay: number) => {
    const id = this.next++;
    this.timers.set(id, { callback, delay });
    return id;
  };
  cancel = (id: number) => { this.timers.delete(id); };
  fireLatest() {
    const entry = [...this.timers.entries()].at(-1);
    if (!entry) throw new Error("no timer");
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

test("v4 coordinator globally debounces and coalesces local changes for five seconds", async () => {
  const timers = new FakeTimers();
  const executions: Array<{ request: V4SyncRequest; changes: V4QueuedChange[] }> = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (request, changes) => { executions.push({ request, changes }); return { changedFiles: changes.length }; },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.enqueue({ type: "modify", path: "note.md", mtime: 1 });
  coordinator.enqueue({ type: "modify", path: "note.md", mtime: 2 });
  assert.equal([...timers.timers.values()][0].delay, 5_000);
  assert.equal(timers.timers.size, 1);
  timers.fireLatest();
  await coordinator.whenIdle();

  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].changes, [{ type: "modify", path: "note.md", mtime: 2 }]);
  assert.equal(executions[0].request.trigger, "localChange");
});

test("v4 coordinator rejects repeated user operations while a sync is active", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const notices: string[] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async () => { await blocker; return { changedFiles: 0 }; },
    notice: message => notices.push(message),
  });

  const active = coordinator.run({ operation: "normal", trigger: "manual" });
  const repeated = await coordinator.run({ operation: "forcePush", trigger: "forcePush" });
  assert.equal(repeated.status, "busy");
  assert.deepEqual(notices, ["GitHub Sync: Sync already in progress"]);
  release();
  await active;
});

test("v4 coordinator preserves local events arriving during a sync", async () => {
  const timers = new FakeTimers();
  const executions: V4QueuedChange[][] = [];
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      if (first) { first = false; await blocker; }
      return { changedFiles: changes.length };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  const active = coordinator.run({ operation: "normal", trigger: "manual" });
  coordinator.enqueue({ type: "modify", path: "after.md", mtime: 1 });
  timers.fireLatest();
  release();
  await active;
  await coordinator.whenIdle();

  assert.deepEqual(executions, [[], [{ type: "modify", path: "after.md", mtime: 1 }]]);
});

test("v4 coordinator skips scheduled ticks while busy", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const coordinator = new V4SyncCoordinator({ execute: async () => { await blocker; return { changedFiles: 0 }; } });
  const active = coordinator.run({ operation: "normal", trigger: "manual" });
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped");
  release();
  await active;
});

test("v4 coordinator does not let a scheduled tick cut short a pending local debounce", async () => {
  const timers = new FakeTimers();
  const executions: string[] = [];
  const coordinator = new V4SyncCoordinator({
    schedule: timers.schedule,
    cancel: timers.cancel,
    execute: async (request, changes) => { executions.push(`${request.trigger}:${changes.length}`); return { changedFiles: changes.length }; },
  });
  coordinator.enqueue({ type: "modify", path: "a.md", mtime: 1 });
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped");
  assert.deepEqual(executions, []);
  timers.fireLatest();
  await coordinator.whenIdle();
  assert.deepEqual(executions, ["localChange:1"]);
});

test("v4 coalescing follows the final filesystem state for replacement and rename-delete sequences", async () => {
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({ execute: async (_request, changes) => { executions.push(changes); return { changedFiles: changes.length }; } });

  coordinator.enqueue({ type: "delete", path: "replaced.md", mtime: 1 });
  coordinator.enqueue({ type: "modify", path: "replaced.md", mtime: 2 });
  await coordinator.run({ operation: "normal", trigger: "manual" });

  coordinator.enqueue({ type: "rename", oldPath: "old.md", path: "new.md", mtime: 3 });
  coordinator.enqueue({ type: "delete", path: "new.md", mtime: 4 });
  await coordinator.run({ operation: "normal", trigger: "manual" });

  assert.deepEqual(executions, [
    [{ type: "modify", path: "replaced.md", mtime: 2 }],
    [{ type: "delete", path: "old.md", mtime: 4 }],
  ]);
});

test("v4 coordinator collapses folder events to one full rescan", async () => {
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({ execute: async (_request, changes) => { executions.push(changes); return { changedFiles: changes.length }; } });
  coordinator.enqueue({ type: "rescan", mtime: 1 });
  coordinator.enqueue({ type: "modify", path: "Folder/note.md", mtime: 2 });
  await coordinator.run({ operation: "normal", trigger: "manual" });
  assert.deepEqual(executions, [[{ type: "rescan", mtime: 2 }]]);
});

test("v4 folder rename keeps descendant changes as one prefix mapping", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
    { type: "modify", path: "B/note.md", mtime: 2 },
  ]), [
    { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
    { type: "modify", path: "B/note.md", mtime: 2 },
  ]);
});

test("v4 chained folder renames preserve parent-before-descendant causal order", () => {
  const changes: V4QueuedChange[] = [
    { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
    { type: "folderRename", oldPath: "B/N", path: "B/M", mtime: 2 },
    { type: "folderRename", oldPath: "B", path: "C", mtime: 3 },
  ];
  assert.deepEqual(coalesceV4Changes(changes), changes);
});
