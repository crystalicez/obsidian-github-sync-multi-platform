import assert from "node:assert/strict";
import test from "node:test";
import { startV4PlatformInterval } from "../../src/lib/v4/platform-interval";

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
