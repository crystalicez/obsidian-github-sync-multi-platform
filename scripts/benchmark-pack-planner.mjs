#!/usr/bin/env node
// CPU-only benchmark: 10,000 virtual notes, no vault writes or GitHub requests.
import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bundle = path.join(root, ".tmp", `pack-planner-bench-${process.pid}.mjs`)
const fileCount = 10_000
const candidates = Array.from({ length: fileCount }, (_, index) => ({
  fileId: `f-${index}`,
  path: `Folder/Note-${index}.md`,
  size: 512,
}))

await mkdir(path.dirname(bundle), { recursive: true })
try {
  await build({
    entryPoints: [path.join(root, "src/lib/v4/pack-planner.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  })
  const { planV4PackGroups } = await import(pathToFileURL(bundle).href)
  const timings = []
  for (let run = 0; run < 9; run++) {
    const started = performance.now()
    const groups = planV4PackGroups(candidates)
    const elapsed = performance.now() - started
    assert.equal(groups.length, 20)
    assert.ok(groups.every(group => group.length === 500))
    assert.deepEqual(groups.flat(), candidates)
    timings.push(elapsed)
  }
  const warmRuns = timings.slice(1).sort((left, right) => left - right)
  console.log(JSON.stringify({
    benchmark: "pack-planner",
    fixture: "10,000 in-memory changed notes, 512 bytes each, same folder",
    fileCount,
    runCount: timings.length,
    medianWarmMs: (warmRuns[3] + warmRuns[4]) / 2,
    warmMinMs: warmRuns[0],
    warmMaxMs: warmRuns[warmRuns.length - 1],
    allRunsMs: timings,
    groupedPacks: 20,
  }))
} finally {
  await rm(bundle, { force: true })
}
