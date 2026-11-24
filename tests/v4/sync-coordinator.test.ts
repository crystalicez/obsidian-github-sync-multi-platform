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

test("D489 a due debounce during ordinary failure recovery is rearmed only after successful reconciliation", async () => {
  for (const outcome of ["success", "failure", "newer-save", "disposed"] as const) {
    const timers = new FakeTimers()
    const executions: V4QueuedChange[][] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const coordinator = new V4SyncCoordinator({
      schedule: timers.schedule, cancel: timers.cancel,
      execute: async (_request, changes) => {
        executions.push(changes)
        if (executions.length === 1) return { changedFiles: 0, failed: true }
        if (executions.length === 2) {
          await gate
          if (outcome === "failure") return { changedFiles: 0, failed: true }
        }
        return { changedFiles: changes.length }
      },
    })
    try {
      coordinator.enqueue({ type: "modify", path: "offline.md", mtime: 1 })
      assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "failed")
      const recovery = coordinator.run({ operation: "normal", trigger: "manual" })
      coordinator.enqueue({ type: "modify", path: "during-recovery.md", mtime: 2 })
      timers.fireLatest()
      assert.equal(executions.length, 2)
      if (outcome === "newer-save") {
        coordinator.pauseAutomaticForSettingsSave()
        coordinator.finishSettingsSave(true)
      } else if (outcome === "disposed") coordinator.dispose()
      release()
      await recovery
      assert.equal(executions.length, 2)
      if (outcome === "success") {
        assert.equal(coordinator.isAutomaticSyncPaused, false)
        assert.equal(timers.timers.size, 1, "a timer that expired during recovery needs a fresh debounce")
        timers.fireLatest()
        await coordinator.whenIdle()
        assert.deepEqual(executions[2], [{ type: "modify", path: "during-recovery.md", mtime: 2 }])
        assert.equal(coordinator.pendingCount, 0)
        assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "completed")
      } else {
        assert.equal(timers.timers.size, 0)
        if (outcome !== "disposed") {
          assert.equal(coordinator.isAutomaticSyncPaused, true)
          assert.equal(coordinator.pendingCount, outcome === "failure" ? 2 : 1)
        }
      }
    } finally { release(); coordinator.dispose() }
  }
})

test("D489 a canceled manual-entry timer cannot consume the next debounce", async () => {
  const timers = new FakeTimers()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const executions: V4QueuedChange[][] = []
  const coordinator = new V4SyncCoordinator({
    schedule: timers.schedule, cancel: timers.cancel,
    execute: async (_request, changes) => {
      executions.push(changes)
      if (executions.length === 1) await gate
      return { changedFiles: changes.length }
    },
  })
  try {
    coordinator.enqueue({ type: "modify", path: "first.md", mtime: 1 })
    const stale = [...timers.timers.values()][0]!.callback
    const manual = coordinator.run({ operation: "normal", trigger: "manual" })
    stale()
    coordinator.enqueue({ type: "modify", path: "later.md", mtime: 2 })
    release()
    await manual
    assert.equal(executions.length, 1, "canceled timer cannot set a due follow-up flag")
    assert.equal(timers.timers.size, 1)
    timers.fireLatest()
    await coordinator.whenIdle()
    assert.deepEqual(executions[1], [{ type: "modify", path: "later.md", mtime: 2 }])
  } finally { release(); coordinator.dispose() }
})

