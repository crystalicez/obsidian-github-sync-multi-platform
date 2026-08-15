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

test("v4 coordinator rejects synchronous execute re-entry before starting another sync", async () => {
  let executions = 0;
  let nested: Promise<{ status: "completed" | "busy" | "skipped"; changedFiles: number }> | undefined;
  const notices: string[] = [];
  let coordinator!: V4SyncCoordinator;
  coordinator = new V4SyncCoordinator({
    execute: async () => {
      executions++;
      if (executions === 1) nested = coordinator.run({ operation: "forcePull", trigger: "forcePull" });
      return { changedFiles: 0 };
    },
    notice: message => notices.push(message),
  });

  const result = await coordinator.run({ operation: "normal", trigger: "manual" });
  assert.ok(nested);
  const nestedResult = await nested;

  assert.equal(result.status, "completed");
  assert.equal(nestedResult.status, "busy");
  assert.equal(executions, 1);
  assert.deepEqual(notices, ["GitHub Sync: Sync already in progress"]);
});

test("v4 coordinator propagates a synchronous execute error and clears the active guard", async () => {
  const coordinator = new V4SyncCoordinator({
    execute: () => { throw new Error("synchronous execute failure"); },
  });

  await assert.rejects(
    coordinator.run({ operation: "normal", trigger: "manual" }),
    /synchronous execute failure/iu,
  );

  assert.equal(coordinator.isSyncing, false);
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

test("v4 coordinator permanently skips runs and enqueues after disposal", async () => {
  const timers = new FakeTimers();
  let executions = 0;
  const notices: string[] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async () => { executions++; return { changedFiles: 1 }; },
    notice: message => notices.push(message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.dispose();
  coordinator.enqueue({ type: "modify", path: "after.md", mtime: 1 });
  const results = await Promise.all([
    coordinator.run({ operation: "normal", trigger: "manual" }),
    coordinator.run({ operation: "normal", trigger: "startup" }),
    coordinator.run({ operation: "normal", trigger: "scheduled" }),
    coordinator.run({ operation: "forcePush", trigger: "forcePush" }),
    coordinator.run({ operation: "forcePull", trigger: "forcePull" }),
  ]);

  assert.deepEqual(results.map(result => result.status), ["skipped", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(coordinator.pendingCount, 0);
  assert.equal(timers.timers.size, 0);
  assert.equal(executions, 0);
  assert.deepEqual(notices, []);
});

test("v4 coordinator disposed gate covers stale timers and active finalizers", async () => {
  let staleTimer: (() => void) | undefined;
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      if (executions.length === 1) await blocker;
      return { changedFiles: changes.length };
    },
    schedule: callback => { staleTimer = callback; return 1; },
    cancel: () => undefined,
  });

  const active = coordinator.run({ operation: "normal", trigger: "manual" });
  coordinator.enqueue({ type: "modify", path: "pending.md", mtime: 1 });
  coordinator.dispose();
  staleTimer?.();
  coordinator.enqueue({ type: "modify", path: "after-dispose.md", mtime: 2 });
  release();
  await active;
  await coordinator.whenIdle();

  assert.deepEqual(executions, [[]]);
  assert.equal(coordinator.pendingCount, 0);
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

test("v4 coalescing preserves replacement identity discontinuity and rescans ambiguous rename-delete sequences", async () => {
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({ execute: async (_request, changes) => { executions.push(changes); return { changedFiles: changes.length }; } });

  coordinator.enqueue({ type: "delete", path: "replaced.md", mtime: 1 });
  coordinator.enqueue({ type: "modify", path: "replaced.md", mtime: 2 });
  await coordinator.run({ operation: "normal", trigger: "manual" });

  coordinator.enqueue({ type: "rename", oldPath: "old.md", path: "new.md", mtime: 3 });
  coordinator.enqueue({ type: "delete", path: "new.md", mtime: 4 });
  await coordinator.run({ operation: "normal", trigger: "manual" });

  assert.deepEqual(executions, [
    [{ type: "replace", oldPath: "replaced.md", path: "replaced.md", mtime: 2 }],
    [
      { type: "rename", oldPath: "old.md", path: "new.md", mtime: 3 },
      { type: "delete", path: "new.md", mtime: 4 },
      { type: "rescan", mtime: 4 },
    ],
  ]);
});

test("v4 coalescing preserves replacement identity break through a subsequent rename", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "delete", path: "A.md", mtime: 1 },
    { type: "modify", path: "A.md", mtime: 2 },
    { type: "rename", oldPath: "A.md", path: "B.md", mtime: 3 },
  ]), [
    { type: "replace", oldPath: "A.md", path: "B.md", mtime: 3 },
  ]);
});

test("v4 coalescing falls back to a causal rescan when a rename cycle can hide an overwritten destination", () => {
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

test("v4 coordinator collapses folder events to one full rescan", async () => {
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({ execute: async (_request, changes) => { executions.push(changes); return { changedFiles: changes.length }; } });
  coordinator.enqueue({ type: "rescan", mtime: 1 });
  coordinator.enqueue({ type: "modify", path: "Folder/note.md", mtime: 2 });
  await coordinator.run({ operation: "normal", trigger: "manual" });
  assert.deepEqual(executions, [[{ type: "rescan", mtime: 2 }]]);
});

test("v4 folder changes preserve causal event order across delete-recreate interactions", () => {
  const changes: V4QueuedChange[] = [
    { type: "folderDelete", path: "F", mtime: 1 },
    { type: "folderRename", oldPath: "H", path: "F", mtime: 2 },
    { type: "folderDelete", path: "F", mtime: 3 },
    { type: "modify", path: "F/a.md", mtime: 4 },
    { type: "rename", oldPath: "F/a.md", path: "H/a.md", mtime: 5 },
  ];
  assert.deepEqual(coalesceV4Changes(changes), changes);
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

test("v4 coordinator aborts the active execution on dispose and starts no follow-up work", async () => {
  let observedSignal: AbortSignal | undefined
  let executions = 0
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, _changes, signal) => {
      executions++
      observedSignal = signal
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      return { changedFiles: 0 }
    },
  })
  const active = coordinator.run({ operation: "normal", trigger: "manual" })
  coordinator.dispose()
  await assert.rejects(active)
  assert.equal(observedSignal?.aborted, true)
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "skipped")
  assert.equal(executions, 1)
})
