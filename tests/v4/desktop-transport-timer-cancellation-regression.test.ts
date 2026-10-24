import assert from "node:assert/strict"
import test from "node:test"
import { selectV4GitHubSchedulerSleep } from "../../src/lib/v4/desktop-transport-timer"
import { V4CancelledError, sleepV4Abortable } from "../../src/lib/v4/cancellation"

test("cancelling Desktop policy sleep clears its underlying Node timer", async () => {
  const controller = new AbortController()
  let wake!: () => void
  const handle = { id: "pending" }
  const cleared: unknown[] = []
  const sleep = selectV4GitHubSchedulerSleep(
    true,
    callback => { wake = callback; return handle },
    value => { cleared.push(value) },
  )
  assert.ok(sleep)
  const pending = sleepV4Abortable(60_000, controller.signal, sleep)
  controller.abort("discarded sync")
  await assert.rejects(pending, V4CancelledError)
  assert.deepEqual(cleared, [handle])
  wake()
})

test("Desktop timer never starts when the cancellation signal is already aborted", async () => {
  const controller = new AbortController()
  controller.abort("prior shutdown")
  let scheduled = false
  const sleep = selectV4GitHubSchedulerSleep(true, () => { scheduled = true; return 1 }, () => undefined)
  assert.ok(sleep)
  await assert.rejects(sleep(30_000, controller.signal), V4CancelledError)
  assert.equal(scheduled, false)
})

test("Desktop timer completion releases abort listener and does not clear a finished timer", async () => {
  const controller = new AbortController()
  let wake!: () => void
  let clears = 0
  const sleep = selectV4GitHubSchedulerSleep(true, callback => { wake = callback; return 1 }, () => { clears += 1 })
  assert.ok(sleep)
  const pending = sleep(20_000, controller.signal)
  wake()
  await pending
  controller.abort("after completion")
  assert.equal(clears, 0)
})
