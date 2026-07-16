import assert from "node:assert/strict";
import test from "node:test";

import {
  V4ProgressStore,
  formatV4Duration,
  formatV4PhaseTiming,
  middleTruncateV4Path,
  remainingV4Progress,
  type V4SyncProgressSnapshot,
} from "../../src/lib/v4/progress";

function createProgressFixture() {
  let monotonicNow = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  const cancelled: number[] = [];
  const store = new V4ProgressStore({
    throttleMs: 400,
    timingRefreshMs: 1_000,
    schedule: (callback, delay) => {
      const handle = nextHandle++;
      scheduled.set(handle, { callback, delay });
      return handle;
    },
    cancel: handle => {
      cancelled.push(handle as number);
      scheduled.delete(handle as number);
    },
    monotonicNow: () => monotonicNow,
  });
  return {
    store,
    scheduled,
    cancelled,
    setNow(value: number) { monotonicNow = value; },
    runScheduledCallbackAt(delay: number) {
      const entry = [...scheduled.entries()].find(([, value]) => value.delay === delay);
      assert.ok(entry, `no callback scheduled at ${delay}ms`);
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test("phase changes publish immediately while path and counters throttle", () => {
  const { store, scheduled, runScheduledCallbackAt } = createProgressFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  store.subscribe(snapshot => seen.push(snapshot));
  store.update({ lifecycle: "active", phase: "checking-remote", operation: "normal", trigger: "manual" });
  store.update({ phase: "scanning-local", currentPath: "A.md" });
  store.update({ currentPath: "B.md", pull: { completed: 1, total: 3 } });
  store.update({ currentPath: "C.md", pull: { completed: 2, total: 3 } });

  assert.equal(seen.at(-1)?.currentPath, "A.md");
  assert.equal([...scheduled.values()].some(item => item.delay === 400), true);
  runScheduledCallbackAt(400);
  assert.equal(seen.at(-1)?.currentPath, "C.md");
  assert.deepEqual(seen.at(-1)?.pull, { completed: 2, total: 3 });
});

test("the default path and counter throttle is exactly 400 milliseconds", () => {
  const scheduledDelays: number[] = [];
  const store = new V4ProgressStore({
    schedule: (_callback, delay) => {
      scheduledDelays.push(delay);
      return scheduledDelays.length;
    },
    cancel: () => undefined,
    monotonicNow: () => 0,
  });
  store.beginRun({ phase: "uploading", currentPath: "A.md" });
  store.update({ currentPath: "B.md", push: { completed: 1 } });

  assert.deepEqual(scheduledDelays, [1_000, 400]);
});

test("a phase transition flushes the pending path before publishing the next phase", () => {
  const { store } = createProgressFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  store.subscribe(snapshot => seen.push(snapshot));
  store.update({ lifecycle: "active", phase: "hashing", currentPath: "A.md" });
  store.update({ currentPath: "B.md" });
  store.update({ phase: "encrypting", currentPath: "B.md" });
  assert.deepEqual(seen.slice(-2).map(item => [item.phase, item.currentPath]), [
    ["hashing", "B.md"],
    ["encrypting", "B.md"],
  ]);
});

test("normalization clamps counts and computes remaining only for known totals", () => {
  const { store } = createProgressFixture();
  store.update({ lifecycle: "active", phase: "uploading", push: { completed: 7, total: 5 } });
  assert.deepEqual(store.snapshot.push, { completed: 5, total: 5 });
  assert.equal(remainingV4Progress(store.snapshot.push), 0);
  assert.equal(remainingV4Progress({ completed: 2 }), undefined);
});

test("phase timing aggregates retries with a monotonic clock", () => {
  const { store, setNow } = createProgressFixture();
  store.beginRun({ lifecycle: "active", phase: "checking-remote", attempt: 1 });
  setNow(600);
  store.update({ phase: "scanning-local" });
  setNow(1_000);
  store.update({ phase: "checking-remote", attempt: 2 });
  setNow(2_800);
  store.finish("success", { lastSyncTime: 123 });

  assert.deepEqual(store.snapshot.timings, [
    { phase: "checking-remote", elapsedMs: 2_400, occurrences: 2 },
    { phase: "scanning-local", elapsedMs: 400, occurrences: 1 },
  ]);
  assert.equal(store.snapshot.totalElapsedMs, 2_800);
});

test("active timing refreshes once per second and terminal transition flushes exact time", () => {
  const { store, setNow, runScheduledCallbackAt } = createProgressFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  store.subscribe(snapshot => seen.push(snapshot));
  store.beginRun({ lifecycle: "active", phase: "encrypting" });
  setNow(1_000);
  runScheduledCallbackAt(1_000);
  assert.equal(seen.at(-1)?.timings[0].elapsedMs, 1_000);
  setNow(1_250);
  store.finish("success", { lastSyncTime: 999 });
  assert.equal(store.snapshot.timings[0].elapsedMs, 1_250);
});

test("a timing refresh cannot publish path or counter changes before the throttle boundary", () => {
  const { store, setNow, runScheduledCallbackAt } = createProgressFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  store.subscribe(snapshot => seen.push(snapshot));
  store.beginRun({ lifecycle: "active", phase: "uploading", currentPath: "A.md", push: { completed: 0, total: 2 } });

  setNow(900);
  store.update({ currentPath: "B.md", push: { completed: 1 } });
  setNow(1_000);
  runScheduledCallbackAt(1_000);

  assert.equal(seen.at(-1)?.timings[0].elapsedMs, 1_000);
  assert.equal(seen.at(-1)?.currentPath, "A.md");
  assert.deepEqual(seen.at(-1)?.push, { completed: 0, total: 2 });

  setNow(1_300);
  runScheduledCallbackAt(400);
  assert.equal(seen.at(-1)?.currentPath, "B.md");
  assert.deepEqual(seen.at(-1)?.push, { completed: 1, total: 2 });
});

test("metadata publications and new subscribers cannot bypass a pending throttle", () => {
  const { store, setNow, runScheduledCallbackAt } = createProgressFixture();
  const seen: V4SyncProgressSnapshot[] = [];
  store.subscribe(snapshot => seen.push(snapshot));
  store.beginRun({ phase: "uploading", currentPath: "A.md", push: { completed: 0, total: 2 } });

  setNow(900);
  store.update({ currentPath: "B.md", push: { completed: 1 } });
  store.update({ attempt: 2 });
  assert.equal(seen.at(-1)?.attempt, 2);
  assert.equal(seen.at(-1)?.currentPath, "A.md");
  assert.deepEqual(seen.at(-1)?.push, { completed: 0, total: 2 });

  let initialForLateSubscriber: V4SyncProgressSnapshot | undefined;
  store.subscribe(snapshot => { initialForLateSubscriber ??= snapshot; });
  assert.equal(initialForLateSubscriber?.currentPath, "A.md");
  assert.deepEqual(initialForLateSubscriber?.push, { completed: 0, total: 2 });

  setNow(1_300);
  runScheduledCallbackAt(400);
  assert.equal(seen.at(-1)?.currentPath, "B.md");
  assert.deepEqual(seen.at(-1)?.push, { completed: 1, total: 2 });
});

test("completed timings remain until the next run begins", () => {
  const { store, setNow } = createProgressFixture();
  store.beginRun({ lifecycle: "active", phase: "planning", currentPath: "A.md" });
  setNow(300);
  store.finish("success", { lastSyncTime: 1 });
  const completed = structuredClone(store.snapshot.timings);
  setNow(900);
  store.update({ currentPath: undefined });
  assert.deepEqual(store.snapshot.timings, completed);
  assert.equal(store.snapshot.totalElapsedMs, 300);
  store.beginRun({ lifecycle: "active", phase: "checking-remote" });
  assert.deepEqual(store.snapshot.timings, [{ phase: "checking-remote", elapsedMs: 0, occurrences: 1 }]);
});

test("terminal lifecycle updates freeze elapsed time before later metadata updates", () => {
  for (const lifecycle of ["success", "no-change", "failed"] as const) {
    const { store, setNow } = createProgressFixture();
    store.beginRun({ phase: "committing" });
    setNow(250);
    store.update({ lifecycle });
    assert.equal(store.snapshot.totalElapsedMs, 250, lifecycle);

    setNow(900);
    store.update({ lastSyncTime: 123 });
    assert.equal(store.snapshot.totalElapsedMs, 250, lifecycle);
    assert.deepEqual(store.snapshot.timings, [{ phase: "committing", elapsedMs: 250, occurrences: 1 }], lifecycle);
  }
});

test("duration formatting shows sub-tenth and repeated attempts", () => {
  assert.equal(formatV4Duration(50), "<0.1s");
  assert.equal(formatV4Duration(1_240), "1.2s");
  assert.equal(formatV4PhaseTiming({ phase: "checking-remote", elapsedMs: 2_400, occurrences: 2 }), "Checking remote 2.4s · 2 attempts");
});

test("equal patches do not publish duplicate snapshots", () => {
  const { store } = createProgressFixture();
  let deliveries = 0;
  store.subscribe(() => { deliveries += 1; });
  store.update({ lifecycle: "active", phase: "planning" });
  const afterFirstUpdate = deliveries;
  store.update({ lifecycle: "active", phase: "planning", pull: { completed: 0 }, push: { completed: 0 } });
  assert.equal(deliveries, afterFirstUpdate);
});

test("subscriber exceptions do not escape updates or stop other subscribers", () => {
  const { store } = createProgressFixture();
  let delivered = false;
  store.subscribe(() => { throw new Error("subscriber failed"); });
  store.subscribe(() => { delivered = true; });
  assert.doesNotThrow(() => store.update({ lifecycle: "active", phase: "planning" }));
  assert.equal(delivered, true);
});

test("snapshot getter returns deeply frozen copies that cannot mutate store state", () => {
  const { store, setNow } = createProgressFixture();
  store.beginRun({ phase: "uploading", push: { completed: 1, total: 3 } });
  setNow(200);
  store.finish("success");

  const first = store.snapshot;
  const second = store.snapshot;
  assert.notEqual(first.push, second.push);
  assert.notEqual(first.timings, second.timings);
  assert.notEqual(first.timings[0], second.timings[0]);
  assert.equal(Object.isFrozen(first.push), true);
  assert.equal(Object.isFrozen(first.timings), true);
  assert.equal(Object.isFrozen(first.timings[0]), true);
  assert.equal(Reflect.set(first.push, "completed", 99), false);
  assert.equal(Reflect.set(first.timings[0], "elapsedMs", 99), false);
  assert.deepEqual(store.snapshot.push, { completed: 1, total: 3 });
  assert.deepEqual(store.snapshot.timings, [{ phase: "uploading", elapsedMs: 200, occurrences: 1 }]);
});

test("nested mutation attempts in one subscriber cannot affect later subscribers", () => {
  const { store } = createProgressFixture();
  let laterPushCompleted = -1;
  let laterTimingElapsed = -1;
  store.subscribe(snapshot => {
    Reflect.set(snapshot.push, "completed", 99);
    if (snapshot.timings[0]) Reflect.set(snapshot.timings[0], "elapsedMs", 99);
  });
  store.subscribe(snapshot => {
    laterPushCompleted = snapshot.push.completed;
    laterTimingElapsed = snapshot.timings[0]?.elapsedMs ?? -1;
  });

  store.beginRun({ phase: "uploading", push: { completed: 1, total: 3 } });

  assert.equal(laterPushCompleted, 1);
  assert.equal(laterTimingElapsed, 0);
  assert.equal(store.snapshot.push.completed, 1);
  assert.equal(store.snapshot.timings[0].elapsedMs, 0);
});

test("unsubscribe stops later delivery", () => {
  const { store } = createProgressFixture();
  let deliveries = 0;
  const unsubscribe = store.subscribe(() => { deliveries += 1; });
  const beforeUnsubscribe = deliveries;
  unsubscribe();
  store.update({ lifecycle: "active", phase: "planning" });
  assert.equal(deliveries, beforeUnsubscribe);
});

test("dispose cancels pending throttle and timing refresh timers", () => {
  const { store, scheduled, cancelled } = createProgressFixture();
  store.beginRun({ lifecycle: "active", phase: "hashing", currentPath: "A.md" });
  store.update({ currentPath: "B.md" });
  assert.equal(scheduled.size, 2);
  store.dispose();
  assert.equal(scheduled.size, 0);
  assert.equal(cancelled.length, 2);
});

test("a decreasing monotonic clock clamps elapsed deltas at zero", () => {
  const { store, setNow } = createProgressFixture();
  setNow(1_000);
  store.beginRun({ lifecycle: "active", phase: "planning" });
  setNow(500);
  store.finish("success");
  assert.deepEqual(store.snapshot.timings, [{ phase: "planning", elapsedMs: 0, occurrences: 1 }]);
  assert.equal(store.snapshot.totalElapsedMs, 0);
});

test("the progress store has no arbitrary persistence API", () => {
  const { store } = createProgressFixture();
  const candidate = store as unknown as Record<string, unknown>;
  assert.equal(candidate.save, undefined);
  assert.equal(candidate.serialize, undefined);
  assert.equal(candidate.persist, undefined);
  assert.equal(candidate.toJSON, undefined);
});

test("path display keeps both ends while the snapshot retains the full path", () => {
  const path = "Projects/very/long/folder/with/context/important-note.md";
  assert.equal(middleTruncateV4Path(path, 33), "Projects/very/…/important-note.md");
  assert.equal(path, "Projects/very/long/folder/with/context/important-note.md");
});
