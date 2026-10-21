import assert from "node:assert/strict"
import test from "node:test"
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler"

test("scheduler exposes queued vs active requests while a GitHub write is blocked", async () => {
  let releaseWrite!: () => void
  const blocked = new Promise<void>(resolve => { releaseWrite = resolve })
  const scheduler = new V4RequestScheduler({ writeConcurrency: 1, readConcurrency: 1, mutationSpacingMs: 0 })
  const first = scheduler.run("write", () => blocked.then(() => "first"))
  const second = scheduler.run("write", async () => "second")
  const read = scheduler.run("read", async () => "read")
  assert.equal(scheduler.snapshot.activeWrites, 1)
  assert.equal(scheduler.snapshot.queuedWrites, 1)
  assert.equal(scheduler.snapshot.activeReads, 1)
  assert.equal(scheduler.snapshot.queuedReads, 0)
  assert.equal(await read, "read")
  releaseWrite()
  assert.equal(await first, "first")
  assert.equal(await second, "second")
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(scheduler.snapshot.activeWrites, 0)
  assert.equal(scheduler.snapshot.queuedWrites, 0)
})

test("scheduler reports remaining pacing separately from cooldown", async () => {
  let clock = 100
  const scheduler = new V4RequestScheduler({
    mutationSpacingMs: 1_000,
    now: () => clock,
    sleep: async ms => { clock += ms },
  })
  assert.equal(await scheduler.run("write", async () => "first"), "first")
  assert.equal(scheduler.snapshot.mutationPacingRemainingMs, 1_000)
  assert.equal(scheduler.snapshot.cooldownRemainingMs, 0)
  assert.equal(await scheduler.run("write", async () => "second"), "second")
  assert.equal(clock, 1_100)
})
