import assert from "node:assert/strict"
import test from "node:test"

import { V4RunDiagnostics, formatV4Rate, formatV4Size } from "../../src/lib/v4/run-diagnostics"

test("GitHub API payload throughput excludes scheduler waiting and handles failed requests", () => {
  let clock = 0
  const recorder = new V4RunDiagnostics(() => clock, () => 96 * 1_048_576)
  clock = 200
  recorder.recordRequest({ method: "POST", requestBytes: 2_097_152, responseBytes: 256, elapsedMs: 2_000, failed: false })
  recorder.recordRequest({ method: "GET", requestBytes: 0, responseBytes: 1_048_320, elapsedMs: 500, failed: false })
  recorder.recordRequest({ method: "GET", requestBytes: 0, responseBytes: 0, elapsedMs: 250, failed: true })
  const result = recorder.snapshot
  assert.equal(result.uploadBytes, 2_097_152)
  assert.equal(result.uploadRequestMs, 2_000)
  assert.equal(result.downloadBytes, 1_048_576)
  assert.equal(result.downloadRequestMs, 2_750)
  assert.equal(result.apiRequests, 3)
  assert.equal(result.apiFailures, 1)
  assert.equal(result.apiLatencyMs, 2_750)
  assert.equal(result.apiMaxLatencyMs, 2_000)
  assert.equal(result.peakRendererRssBytes, 100_663_296)
  assert.equal(formatV4Rate(result.uploadBytes, result.uploadRequestMs), "1.00 MiB/s")
  assert.equal(formatV4Rate(result.downloadBytes, result.downloadRequestMs), "0.36 MiB/s")
  assert.equal(formatV4Size(result.downloadBytes), "1.00 MiB")
})

test("hashing, encryption and decryption timings measure only their own work, including rejected operations", async () => {
  let clock = 0
  const recorder = new V4RunDiagnostics(() => clock, () => undefined)
  const hash = recorder.measure("hashing", () => { clock += 4; return "digest" })
  assert.equal(hash, "digest")
  const cipher = await recorder.measureAsync("encryption", async () => { clock += 12; return "cipher" })
  assert.equal(cipher, "cipher")
  await assert.rejects(
    recorder.measureAsync("decryption", async () => { clock += 9; throw new Error("authentication rejected") }),
    /authentication rejected/u,
  )
  recorder.recordWork("hashing", 3)
  assert.deepEqual(recorder.snapshot, {
    uploadBytes: 0, downloadBytes: 0, uploadRequestMs: 0, downloadRequestMs: 0,
    apiRequests: 0, apiFailures: 0, apiLatencyMs: 0, apiMaxLatencyMs: 0,
    inFlightApiRequests: 0, oldestInFlightApiMs: 0,
    hashingMs: 7, encryptionMs: 12, decryptionMs: 9,
  })
  assert.equal(formatV4Rate(0, 1_000), "—")
  assert.equal(formatV4Rate(1_048_576, 0), "—")
})

test("in-flight GitHub request ages update without waiting for a response", () => {
  let clock = 20
  const recorder = new V4RunDiagnostics(() => clock, () => undefined)
  const finishA = recorder.beginRequest()
  clock = 50
  const finishB = recorder.beginRequest()
  clock = 820
  assert.equal(recorder.snapshot.inFlightApiRequests, 2)
  assert.equal(recorder.snapshot.oldestInFlightApiMs, 800)
  finishA()
  assert.equal(recorder.snapshot.inFlightApiRequests, 1)
  assert.equal(recorder.snapshot.oldestInFlightApiMs, 770)
  finishB()
  assert.equal(recorder.snapshot.inFlightApiRequests, 0)
  assert.equal(recorder.snapshot.oldestInFlightApiMs, 0)
  finishB()
  assert.equal(recorder.snapshot.inFlightApiRequests, 0)
})

test("publication diagnostics distinguish metadata preparation, uploaded objects and commit publication without logical paths", () => {
  let clock = 10
  const recorder = new V4RunDiagnostics(() => clock, () => undefined)
  recorder.setPublicationStage("preparing-metadata")
  clock = 310
  assert.equal(recorder.snapshot.publicationStage, "preparing-metadata")
  assert.equal(recorder.snapshot.publicationStageMs, 300)
  assert.equal(recorder.snapshot.metadataTotal, undefined)
  recorder.setPublicationStage("uploading-metadata", 3)
  clock = 540
  recorder.recordMetadataUploaded()
  recorder.recordMetadataUploaded()
  assert.equal(recorder.snapshot.publicationStageMs, 230)
  assert.equal(recorder.snapshot.metadataUploaded, 2)
  assert.equal(recorder.snapshot.metadataTotal, 3)
  recorder.recordMetadataUploaded()
  recorder.setPublicationStage("creating-commit")
  clock = 620
  assert.equal(recorder.snapshot.publicationStageMs, 80)
  assert.equal(recorder.snapshot.metadataUploaded, 3)
  recorder.setPublicationStage("publishing")
  clock = 645
  assert.equal(recorder.snapshot.publicationStageMs, 25)
  assert.equal(recorder.snapshot.publicationStage, "publishing")
})

test("peak RSS is sampled without crashing when RAM probes are unavailable", () => {
  let ram: number | undefined = 128 * 1_048_576
  const recorder = new V4RunDiagnostics(() => 0, () => ram)
  ram = 256 * 1_048_576
  recorder.sampleMemory()
  ram = undefined
  recorder.sampleMemory()
  ram = 160 * 1_048_576
  recorder.sampleMemory()
  assert.equal(recorder.snapshot.peakRendererRssBytes, 256 * 1_048_576)

  const denied = new V4RunDiagnostics(() => 0, () => { throw new Error("mobile not supported") })
  assert.equal(denied.snapshot.peakRendererRssBytes, undefined)
})