test("D488 edits during post-Settings Manual Sync are debounced after recovery succeeds, never after failure or a newer Save", async () => {
  for (const outcome of ["success", "failure", "newer-save", "disposed"] as const) {
    const timers = new FakeTimers()
    const executions: Array<{ trigger: string; changes: V4QueuedChange[] }> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const coordinator = new V4SyncCoordinator({
      schedule: timers.schedule, cancel: timers.cancel,
      execute: async (request, changes) => {
        executions.push({ trigger: request.trigger, changes })
        if (executions.length === 1) {
          await gate
          if (outcome === "failure") return { changedFiles: 0, failed: true }
        }
        return { changedFiles: changes.length }
      },
    })
    try {
      coordinator.enqueue({ type: "modify", path: "before-save.md", mtime: 1 })
      coordinator.pauseAutomaticForSettingsSave()
      coordinator.finishSettingsSave(false)
      const recovery = coordinator.run({ operation: "normal", trigger: "manual" })
      coordinator.enqueue({ type: "modify", path: "during-recovery.md", mtime: 2 })
      assert.equal(timers.timers.size, 0, "no unattended upload during recovery")
      assert.equal(coordinator.pendingCount, 1)
      if (outcome === "newer-save") {
        coordinator.pauseAutomaticForSettingsSave()
        coordinator.finishSettingsSave(true)
      } else if (outcome === "disposed") coordinator.dispose()
      release()
      await recovery
      assert.equal(executions.length, 1)
      if (outcome === "success") {
        assert.equal(coordinator.isAutomaticSyncPaused, false)
        assert.equal(timers.timers.size, 1, "queued edit needs a fresh debounce even without a new Vault event")
        timers.fireLatest()
        await coordinator.whenIdle()
        assert.deepEqual(executions[1], { trigger: "localChange", changes: [{ type: "modify", path: "during-recovery.md", mtime: 2 }] })
        assert.equal(coordinator.pendingCount, 0)
      } else {
        assert.equal(timers.timers.size, 0, "failed, stale or disposed recovery cannot schedule writes")
        if (outcome !== "disposed") {
          assert.equal(coordinator.isAutomaticSyncPaused, true)
          assert.equal(coordinator.pendingCount, outcome === "failure" ? 2 : 1)
        }
      }
    } finally { release(); coordinator.dispose() }
  }
})

test("D485 a Settings save cannot replay an old or due local debounce against changed GitHub routing", async () => {
  const timers = new FakeTimers()
  const executions: Array<{ trigger: string; paths: string[] }> = []
  const coordinator = new V4SyncCoordinator({
    schedule: timers.schedule, cancel: timers.cancel,
    execute: async (request, changes) => {
      executions.push({ trigger: request.trigger, paths: changes.map(change => change.path) })
      return { changedFiles: changes.length }
    },
  })
  try {
    coordinator.enqueue({ type: "modify", path: "before-save.md", mtime: 1 })
    const staleCallback = [...timers.timers.values()][0]!.callback
    assert.equal(coordinator.pendingCount, 1)
    coordinator.pauseAutomaticForSettingsSave()
    assert.equal(timers.timers.size, 0, "the old debouncer must be cancelled synchronously")
    coordinator.enqueue({ type: "modify", path: "while-saving.md", mtime: 2 })
    staleCallback()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(executions, [], "a fired cancelled timer must not execute Sync during Save")
    assert.equal(coordinator.pendingCount, 2, "old and concurrent edits remain available to Manual Sync")
    assert.equal(coordinator.finishSettingsSave(true), false,
      "queued old-target changes must not auto-sync to the newly saved target")
    assert.equal(coordinator.isAutomaticSyncPaused, true)
    assert.deepEqual(executions, [])
    assert.equal(timers.timers.size, 0)
    assert.deepEqual(await coordinator.run({ operation: "normal", trigger: "scheduled" }),
      { status: "skipped", changedFiles: 0 })
    assert.deepEqual(await coordinator.run({ operation: "normal", trigger: "manual" }),
      { status: "completed", changedFiles: 2 })
    assert.deepEqual(executions, [{ trigger: "manual", paths: ["before-save.md", "while-saving.md"] }])
    assert.equal(coordinator.isAutomaticSyncPaused, false)
    coordinator.enqueue({ type: "modify", path: "after-manual.md", mtime: 3 })
    timers.fireLatest()
    await coordinator.whenIdle()
    assert.deepEqual(executions.at(-1), { trigger: "localChange", paths: ["after-manual.md"] })
  } finally { coordinator.dispose() }
})

