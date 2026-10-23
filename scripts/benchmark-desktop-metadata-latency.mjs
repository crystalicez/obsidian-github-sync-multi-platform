#!/usr/bin/env node
// Synthetic disposable filesystem qualification. Simulated delays are NOT SMB/NFS evidence.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import Module from "node:module"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch = path.join(repo, ".tmp")
const fixtureRoot = await mkdtemp(path.join(scratch, "d14-metadata-latency-"))
const originalLstat = fs.lstatSync
const originalRename = fs.renameSync
const sha = value => createHash("sha256").update(value).digest("hex")
const oldBytes = Buffer.from("ORIGINAL note\n")
const newBytes = Buffer.from("verified candidate note\n")
const oldHash = sha(oldBytes)
const newHash = sha(newBytes)
const percentile = (samples, pct) => {
  const sorted = [...samples].sort((a,b)=>a-b)
  return Number(sorted[Math.ceil(sorted.length*pct/100)-1].toFixed(3))
}
const output = []
try {
  const bundled = await esbuild.build({
    entryPoints: [path.join(repo,"src","lib","v4","platform-io.ts")],
    bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
  })
  const filename = path.join(repo,"scripts","d14-platform-io-bundle.cjs")
  const loaded = new Module(filename)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(bundled.outputFiles[0].text, filename)
  assert.equal(typeof loaded.exports.createV4PlatformIo,"function")
  for (const artificialLstatDelayMs of [0, 2, 10]) {
    const root = path.join(fixtureRoot,"latency-"+artificialLstatDelayMs)
    await mkdir(path.join(root,"notes"),{recursive:true})
    await mkdir(path.join(root,"stage"),{recursive:true})
    const io = loaded.exports.createV4PlatformIo({
      platform: "desktop", desktopRootPath: root,
      resolveDesktopPath: logical => path.join(root,logical),
    })
    let lstatCount = 0, renameCount = 0, lstatWallMs = 0, renameWallMs = 0
    fs.lstatSync = function (...args) {
      const start = performance.now()
      const result = originalLstat.apply(this,args)
      if (String(args[0]).startsWith(root + path.sep) && artificialLstatDelayMs) {
        // Spin only in this synthetic experiment: Windows wait timer resolution
        // can round 2 ms and 10 ms sleeps to nearly the same ~16 ms block.
        const until = performance.now() + artificialLstatDelayMs
        while (performance.now() < until) {}
      }
      lstatCount++
      lstatWallMs += performance.now()-start
      return result
    }
    fs.renameSync = function (...args) {
      const start = performance.now()
      try { return originalRename.apply(this,args) }
      finally { renameCount++; renameWallMs += performance.now()-start }
    }
    const histogram = monitorEventLoopDelay({resolution:1})
    histogram.enable()
    const commitMs=[]
    for (let index=0;index<12;index++) {
      const stage = "stage/"+index+".bin"
      const target = "notes/"+index+".md"
      await writeFile(path.join(root,stage),newBytes)
      await writeFile(path.join(root,target),oldBytes)
      const before = await stat(path.join(root,target))
      const options = {
        expectedTarget: {exists:true,size:oldBytes.length,mtime:Math.round(before.mtimeMs),hash:oldHash},
        expectedStageSize:newBytes.length,expectedStageSha256:newHash,
      }
      const start=performance.now()
      await io.commitStage(stage,target,options)
      commitMs.push(performance.now()-start)
      assert.deepEqual(await readFile(path.join(root,target)),newBytes)
      await io.finalizeStage(stage,target,options)
    }
    await new Promise(resolve=>setTimeout(resolve,35))
    histogram.disable()
    output.push({
      device:"isolated local Windows filesystem (not network)", simulatedLstatDelayMs:artificialLstatDelayMs,
      commitCount:commitMs.length,commitP50Ms:percentile(commitMs,50),
      commitP95Ms:percentile(commitMs,95),commitMaxMs:Math.max(...commitMs).toFixed(3),
      lstatCalls:lstatCount,lstatTotalWallMs:Number(lstatWallMs.toFixed(3)),
      renameCalls:renameCount,renameTotalWallMs:Number(renameWallMs.toFixed(3)),
      eventLoopMaxMs:Number((histogram.max/1e6).toFixed(3)),
      eventLoopP99Ms:Number((histogram.percentile(99)/1e6).toFixed(3)),
    })
    fs.lstatSync=originalLstat
    fs.renameSync=originalRename
  }
  console.log(JSON.stringify({kind:"D14 local NTFS / injected metadata-latency qualification",syntheticDelayNotNetwork:true,runBytesPerFile:newBytes.length,results:output}))
} finally {
  fs.lstatSync=originalLstat
  fs.renameSync=originalRename
  await rm(fixtureRoot,{recursive:true,force:true})
}
