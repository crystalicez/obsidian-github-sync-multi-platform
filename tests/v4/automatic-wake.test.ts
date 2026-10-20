import assert from "node:assert/strict";
import test from "node:test";
import { V4AutomaticWake, shouldRunV4AutomaticWake } from "../../src/lib/v4/automatic-wake";

const configured = {
  syncEnabled: true, githubToken: "test", githubOwner: "owner", githubRepo: "vault",
  scheduledSyncEnabled: false, syncOnLocalChange: true, syncOnStartup: false,
};

const settle = async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

test("resume only after meaningful inactivity, never on initial focus or duplicate foreground events", async () => {
  let now = 100_000;
  let runs = 0;
  let visible = true;
  const wake = new V4AutomaticWake({
    desktop: false, now: () => now, enabled: () => true,
    isVisible: () => visible, isOnline: () => true,
    run: async () => { runs++; },
  });
  wake.onForeground();
  await settle();
  assert.equal(runs, 0);
  visible = false;
  wake.onVisibilityChanged();
  now += 3_000;
  visible = true;
  wake.onVisibilityChanged();
  await settle();
  assert.equal(runs, 0);
  visible = false;
  wake.onVisibilityChanged();
  now += 31_000;
  visible = true;
  wake.onVisibilityChanged();
  wake.onForeground();
  await settle();
  assert.equal(runs, 1);
  wake.onForeground();
  await settle();
  assert.equal(runs, 1);
  wake.dispose();
});

test("mobile background and offline never start a new automatic sync, online foreground reconciles once", async () => {
  let now = 200_000;
  let visible = true;
  let online = true;
  let calls = 0;
  const wake = new V4AutomaticWake({
    desktop: false, now: () => now, enabled: () => true,
    isVisible: () => visible, isOnline: () => online,
    run: async () => { calls++; },
  });
  visible = false;
  wake.onVisibilityChanged();
  now += 45_000;
  online = false;
  wake.onNetworkChanged();
  visible = true;
  wake.onVisibilityChanged();
  await settle();
  assert.equal(calls, 0);
  online = true;
  wake.onNetworkChanged();
  await settle();
  assert.equal(calls, 1);
  wake.onForeground();
  await settle();
  assert.equal(calls, 1);
  wake.dispose();
});

test("desktop heartbeat detects system sleep and may reconcile while renderer remains hidden", async () => {
  let now = 1_000;
  let runs = 0;
  const wake = new V4AutomaticWake({
    desktop: true, now: () => now, enabled: () => true,
    isVisible: () => false, isOnline: () => true,
    run: async () => { runs++; },
  });
  now += 30_000;
  wake.onHeartbeat();
  await settle();
  assert.equal(runs, 0);
  now += 150_000;
  wake.onHeartbeat();
  await settle();
  assert.equal(runs, 1);
  now += 30_000;
  wake.onHeartbeat();
  await settle();
  assert.equal(runs, 1);
  wake.dispose();
});

test("wake uses existing normal-sync callback, coalesces while in flight and honors settings", async () => {
  let now = 50_000;
  let configuredForAuto = true;
  let invoked = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const wake = new V4AutomaticWake({
    desktop: true, now: () => now, enabled: () => configuredForAuto,
    isVisible: () => true, isOnline: () => true,
    run: async () => { invoked++; await blocked; },
  });
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(invoked, 1);
  now += 31_000;
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(invoked, 1);
  release();
  await settle();
  await settle();
  assert.equal(invoked, 2);
  configuredForAuto = false;
  now += 31_000;
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(invoked, 2);
  wake.dispose();
});

test("auto reconciliation requires a configured sync and an opted-in automatic trigger", () => {
  assert.equal(shouldRunV4AutomaticWake(configured), true);
  assert.equal(shouldRunV4AutomaticWake({ ...configured, syncOnLocalChange: false, scheduledSyncEnabled: true }), true);
  assert.equal(shouldRunV4AutomaticWake({ ...configured, syncOnLocalChange: false, syncOnStartup: true }), false);
  assert.equal(shouldRunV4AutomaticWake({ ...configured, syncEnabled: false }), false);
  assert.equal(shouldRunV4AutomaticWake({ ...configured, githubToken: "" }), false);
});

test("cooldown wake is deferred and delivered after the 30-second safety interval", async () => {
  let now = 60_000;
  let runs = 0;
  let deferred!: () => void;
  let delay = 0;
  let cancelled = 0;
  const wake = new V4AutomaticWake({
    desktop: false, now: () => now, enabled: () => true,
    isVisible: () => true, isOnline: () => true,
    run: async () => { runs++; },
    scheduleRetry: (callback, ms) => {
      deferred = callback;
      delay = ms;
      return () => { cancelled++; };
    },
  });
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(runs, 1);
  now += 2_000;
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(runs, 1);
  assert.equal(delay, 28_000);
  now += 28_000;
  deferred();
  await settle();
  assert.equal(runs, 2);
  assert.equal(cancelled, 0);
  wake.dispose();
});


test("mobile foreground reconciliation survives a backward wall-clock correction while hidden", async () => {
  let now = 240_000
  let visible = false
  let starts = 0
  const wake = new V4AutomaticWake({
    desktop: false, now: () => now, enabled: () => true,
    isVisible: () => visible, isOnline: () => true,
    run: async () => { starts++ },
  })
  // The OS changed local clock backward 90 seconds during screen lock.
  now -= 90_000
  visible = true
  wake.onVisibilityChanged()
  await settle()
  assert.equal(starts, 1)
  wake.onForeground()
  await settle()
  assert.equal(starts, 1)
  wake.dispose()
})

test("desktop drift heartbeat reconciles after a large backward clock correction once", async () => {
  let now = 600_000
  let runs = 0
  const wake = new V4AutomaticWake({
    desktop: true, now: () => now, enabled: () => true,
    isVisible: () => false, isOnline: () => true,
    run: async () => { runs++ },
  })
  now -= 180_000
  wake.onHeartbeat()
  await settle()
  assert.equal(runs, 1)
  wake.onHeartbeat()
  await settle()
  assert.equal(runs, 1)
  wake.dispose()
})

test("unload cancels a deferred wake without starting any more work", async () => {
  let now = 1_000;
  let runs = 0;
  let scheduled!: () => void;
  let cancellationCount = 0;
  const wake = new V4AutomaticWake({
    desktop: true, now: () => now, enabled: () => true,
    isVisible: () => true, isOnline: () => true,
    run: async () => { runs++; },
    scheduleRetry: callback => { scheduled = callback; return () => { cancellationCount++; }; },
  });
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  now += 1_000;
  wake.onNetworkChanged(false);
  wake.onNetworkChanged(true);
  await settle();
  assert.equal(runs, 1);
  wake.dispose();
  assert.equal(cancellationCount, 1);
  now += 30_000;
  scheduled();
  await settle();
  assert.equal(runs, 1);
});