test("D485 a pre-Save Manual Sync finishing during or after Settings persistence cannot rearm stale local Auto Sync", async () => {
  for (const ordering of ["manual-finishes-during-save", "manual-finishes-after-failed-save"] as const) {
    const timers = new FakeTimers()
    let complete!: () => void
    const blocked = new Promise<void>(resolve => { complete = resolve })
    const attempts: string[] = []
    const coordinator = new V4SyncCoordinator({
      schedule: timers.schedule, cancel: timers.cancel,
      execute: async request => {
        attempts.push(request.trigger)
        if (attempts.length === 1) await blocked
        return { changedFiles: 0 }
      },
    })
    try {
      const inFlight = coordinator.run({ operation: "normal", trigger: "manual" })
      coordinator.pauseAutomaticForSettingsSave()
      coordinator.enqueue({ type: "modify", path: "during-save.md", mtime: 3 })
      assert.equal(coordinator.pendingCount, 1)
      if (ordering === "manual-finishes-after-failed-save") {
        assert.equal(coordinator.finishSettingsSave(false), false)
      }
      complete()
      await inFlight
      assert.equal(coordinator.isAutomaticSyncPaused, true,
        "a pre-Save Manual completion must not authorize later unattended writes")
      assert.equal(timers.timers.size, 0)
      if (ordering === "manual-finishes-during-save") {
        assert.equal(coordinator.finishSettingsSave(true), false)
      }
      assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status,
        "skipped")
      assert.deepEqual(attempts, ["manual"])
      await coordinator.run({ operation: "normal", trigger: "manual" })
      assert.deepEqual(attempts, ["manual", "manual"],
        "a new explicit post-Save Manual Sync must still reconcile queued edits")
      assert.equal(coordinator.isAutomaticSyncPaused, false)
    } finally { complete(); coordinator.dispose() }
  }
})

test("D485 successful idle Settings Save resumes future automatic changes, failed Save requires manual review", async () => {
  const timers = new FakeTimers()
  let executions = 0
  const coordinator = new V4SyncCoordinator({
    schedule: timers.schedule, cancel: timers.cancel,
    execute: async () => { executions += 1; return { changedFiles: 0 } },
  })
  try {
    coordinator.pauseAutomaticForSettingsSave()
    assert.equal(coordinator.finishSettingsSave(true), true,
      "a committed Settings change with no old pending events should keep Auto Sync usable")
    coordinator.enqueue({ type: "modify", path: "fresh.md", mtime: 4 })
    timers.fireLatest()
    await coordinator.whenIdle()
    assert.equal(executions, 1)

    coordinator.pauseAutomaticForSettingsSave()
    assert.equal(coordinator.finishSettingsSave(false), false,
      "an ambiguous failed Settings persistence must not silently rearm automatic GitHub writes")
    coordinator.enqueue({ type: "modify", path: "after-failure.md", mtime: 5 })
    assert.equal(timers.timers.size, 0)
    assert.equal(executions, 1)
    await coordinator.run({ operation: "normal", trigger: "manual" })
    assert.equal(executions, 2)
    assert.equal(coordinator.isAutomaticSyncPaused, false)
  } finally { coordinator.dispose() }
})

test("D282 Sync execution generation records completed or failed runs but not skipped attempts", async () => {
  let release!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const coordinator = new V4SyncCoordinator({
    execute: async () => {
      calls++
      if (calls === 1) await blocker
      if (calls === 2) throw Error("simulated failed Sync")
      return { changedFiles: 0 }
    },
  })
  assert.equal(coordinator.syncExecutionGeneration, 0)
  const first = coordinator.run({ operation: "normal", trigger: "manual" })
  assert.equal(coordinator.syncExecutionGeneration, 1, "Sync start changes generation synchronously")
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped")
  assert.equal(coordinator.syncExecutionGeneration, 1, "skipped ticks cannot invent a Sync run")
  release()
  assert.equal((await first).status, "completed")
  assert.equal(coordinator.isSyncing, false)
  assert.equal(coordinator.syncExecutionGeneration, 1, "completed Sync leaves durable in-Runtime evidence")
  await assert.rejects(coordinator.run({ operation: "normal", trigger: "manual" }), /simulated failed Sync/)
  assert.equal(coordinator.syncExecutionGeneration, 2, "failed Sync still invalidates an in-flight Preview")
  coordinator.dispose()
  assert.equal((await coordinator.run({ operation: "normal", trigger: "startup" })).status, "skipped")
  assert.equal(coordinator.syncExecutionGeneration, 2)
})

