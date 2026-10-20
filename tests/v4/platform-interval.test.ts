import assert from "node:assert/strict";
import test from "node:test";
import { startV4PlatformInterval, startV4PlatformTimeout } from "../../src/lib/v4/platform-interval";

test("desktop scheduled sync uses Node interval and cancels with matching Node clearer", () => {
  let nodeTick!: () => void;
  const clears: string[] = [];
  let executed = 0;
  const cancel = startV4PlatformInterval(true, () => { executed++; }, 30_000, {
    browser: {
      set: () => { throw Error("browser timer must not be used on Desktop"); },
      clear: () => { throw Error("browser timer must not clear Desktop interval"); },
    },
    node: {
      set: callback => { nodeTick = callback; return "node-handle"; },
      clear: handle => clears.push(String(handle)),
    },
  });
  nodeTick();
  nodeTick();
  assert.equal(executed, 2);
  cancel();
  assert.deepEqual(clears, ["node-handle"]);
});

test("mobile scheduled sync never evaluates Node timers and clears browser interval", () => {
  let tick!: () => void;
  let calls = 0;
  const clears: number[] = [];
  const cancel = startV4PlatformInterval(false, () => { calls++; }, 30_000, {
    browser: {
      set: callback => { tick = callback; return 42; },
      clear: handle => clears.push(Number(handle)),
    },
    node: {
      set: () => { throw Error("Node is unsupported on Mobile"); },
      clear: () => { throw Error("Node is unsupported on Mobile"); },
    },
  });
  tick();
  assert.equal(calls, 1);
  cancel();
  assert.deepEqual(clears, [42]);
});

test("deferred mobile wake uses browser timeout only and is cancelable", () => {
  let due!: () => void;
  let calls = 0;
  const cancels: number[] = [];
  const cancel = startV4PlatformTimeout(false, () => { calls++; }, 28_000, {
    browser: {
      set: (callback, ms) => { assert.equal(ms, 28_000); due = callback; return 37; },
      clear: handle => cancels.push(Number(handle)),
    },
    node: {
      set: () => { throw Error("Mobile cannot access Node timers"); },
      clear: () => { throw Error("Mobile cannot clear Node timers"); },
    },
  });
  due();
  assert.equal(calls, 1);
  cancel();
  assert.deepEqual(cancels, [37]);
});

test("deferred desktop wake uses Node timeout and matching cleanup", () => {
  let due!: () => void;
  let calls = 0;
  const cancels: string[] = [];
  const cancel = startV4PlatformTimeout(true, () => { calls++; }, 1_000, {
    browser: {
      set: () => { throw Error("Desktop must not use renderer wake timeout"); },
      clear: () => { throw Error("Desktop must not use renderer clearer"); },
    },
    node: {
      set: (callback, ms) => { assert.equal(ms, 1_000); due = callback; return "node-wake"; },
      clear: handle => cancels.push(String(handle)),
    },
  });
  due();
  assert.equal(calls, 1);
  cancel();
  assert.deepEqual(cancels, ["node-wake"]);
});
