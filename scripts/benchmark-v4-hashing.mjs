#!/usr/bin/env node
/**
 * Offline performance characterization only. Never changes Sync's SHA-256,
 * part-size policy, crypto, or network behavior. Do not extrapolate Node timings
 * to Obsidian renderer timings without native validation.
 */
import assert from "node:assert/strict"
import { createHash, webcrypto } from "node:crypto"
import { performance } from "node:perf_hooks"
import { build } from "esbuild"

const MAX_BYTES = 100_000_000
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
const DEFAULT_BYTES = 16 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024

export function parseBenchmarkOptions(argv) {
  const defaults = { bytes: DEFAULT_BYTES, chunkBytes: DEFAULT_CHUNK_BYTES, rounds: 5 }
  const values = new Map([
    ["--bytes", ["bytes", MAX_BYTES]],
    ["--chunk-bytes", ["chunkBytes", MAX_CHUNK_BYTES]],
    ["--rounds", ["rounds", 12]],
  ])
  const result = { ...defaults }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const setting = values.get(flag)
    const raw = argv[i + 1]
    if (!setting || !raw || !/^[1-9][0-9]*$/u.test(raw)) {
      throw new Error("Usage: node scripts/benchmark-v4-hashing.mjs [--bytes 1..100000000] [--chunk-bytes 1..8388608] [--rounds 1..12]")
    }
    const number = Number(raw)
    if (!Number.isSafeInteger(number) || number > setting[1]) {
      throw new RangeError(`${flag} exceeds benchmark safety bound`)
    }
    result[setting[0]] = number
  }
  return result
}

function median(numbers) {
  assert.ok(numbers.length > 0)
  const sorted = [...numbers].sort((a, b) => a - b)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2
}

async function loadProductionIncrementalHash() {
  // Bundle exactly the current TypeScript production implementation; do not
  // benchmark a hand-written stand-in, JIT-recompiled copy or alternate SHA.
  const output = await build({
    entryPoints: ["src/lib/v4/incremental-hash.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  assert.equal(output.outputFiles.length, 1)
  const encoded = Buffer.from(output.outputFiles[0].contents).toString("base64")
  return import(`data:text/javascript;base64,${encoded}`)
}

function sampleIncremental(factory, payload, chunkBytes) {
  const observations = []
  const hash = factory(milliseconds => observations.push(milliseconds))
  const before = performance.now()
  for (let start = 0; start < payload.length; start += chunkBytes) {
    hash.update(payload.subarray(start, Math.min(payload.length, start + chunkBytes)))
  }
  const digest = hash.digestHex()
  return {
    digest,
    wallMs: performance.now() - before,
    observedMs: observations.reduce((total, milliseconds) => total + milliseconds, 0),
    calls: observations.length,
  }
}

async function main(argv) {
  // Parse and bound all values before allocating payload bytes or compiling TS.
  const { bytes, chunkBytes, rounds } = parseBenchmarkOptions(argv)
  const { createV4ObservedIncrementalSha256 } = await loadProductionIncrementalHash()
  const payload = new Uint8Array(bytes)
  for (let i = 0; i < payload.length; i++) payload[i] = (Math.imul(i, 31) + 17) & 255

  const expected = createHash("sha256").update(payload).digest("hex")
  const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle
  const incrementalMs = []
  const observedMs = []
  const nativeMs = []
  const webCryptoMs = []
  let peakRss = process.memoryUsage().rss

  // Warmup is excluded; compare independent digests before measuring.
  assert.equal(sampleIncremental(createV4ObservedIncrementalSha256, payload, chunkBytes).digest, expected)
  for (let round = 0; round < rounds; round++) {
    const incremental = sampleIncremental(createV4ObservedIncrementalSha256, payload, chunkBytes)
    assert.equal(incremental.digest, expected, "production incremental hash mismatch")
    assert.equal(incremental.calls, Math.ceil(bytes / chunkBytes) + 1)
    assert.ok(incremental.observedMs >= 0 && incremental.observedMs <= incremental.wallMs + 2)
    incrementalMs.push(incremental.wallMs)
    observedMs.push(incremental.observedMs)

    const beforeNative = performance.now()
    assert.equal(createHash("sha256").update(payload).digest("hex"), expected)
    nativeMs.push(performance.now() - beforeNative)

    const beforeWeb = performance.now()
    const webResult = await subtle.digest("SHA-256", payload)
    assert.equal(Buffer.from(webResult).toString("hex"), expected)
    webCryptoMs.push(performance.now() - beforeWeb)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }

  console.log(JSON.stringify({
    mode: "offline-hash-characterization",
    source: "bundled-production-incremental-hash",
    bytes, chunkBytes, rounds,
    verifiedDigest: expected,
    measure: "individual algorithm samples; not cumulative Obsidian Sync hashingMs",
    node: process.version,
    incremental: { medianWallMs: median(incrementalMs), minWallMs: Math.min(...incrementalMs), maxWallMs: Math.max(...incrementalMs), medianObservedMs: median(observedMs) },
    native: { medianWallMs: median(nativeMs), minWallMs: Math.min(...nativeMs), maxWallMs: Math.max(...nativeMs) },
    webCrypto: { medianWallMs: median(webCryptoMs), minWallMs: Math.min(...webCryptoMs), maxWallMs: Math.max(...webCryptoMs) },
    peakProcessRssBytes: peakRss,
  }))
}

const args = process.argv.slice(2)
main(args).catch(error => { console.error(`Hash benchmark failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
