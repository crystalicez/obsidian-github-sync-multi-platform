import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { createV4IncrementalSha256 } from "../../src/lib/v4/incremental-hash"
import { V4_PART_BYTES } from "../../src/lib/v4/large-files"

const MiB = 1024 * 1024
const GiB = 1024 * MiB

function sizesFromEnvironment(): number[] {
  const explicit = process.env.V4_SOAK_BYTES
  if (explicit) return explicit.split(",").map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0)
  return [2 * GiB, 5 * GiB]
}

async function hashGeneratedStream(logicalBytes: number, chunkBytes: number) {
  const reusable = new Uint8Array(chunkBytes)
  for (let index = 0; index < reusable.length; index++) reusable[index] = (index * 31 + 17) & 0xff
  const v4 = createV4IncrementalSha256()
  const node = createHash("sha256")
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  let processed = 0
  let chunks = 0
  while (processed < logicalBytes) {
    const wanted = Math.min(chunkBytes, logicalBytes - processed)
    const chunk = wanted === reusable.byteLength ? reusable : reusable.subarray(0, wanted)
    v4.update(chunk)
    node.update(chunk)
    processed += wanted
    chunks++
    if ((chunks & 31) === 0 || processed === logicalBytes) peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  return {
    processed,
    chunks,
    digest: v4.digestHex(),
    referenceDigest: node.digest("hex"),
    peakRssDelta: Math.max(0, peakRss - baselineRss),
    partCount: Math.ceil(logicalBytes / V4_PART_BYTES),
  }
}

for (const logicalBytes of sizesFromEnvironment()) {
  test(`full cryptographic virtual stream stays bounded for ${logicalBytes} bytes`, { skip: process.env.V4_RUN_SOAK !== "1" }, async () => {
    const chunkBytes = Number(process.env.V4_SOAK_CHUNK_BYTES ?? 8 * MiB)
    assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= 32 * MiB)
    const result = await hashGeneratedStream(logicalBytes, chunkBytes)
    assert.equal(result.processed, logicalBytes)
    assert.equal(result.digest, result.referenceDigest)
    assert.equal(result.partCount, Math.ceil(logicalBytes / V4_PART_BYTES))
    const allowedRssDelta = Number(process.env.V4_SOAK_MAX_RSS_DELTA ?? 512 * MiB)
    assert.ok(result.peakRssDelta <= allowedRssDelta, `RSS delta ${result.peakRssDelta} exceeded ${allowedRssDelta}`)
    console.log(JSON.stringify({ logicalBytes, chunkBytes, ...result }))
  })
}
