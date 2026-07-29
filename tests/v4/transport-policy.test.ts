import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_V4_TRANSPORT_POLICY,
  resolveV4RateLimitDelay,
  resolveV4TransportPolicy,
} from "../../src/lib/v4/transport-policy"
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler"

test("transport defaults serialize mutations and keep GitHub spacing as runtime policy", () => {
  assert.equal(DEFAULT_V4_TRANSPORT_POLICY.writeConcurrency, 1)
  assert.equal(DEFAULT_V4_TRANSPORT_POLICY.mutationSpacingMs, 1_000)
  assert.equal(resolveV4TransportPolicy({ mutationSpacingMs: 17 }).mutationSpacingMs, 17)
})

test("rate-limit delay honors retry-after reset and the documented one-minute fallback", () => {
  assert.equal(resolveV4RateLimitDelay({ status: 429, headers: { "retry-after": "2" } }, 1, 10_000), 2_000)
  assert.equal(resolveV4RateLimitDelay({ status: 429, headers: { "retry-after": "3600" } }, 1, 10_000), 3_600_000)
  assert.equal(resolveV4RateLimitDelay({ status: 403, headers: { "x-ratelimit-reset": "20" } }, 1, 10_000), 10_000)
  assert.equal(resolveV4RateLimitDelay({ status: 403, headers: {} }, 1, 10_000), 60_000)
  assert.equal(resolveV4RateLimitDelay({ status: 500 }, 1, 10_000), null)
})

test("request scheduler applies one shared cooldown and mutation pacing", async () => {
  let now = 0
  const sleeps: number[] = []
  const starts: Array<{ kind: string; at: number }> = []
  const scheduler = new V4RequestScheduler({
    readConcurrency: 2,
    writeConcurrency: 1,
    mutationSpacingMs: 1_000,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms },
  })

  await scheduler.run("write", async () => { starts.push({ kind: "write-1", at: now }); return 1 })
  await scheduler.run("write", async () => { starts.push({ kind: "write-2", at: now }); return 2 })
  let attempts = 0
  await scheduler.run("read", async () => {
    starts.push({ kind: `read-${++attempts}`, at: now })
    if (attempts === 1) throw Object.assign(new Error("limited"), { status: 429, headers: { "retry-after": "2" } })
    return 3
  })
  await scheduler.run("write", async () => { starts.push({ kind: "write-3", at: now }); return 4 })

  assert.deepEqual(starts, [
    { kind: "write-1", at: 0 },
    { kind: "write-2", at: 1_000 },
    { kind: "read-1", at: 1_000 },
    { kind: "read-2", at: 3_000 },
    { kind: "write-3", at: 3_000 },
  ])
  assert.deepEqual(sleeps, [1_000, 2_000])
})