test("D174 synchronous Re-encryption reservation refuses active Sync and preserves its original completion", async () => {
  let finish!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  let runs = 0
  const coordinator = new V4SyncCoordinator({ execute: async () => {
    runs++
    await hold
    return { changedFiles: 1 }
  } })
  const active = coordinator.run({ operation: "normal", trigger: "manual" })
  assert.throws(() => coordinator.reserveReencryptionQuiescence(), /idle Sync/)
  finish()
  assert.deepEqual(await active, { status: "completed", changedFiles: 1 })
  const assertQuiet = coordinator.reserveReencryptionQuiescence()
  assert.doesNotThrow(assertQuiet)
  assert.equal((await coordinator.run({ operation: "normal", trigger: "startup" })).status, "skipped")
  assert.equal((await coordinator.run({ operation: "forcePush", trigger: "forcePush" })).status, "busy")
  assert.equal(runs, 1)
  assert.throws(() => coordinator.reserveReencryptionQuiescence(), /idle Sync/)
  coordinator.dispose()
  assert.throws(assertQuiet, /Manual Recovery/)
})

test("D174 pending timer cannot be cleared to claim quiescence and queued data is not lost", async () => {
  const timers = new FakeTimers()
  let runs = 0
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => { runs++; return { changedFiles: changes.length } },
    schedule: timers.schedule, cancel: timers.cancel,
  })
  coordinator.enqueue({ type: "modify", path: "note.md", mtime: 1 })
  assert.throws(() => coordinator.reserveReencryptionQuiescence(), /idle Sync/)
  assert.equal(timers.timers.size, 1)
  timers.fireLatest()
  await coordinator.whenIdle()
  assert.equal(runs, 1)
  const assertQuiet = coordinator.reserveReencryptionQuiescence()
  assert.doesNotThrow(assertQuiet)
})

test("D174 changes arriving while a fence is being written poison quiescence without launching Sync", async () => {
  const notices: string[] = []
  let executions = 0
  const coordinator = new V4SyncCoordinator({
    execute: async () => { executions++; return { changedFiles: 0 } },
    notice: value => notices.push(value),
  })
  const assertQuiet = coordinator.reserveReencryptionQuiescence()
  assert.doesNotThrow(assertQuiet)
  coordinator.enqueue({ type: "rename", oldPath: "before.md", path: "after.md", mtime: 1 })
  assert.throws(assertQuiet, /Manual Recovery/)
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped")
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "busy")
  assert.equal(coordinator.pendingCount, 0)
  assert.equal(executions, 0)
  assert.match(notices[0]!, /Re-encryption preparation/)
})

test("D466 a large Vault import still starts automatic Sync with a safe rescan", async () => {
  const timers = new FakeTimers();
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      return { changedFiles: changes.length };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  for (let mtime = 0; mtime < 160_000; mtime++) {
    coordinator.enqueue({ type: "modify", path: "Imported/note.md", mtime });
  }
  coordinator.enqueue({ type: "rescan", mtime: 5 });
  assert.equal(coordinator.pendingCount, 1,
    "large pending event bursts must remain inspectable without a RangeError");
  timers.fireLatest();
  await coordinator.whenIdle();
  assert.deepEqual(executions, [[{ type: "rescan", mtime: 159_999 }]],
    "an imported Vault burst must still trigger a normal debounced rescan");
  assert.equal(coordinator.pendingCount, 0);
});

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

test("D470 handled Sync failure pauses automatic work without a second error notice", async () => {
  const timers = new FakeTimers();
  const attempts: V4QueuedChange[][] = [];
  const notices: string[] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      attempts.push(changes);
      return attempts.length === 1
        ? { changedFiles: 0, failed: true }
        : { changedFiles: changes.length };
    },
    notice: message => notices.push(message),
    schedule: timers.schedule, cancel: timers.cancel,
  });
  coordinator.enqueue({ type: "modify", path: "notes.md", mtime: 1 });
  assert.deepEqual(await coordinator.run({ operation: "normal", trigger: "manual" }),
    { status: "failed", changedFiles: 0 });
  assert.equal(coordinator.pendingCount, 1);
  assert.deepEqual(await coordinator.run({ operation: "normal", trigger: "scheduled" }),
    { status: "skipped", changedFiles: 0 });
  assert.equal(attempts.length, 1);
  assert.deepEqual(notices, [], "Runtime already displayed the user-facing failure");
  assert.deepEqual(await coordinator.run({ operation: "normal", trigger: "manual" }),
    { status: "completed", changedFiles: 1 });
  assert.equal(coordinator.pendingCount, 0);
  coordinator.enqueue({ type: "modify", path: "later.md", mtime: 2 });
  timers.fireLatest();
  await coordinator.whenIdle();
  assert.equal(attempts.length, 3, "successful manual reconciliation resumes automatic Sync");
  coordinator.dispose();
});

