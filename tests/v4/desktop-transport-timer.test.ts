import assert from "node:assert/strict"
import test from "node:test"
import { selectV4GitHubSchedulerSleep } from "../../src/lib/v4/desktop-transport-timer"
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler"
import { V4CancelledError } from "../../src/lib/v4/cancellation"

test("mobile selects the original scheduler timer without loading Node timers", () => {
  let usedNodeTimer = false
  const chosen = selectV4GitHubSchedulerSleep(false, () => { usedNodeTimer = true })
  assert.equal(chosen, undefined)
  assert.equal(usedNodeTimer, false)
})

test("desktop scheduler uses Node timer for 1000ms pacing and never starts writes early", async () => {
  let clock = 20_000
  const waits: number[] = []
  const starts: number[] = []
  const sleep = selectV4GitHubSchedulerSleep(true, (onWake, milliseconds) => {
    waits.push(milliseconds)
    clock += milliseconds
    onWake()
  })
  assert.equal(typeof sleep, "function")
  const scheduler = new V4RequestScheduler({
    sleep, now: () => clock, mutationSpacingMs: 1_000, writeConcurrency: 2,
  })
  const results: number[] = []
  for (const i of [0, 1, 2]) {
    results.push(await scheduler.run("write", async () => {
      starts.push(clock)
      return i
    }))
  }
  assert.deepEqual(results, [0, 1, 2])
  assert.deepEqual(starts, [20_000, 21_000, 22_000])
  assert.deepEqual(waits, [1_000, 1_000])
  assert.equal(scheduler.snapshot.maxPolicySleepOvershootMs, 0)
})

test("aborting a waiting desktop write never starts its operation even if the timer fires later", async () => {
  let fireTimer!: () => void
  let waiting!: () => void
  const enteredTimer = new Promise<void>(resolve => { waiting = resolve })
  const sleep = selectV4GitHubSchedulerSleep(true, onWake => {
    fireTimer = onWake
    waiting()
  })
  assert.equal(typeof sleep, "function")
  const scheduler = new V4RequestScheduler({ sleep, writeConcurrency: 1, mutationSpacingMs: 1_000 })
  assert.equal(await scheduler.run("write", async () => "first"), "first")
  let started = false
  const aborted = new AbortController()
  const next = scheduler.run("write", async () => { started = true; return "unexpected" }, aborted.signal)
  await enteredTimer
  aborted.abort("synthetic cancelled")
  await assert.rejects(next, e => e instanceof V4CancelledError)
  assert.equal(started, false)
  assert.equal(scheduler.snapshot.activePolicySleeps, 0)
  fireTimer()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(started, false)
})
