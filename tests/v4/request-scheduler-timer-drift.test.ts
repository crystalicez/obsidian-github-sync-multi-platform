import assert from "node:assert/strict"
import test from "node:test"
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler"

test("GitHub scheduler reports an overdue policy timer while writes are stalled before HTTP", async () => {
  let clock = 100
  let enterSleep!: () => void
  let releaseSleep!: () => void
  const sleeping = new Promise<void>(resolve => { enterSleep = resolve })
  const scheduler = new V4RequestScheduler({
    mutationSpacingMs: 1000,
    now: () => clock,
    sleep: async () => {
      enterSleep()
      await new Promise<void>(resolve => { releaseSleep = resolve })
    },
  })
  assert.equal(await scheduler.run("write", async () => "first"), "first")
  const second = scheduler.run("write", async () => "second")
  await sleeping
  assert.equal(scheduler.snapshot.activePolicySleeps, 1)
  assert.equal(scheduler.snapshot.oldestPolicySleepOverdueMs, 0)
  clock += 61_000
  assert.equal(scheduler.snapshot.activePolicySleeps, 1)
  assert.equal(scheduler.snapshot.oldestPolicySleepOverdueMs, 60_000)
  assert.equal(scheduler.snapshot.maxPolicySleepOvershootMs, 0)
  releaseSleep()
  assert.equal(await second, "second")
  assert.equal(scheduler.snapshot.activePolicySleeps, 0)
  assert.equal(scheduler.snapshot.oldestPolicySleepOverdueMs, 0)
  assert.equal(scheduler.snapshot.maxPolicySleepOvershootMs, 60_000)
})

test("GitHub scheduler clears policy-timer evidence on abort without starting the pending mutation", async () => {
  let clock = 200
  let enterSleep!: () => void
  const sleeping = new Promise<void>(resolve => { enterSleep = resolve })
  const controller = new AbortController()
  const scheduler = new V4RequestScheduler({
    mutationSpacingMs: 1000,
    now: () => clock,
    sleep: async () => { enterSleep(); await new Promise<void>(() => undefined) },
  })
  assert.equal(await scheduler.run("write", async () => "first"), "first")
  let started = false
  const second = scheduler.run("write", async () => { started = true; return "second" }, controller.signal)
  await sleeping
  clock += 60_000
  assert.ok(scheduler.snapshot.oldestPolicySleepOverdueMs >= 59_000)
  controller.abort("test cancellation")
  await assert.rejects(second, /cancel|test cancellation/iu)
  assert.equal(started, false)
  assert.equal(scheduler.snapshot.activePolicySleeps, 0)
  assert.equal(scheduler.snapshot.oldestPolicySleepOverdueMs, 0)
  assert.equal(scheduler.snapshot.maxPolicySleepOvershootMs, 0)
})
