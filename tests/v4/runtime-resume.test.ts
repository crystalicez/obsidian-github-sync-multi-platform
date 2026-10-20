import assert from "node:assert/strict";
import test from "node:test";
import { V4PluginRuntime } from "../../src/lib/v4/runtime";

function makeRuntime(waitForIdle: () => Promise<void>) {
  const runtime = Object.create(V4PluginRuntime.prototype) as V4PluginRuntime & {
    credentialGeneration: number;
    settingsTransitionActive: boolean;
    disposed: boolean;
    coordinator: { whenIdle: () => Promise<void> };
    scheduledSync: () => Promise<unknown>;
  };
  runtime.credentialGeneration = 10;
  runtime.settingsTransitionActive = false;
  runtime.disposed = false;
  runtime.coordinator = { whenIdle: waitForIdle };
  const scheduled: string[] = [];
  runtime.scheduledSync = async () => {
    scheduled.push("normal");
    return { status: "completed", changedFiles: 2 };
  };
  return { runtime, scheduled };
}

test("resuming during an active operation defers normal reconciliation until coordinator is idle", async () => {
  let release!: () => void;
  const idle = new Promise<void>(resolve => { release = resolve; });
  const { runtime, scheduled } = makeRuntime(() => idle);
  let settled = false;
  const result = runtime.resumeSync().then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(scheduled, []);
  release();
  assert.deepEqual(await result, { status: "completed", changedFiles: 2 });
  assert.deepEqual(scheduled, ["normal"]);
});

test("settings generation changes or plugin unload while waiting prevent stale resume sync", async () => {
  for (const changed of ["generation", "unload", "transition"]) {
    let release!: () => void;
    const idle = new Promise<void>(resolve => { release = resolve; });
    const { runtime, scheduled } = makeRuntime(() => idle);
    const result = runtime.resumeSync();
    if (changed === "generation") runtime.credentialGeneration++;
    if (changed === "unload") runtime.disposed = true;
    if (changed === "transition") runtime.settingsTransitionActive = true;
    release();
    assert.deepEqual(await result, { status: "skipped", changedFiles: 0 }, changed);
    assert.deepEqual(scheduled, [], changed);
  }
});

test("a coordinator error does not skip recovery reconciliation, but existing transition must", async () => {
  const { runtime, scheduled } = makeRuntime(async () => { throw Error("previous operation failed"); });
  assert.deepEqual(await runtime.resumeSync(), { status: "completed", changedFiles: 2 });
  assert.deepEqual(scheduled, ["normal"]);
  runtime.settingsTransitionActive = true;
  assert.deepEqual(await runtime.resumeSync(), { status: "skipped", changedFiles: 0 });
  assert.deepEqual(scheduled, ["normal"]);
});