test("D468 failed Sync with a due follow-up holds queued edits until explicit reconciliation", async () => {
  const timers = new FakeTimers();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      if (executions.length === 1) {
        await paused;
        throw Error("uncertain remote write");
      }
      return { changedFiles: changes.length };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  const first = coordinator.run({ operation: "normal", trigger: "manual" });
  coordinator.enqueue({ type: "modify", path: "during.md", mtime: 2 });
  timers.fireLatest();
  release();
  await assert.rejects(first, /uncertain remote write/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(executions.length, 1, "failed Sync must not launch a queued automatic follow-up");
  assert.equal(coordinator.pendingCount, 1, "edits arriving during the failed Sync stay queued");
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped");
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "completed");
  assert.deepEqual(executions[1], [{ type: "modify", path: "during.md", mtime: 2 }]);
  assert.equal(coordinator.pendingCount, 0);
});

test("D468 failed automatic Sync retains original changes and pauses later automatic retries", async () => {
  const timers = new FakeTimers();
  const executions: V4QueuedChange[][] = [];
  const notices: string[] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      if (executions.length === 1) throw Error("uncertain remote error containing private content");
      return { changedFiles: changes.length };
    },
    notice: message => notices.push(message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  coordinator.enqueue({ type: "modify", path: "before.md", mtime: 1 });
  timers.fireLatest();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(coordinator.pendingCount, 1, "a failed attempt must not discard flushed file events");
  coordinator.enqueue({ type: "modify", path: "after.md", mtime: 2 });
  timers.fireLatest();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(executions.length, 1, "a new event must not silently resume automatic writes after uncertainty");
  assert.equal(coordinator.pendingCount, 2);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0]!, /private|before\.md|after\.md/u);
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "completed");
  assert.deepEqual(executions[1], [
    { type: "modify", path: "before.md", mtime: 1 },
    { type: "modify", path: "after.md", mtime: 2 },
  ]);
  coordinator.enqueue({ type: "modify", path: "later.md", mtime: 3 });
  timers.fireLatest();
  await coordinator.whenIdle();
  assert.deepEqual(executions[2], [{ type: "modify", path: "later.md", mtime: 3 }],
    "a successful explicit reconciliation re-enables automatic Sync");
});

