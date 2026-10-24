import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import test from "node:test"

const script = resolve(process.cwd(), "scripts/benchmark-v4-hashing.mjs")

function invoke(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  })
}

test("offline hash diagnostic rejects unsafe size, chunk, rounds and unknown flags before allocating", () => {
  for (const args of [
    ["--bytes", "100000001"],
    ["--chunk-bytes", "8388609"],
    ["--rounds", "13"],
    ["--bytes", "0"],
    ["--bytes", "1.5"],
    ["--bytes", "-1"],
    ["--invalid", "17"],
    ["--bytes"],
  ]) {
    const result = invoke(args)
    assert.equal(result.status, 1, `unsafe arguments were accepted: ${args.join(" ")}`)
    assert.match(result.stderr, /safety bound|Usage:/u)
    assert.doesNotMatch(result.stdout, /verifiedDigest/u)
  }
})

test("offline diagnostic uses compiled production SHA and verifies two independent digests", () => {
  const result = invoke(["--bytes", "65537", "--chunk-bytes", "4096", "--rounds", "2"])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(report.mode, "offline-hash-characterization")
  assert.equal(report.source, "bundled-production-incremental-hash")
  assert.equal(report.bytes, 65537)
  assert.equal(report.chunkBytes, 4096)
  assert.equal(report.rounds, 2)
  assert.match(String(report.verifiedDigest), /^[0-9a-f]{64}$/u)
  assert.equal(typeof (report.incremental as Record<string, unknown>).medianObservedMs, "number")
  assert.equal(typeof (report.native as Record<string, unknown>).medianWallMs, "number")
  assert.equal(typeof (report.webCrypto as Record<string, unknown>).medianWallMs, "number")
})
