import assert from "node:assert/strict";
import test from "node:test";
import { watchNativeBulkSync } from "../../scripts/native-bulk-watch.mjs";

test("bulk monitor waits for the actual invocation, not a stale completed UI lifecycle", async () => {
  let clock = 0;
  let polls = 0;
  const outcome = await watchNativeBulkSync({
    now: () => clock,
    sleep: async delay => { clock += delay; },
    timeoutMs: 12_000,
    poll: async () => ++polls < 3
      ? { done: false, lifecycle: "success", apiRequests: 5 }
      : { done: true, lifecycle: "success", apiRequests: 18 },
  });
  assert.deepEqual(outcome, { done: true, lifecycle: "success", apiRequests: 18 });
  assert.equal(polls, 3);
  assert.equal(clock, 4_000);
});

test("bulk monitor reports progress during a slow upload and returns only on completion", async () => {
  let clock = 0;
  const reports = [];
  const outcome = await watchNativeBulkSync({
    now: () => clock,
    sleep: async delay => { clock += delay; },
    timeoutMs: 68_000,
    onProgress: state => reports.push(state.apiRequests),
    poll: async () => ({
      done: clock >= 62_000,
      apiRequests: clock < 30_000 ? 12 : clock < 60_000 ? 27 : 51,
      inFlightApiRequests: clock < 62_000 ? 1 : 0,
    }),
  });
  assert.deepEqual(reports, [27, 51]);
  assert.deepEqual(outcome, { done: true, apiRequests: 51, inFlightApiRequests: 0 });
});

test("bulk timeout retains the last observed GitHub phase and request state", async () => {
  let clock = 0;
  await assert.rejects(watchNativeBulkSync({
    now: () => clock,
    sleep: async delay => { clock += delay; },
    timeoutMs: 5_000,
    poll: async () => ({ done: false, phase: "encrypting", apiRequests: 236, inFlightApiRequests: 0, pushCompleted: 1000 }),
  }), /deadline.*"phase":"encrypting".*"apiRequests":236.*"inFlightApiRequests":0.*"pushCompleted":1000/u);
  assert.equal(clock, 5_000);
});

test("bulk monitor does not mask a failing CDP probe as a successful sync", async () => {
  await assert.rejects(
    watchNativeBulkSync({ now: () => 0, sleep: async () => {}, timeoutMs: 1000, poll: async () => { throw new Error("CDP probe unavailable"); } }),
    /CDP probe unavailable/u,
  );
});