test("D468 failing manual Sync keeps pending debounce events without an unattended retry", async () => {
  const timers = new FakeTimers();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const coordinator = new V4SyncCoordinator({
    execute: async () => {
      attempts++;
      if (attempts === 1) {
        await paused;
        throw Error("remote publish result unknown");
      }
      return { changedFiles: 1 };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  const manual = coordinator.run({ operation: "normal", trigger: "manual" });
  coordinator.enqueue({ type: "modify", path: "waiting.md", mtime: 10 });
  release();
  await assert.rejects(manual, /remote publish result unknown/u);
  timers.fireLatest();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(coordinator.pendingCount, 1);
  await coordinator.run({ operation: "normal", trigger: "manual" });
  assert.equal(attempts, 2);
  assert.equal(coordinator.pendingCount, 0);
});

test("D468 a synchronous GitHub failure retains thousands of distinct pending file changes", async () => {
  const timers = new FakeTimers();
  const requests: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({
    execute: (_request, changes) => {
      requests.push(changes);
      if (requests.length === 1) throw Error("synchronous transport exception");
      return Promise.resolve({ changedFiles: changes.length });
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  for (let i = 0; i < 8_000; i++) {
    coordinator.enqueue({ type: "modify", path: `Imported/note-${i}.md`, mtime: i });
  }
  await assert.rejects(coordinator.run({ operation: "normal", trigger: "manual" }), /synchronous transport exception/u);
  assert.equal(coordinator.pendingCount, 8_000, "a thrown transport adapter cannot discard imported file events");
  assert.equal((await coordinator.run({ operation: "normal", trigger: "scheduled" })).status, "skipped");
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "completed");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.length, 8_000);
  assert.deepEqual(requests[1]?.[0], { type: "modify", path: "Imported/note-0.md", mtime: 0 });
  assert.deepEqual(requests[1]?.at(-1), { type: "modify", path: "Imported/note-7999.md", mtime: 7999 });
  assert.equal(coordinator.pendingCount, 0);
});

test("D155 debounced automatic Sync catches unexpected rejection without retrying a remote mutation", async () => {
  const timers = new FakeTimers();
  const notices: string[] = [];
  let attempts = 0;
  const coordinator = new V4SyncCoordinator({
    execute: async () => {
      attempts++;
      if (attempts === 1) throw new Error("secret GitHub failure payload");
      return { changedFiles: 0 };
    },
    notice: message => notices.push(message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  coordinator.enqueue({ type: "modify", path: "note.md", mtime: 1 });
  timers.fireLatest();
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(coordinator.isSyncing, false);
  assert.equal(attempts, 1, "never blindly replay failed automatic GitHub mutation");
  assert.equal(timers.timers.size, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Automatic Sync stopped unexpectedly/);
  assert.doesNotMatch(notices[0]!, /secret|payload|note.md/i);
  assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "completed");
  assert.equal(attempts, 2, "a new explicit user Sync remains possible");
});

test("D155 after-active local-change follow-up also contains rejection without a retry loop", async () => {
  const timers = new FakeTimers();
  const notices: string[] = [];
  let release!: () => void;
  const firstPaused = new Promise<void>(resolve => { release = resolve; });
  const executions: V4QueuedChange[][] = [];
  const coordinator = new V4SyncCoordinator({
    execute: async (_request, changes) => {
      executions.push(changes);
      if (executions.length === 1) await firstPaused;
      if (executions.length === 2) throw new Error("private remote failure body");
      return { changedFiles: changes.length };
    },
    notice: message => notices.push(message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  const first = coordinator.run({ operation: "normal", trigger: "manual" });
  coordinator.enqueue({ type: "rename", oldPath: "a.md", path: "b.md", mtime: 12 });
  timers.fireLatest();
  release();
  assert.equal((await first).status, "completed");
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(executions, [[], [{ type: "rename", oldPath: "a.md", path: "b.md", mtime: 12 }]]);
  assert.equal(coordinator.isSyncing, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Automatic Sync stopped unexpectedly/);
  assert.doesNotMatch(notices[0]!, /private|body|a.md|b.md/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(executions.length, 2, "no automatic retry after unknown write outcome");
  await coordinator.run({ operation: "normal", trigger: "manual" });
  assert.equal(executions.length, 3);
});

test("D155 manual rejection remains observable and a later automatic retry stays paused after disposal", async () => {
  const notices: string[] = [];
  let attempts = 0;
  const timers = new FakeTimers();
  const coordinator = new V4SyncCoordinator({
    execute: async () => {
      attempts++;
      throw new Error("sensitive unexpected failure");
    },
    notice: message => notices.push(message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  await assert.rejects(
    coordinator.run({ operation: "normal", trigger: "manual" }),
    /sensitive unexpected failure/,
  );
  assert.deepEqual(notices, [], "caller still owns manual failure handling");
  coordinator.enqueue({ type: "modify", path: "later.md", mtime: 2 });
  timers.fireLatest();
  coordinator.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, "automatic Sync cannot retry after a failed manual operation");
  assert.deepEqual(notices, [], "closing the plugin suppresses stale detached failure notices");
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
  let nested: Promise<{ status: "completed" | "busy" | "skipped" | "failed"; changedFiles: number }> | undefined;
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

test("v4 coalescing preserves identity-breaking changes when a full rescan is also queued", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "delete", path: "A.md", mtime: 1 },
    { type: "modify", path: "A.md", mtime: 2 },
    { type: "rescan", mtime: 3 },
  ]), [
    { type: "replace", oldPath: "A.md", path: "A.md", mtime: 2 },
    { type: "rescan", mtime: 3 },
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
