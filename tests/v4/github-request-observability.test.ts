import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"
import { V4RunDiagnostics } from "../../src/lib/v4/run-diagnostics"

test("failed GitHub HTTP request clears the in-flight count without hiding the failure", async () => {
  setRequestUrlHandler(async () => { throw new Error("simulated network disconnect") })
  const diagnostics = new V4RunDiagnostics()
  const client = new GitHubClient({ token: "synthetic", owner: "test", repo: "test", branch: "main" })
  client.setV4RunDiagnostics(diagnostics)
  try {
    await assert.rejects(() => client.listCommits(), /simulated network disconnect/u)
    assert.equal(diagnostics.snapshot.inFlightApiRequests, 0)
    assert.equal(diagnostics.snapshot.oldestInFlightApiMs, 0)
    assert.equal(diagnostics.snapshot.apiRequests, 1)
    assert.equal(diagnostics.snapshot.apiFailures, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("real GitHubClient request instrumentation exposes an unfinished HTTP request and clears it after success", async () => {
  let reply!: (value: unknown) => void
  let notify!: () => void
  const started = new Promise<void>(resolve => { notify = resolve })
  let now = 1_000
  setRequestUrlHandler(async () => {
    notify()
    return new Promise(resolve => { reply = resolve })
  })
  const diagnostics = new V4RunDiagnostics(() => now, () => undefined)
  const client = new GitHubClient({ token: "synthetic", owner: "test", repo: "test", branch: "main" })
  client.setV4RunDiagnostics(diagnostics)
  try {
    const pending = client.listCommits()
    await started
    assert.equal(diagnostics.snapshot.inFlightApiRequests, 1)
    now += 7_000
    assert.equal(diagnostics.snapshot.oldestInFlightApiMs, 7_000)
    reply({ status: 200, headers: {}, text: "", json: [] })
    assert.deepEqual(await pending, [])
    assert.equal(diagnostics.snapshot.inFlightApiRequests, 0)
    assert.equal(diagnostics.snapshot.oldestInFlightApiMs, 0)
    assert.equal(diagnostics.snapshot.apiRequests, 1)
    assert.equal(diagnostics.snapshot.apiFailures, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})
