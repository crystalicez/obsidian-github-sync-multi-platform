import assert from "node:assert/strict"
import test from "node:test"
import { V4TransportMetrics } from "../../src/lib/v4/transport-metrics"
import { createV4RunDiagnostics } from "../../src/lib/v4/run-diagnostics"

test("measured GitHub API timings include overlapping inflight requests and settle on failures", () => {
  let now = 100
  const metrics = new V4TransportMetrics({ now: () => now })
  const first = metrics.recordRequest({ mutation: false, requestBytes: 0 })
  now = 110
  const second = metrics.recordRequest({ mutation: true, requestBytes: 200 })
  now = 125
  assert.equal(metrics.snapshot.inFlightApiRequests, 2)
  assert.equal(metrics.snapshot.oldestInFlightApiMs, 25)
  metrics.recordResponse(200, 80)
  metrics.finishRequest(second)
  now = 140
  metrics.recordNetworkFailure()
  metrics.finishRequest(first)
  const result = metrics.snapshot
  assert.equal(result.apiLatencyMs, 55)
  assert.equal(result.inFlightApiRequests, 0)
  assert.equal(result.oldestInFlightApiMs, 0)
  assert.equal(result.requestBytes, 200)
  assert.equal(result.responseBytes, 80)
  assert.equal(result.statusClasses.network, 1)
})

test("per-run diagnostics subtract old transport counts, report exact observed bytes and do not invent crypto timing", () => {
  let now = 0
  const metrics = new V4TransportMetrics({ now: () => now })
  const oldId = metrics.recordRequest({ mutation: true, requestBytes: 300 })
  now = 40
  metrics.recordResponse(201, 100)
  metrics.finishRequest(oldId)
  const baseline = metrics.snapshot
  const newId = metrics.recordRequest({ mutation: true, requestBytes: 500 })
  now = 140
  metrics.recordResponse(200, 250)
  metrics.finishRequest(newId)
  const report = createV4RunDiagnostics(baseline, metrics.snapshot, 1000, 123_456)
  assert.equal(report.apiRequests, 1)
  assert.equal(report.uploadBytes, 500)
  assert.equal(report.downloadBytes, 250)
  assert.equal(report.apiLatencyMs, 100)
  assert.equal(report.peakRendererRssBytes, 123_456)
  assert.equal(report.inFlightApiRequests, 0)
  assert.equal(report.hashingMs, undefined)
  assert.equal(report.encryptionMs, undefined)
  assert.equal(report.decryptionMs, undefined)
  const measured = createV4RunDiagnostics(baseline, metrics.snapshot, 1000, 123_456, 12.5)
  assert.equal(measured.decryptionMs, 12.5)
  assert.equal(measured.hashingMs, undefined)
  assert.equal(measured.encryptionMs, undefined)
  const realCrypto = createV4RunDiagnostics(baseline, metrics.snapshot, 1000, 123_456, 12.5, 7.25, 4.5)
  assert.equal(realCrypto.decryptionMs, 12.5)
  assert.equal(realCrypto.encryptionMs, 7.25)
  assert.equal(realCrypto.hashingMs, 4.5)
  assert.equal(realCrypto.apiRequests, report.apiRequests)
})
