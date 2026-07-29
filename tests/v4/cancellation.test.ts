import test from "node:test"
import assert from "node:assert/strict"
import {
  V4CancelledError,
  deferV4Cancellation,
  sleepV4Abortable,
  throwIfV4Aborted,
} from "../../src/lib/v4/cancellation"
import { createV4ResourceController, DEFAULT_V4_RESOURCE_LIMITS } from "../../src/lib/v4/resource-controller"
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler"

test("v4 cancellation exposes one typed error and preserves abort reason", () => {
  const controller = new AbortController()
  controller.abort("unload")
  assert.throws(() => throwIfV4Aborted(controller.signal), (error: unknown) => {
    assert.ok(error instanceof V4CancelledError)
    assert.equal(error.reason, "unload")
    return true
  })
})

test("v4 deferred cancellation lets a critical section finish before surfacing abort", async () => {
  const controller = new AbortController()
  const events: string[] = []
  await assert.rejects(
    deferV4Cancellation(controller.signal, async () => {
      events.push("critical-start")
      controller.abort("dispose")
      events.push("critical-finish")
    }),
    V4CancelledError,
  )
  assert.deepEqual(events, ["critical-start", "critical-finish"])
})

test("v4 abortable sleep stops pacing waits without running later work", async () => {
  const controller = new AbortController()
  let release!: () => void
  const sleeping = sleepV4Abortable(1_000, controller.signal, () => new Promise<void>(resolve => { release = resolve }))
  controller.abort("cancel pacing")
  await assert.rejects(sleeping, V4CancelledError)
  release()
})

test("v4 resource reservations reject a queued waiter on cancellation and keep capacity usable", async () => {
  const resources = createV4ResourceController({ ...DEFAULT_V4_RESOURCE_LIMITS, maxResidentBytes: 4 })
  const release = await resources.reserveResidentBytes(4)
  const controller = new AbortController()
  const queued = resources.reserveResidentBytes(1, controller.signal)
  controller.abort("cancel reservation")
  await assert.rejects(queued, V4CancelledError)
  release()
  const nextRelease = await resources.reserveResidentBytes(4)
  nextRelease()
})

test("v4 request scheduler cancels queued work before it starts", async () => {
  let release!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  const scheduler = new V4RequestScheduler({ readConcurrency: 1, writeConcurrency: 1, mutationSpacingMs: 0 })
  const first = scheduler.run("read", async () => { await blocker; return 1 })
  const controller = new AbortController()
  let started = false
  const second = scheduler.run("read", async () => { started = true; return 2 }, controller.signal)
  controller.abort("cancel queued request")
  await assert.rejects(second, V4CancelledError)
  assert.equal(started, false)
  release()
  assert.equal(await first, 1)
})
