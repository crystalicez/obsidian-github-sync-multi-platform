#!/usr/bin/env node
// D16 opt-in disposable Windows-native proof. Not part of test:fast or release.
// No personal vault, network mount, tokens, GitHub, plugin loader or .exe tracked.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { renameSync, symlinkSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "win32") {
  console.error("D16 Windows-only PoC: SKIPPED on non-Windows")
  process.exit(0)
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch = path.join(repo, ".tmp")
await mkdir(scratch, { recursive: true })
const build = await mkdtemp(path.join(scratch, "d16-native-build-"))
const source = path.join(repo, "poc", "windows-handle-no-follow", "HandleProbe.cs")
const exe = path.join(build, "HandleProbe.exe")
const dotnetCompiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
const bytes = { local: Buffer.from("D16 original controlled file\n"), outside: Buffer.from("D16 external sentinel must not be modified\n") }
const repeatArg = process.argv.find(a=>a.startsWith("--repeat="))
const repeat = repeatArg ? Number(repeatArg.split("=")[1]) : 1
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw Error("D16 repeat must be 1..20")
let runs = []
async function expectGone(file) {
  await assert.rejects(access(file), { code: "ENOENT" })
}
function exitState(child, timeout=20000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => { child.kill(); reject(Error("native helper timed out")) }, timeout)
    child.once("error", e => {clearTimeout(timeoutId); reject(e)})
    child.once("close", (code, signal) => {clearTimeout(timeoutId); resolve({code,signal})})
  })
}
async function scenario(mode, usesJunctionAtStart=false) {
  const root = await mkdtemp(path.join(scratch, "d16-native-root-"))
  const external = await mkdtemp(path.join(scratch, "d16-native-outside-"))
  const notes = path.join(root, "notes")
  const saved = path.join(root, "parked-notes")
  const externalFile = path.join(external, "sentinel.bin")
  const originalFile = path.join(notes, "sentinel.bin")
  await writeFile(path.join(root, ".d16-poc-only"), "only test-generated directories\n")
  await writeFile(externalFile, bytes.outside)
  const childResult = {mode,usesJunctionAtStart}
  let child
  try {
    if (!usesJunctionAtStart) {
      await mkdir(notes)
      await writeFile(originalFile, bytes.local)
    } else {
      symlinkSync(external, notes, "junction")
    }
    child = spawn(exe,[root,mode],{stdio:["pipe","pipe","pipe"],windowsHide:true})
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data",chunk=>{stderr+=chunk})
    const exited=exitState(child)
    const lines=createInterface({input:child.stdout,crlfDelay:Infinity})
    if (!usesJunctionAtStart) {
      const ready=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error("native helper READY timeout")),12000)
        lines.on("line",line=>{if(line==="READY"){clearTimeout(timeout);resolve(true)}})
        child.on("close",()=>{clearTimeout(timeout);reject(Error("helper exited before READY: "+stderr))})
      })
      assert.ok(ready)
      let remainingLocalFile=originalFile
      let expectedRefusal=false
      if(mode==="root-only") {
        renameSync(notes,saved)
        symlinkSync(external,notes,"junction")
        remainingLocalFile=path.join(saved,"sentinel.bin")
        expectedRefusal=true
        childResult.attack="replace-parent-with-junction-before-relative-open"
      } else if(mode==="parent") {
        renameSync(originalFile,path.join(notes,"parked.bin"))
        symlinkSync(externalFile,originalFile,"file")
        remainingLocalFile=path.join(notes,"parked.bin")
        expectedRefusal=true
        childResult.attack="replace-leaf-with-symlink-before-relative-open"
      } else {
        try {
          renameSync(notes,saved)
          symlinkSync(external,notes,"junction")
          remainingLocalFile=path.join(saved,"sentinel.bin")
          childResult.attack="parent-swapped-while-handles-pinned"
        } catch(error) {
          if (!["EPERM","EACCES","EBUSY"].includes(error.code)) throw error
          childResult.parentSwapBlocked=error.code
          try {
            renameSync(originalFile,path.join(notes,"parked.bin"))
            symlinkSync(externalFile,originalFile,"file")
            remainingLocalFile=path.join(notes,"parked.bin")
            childResult.attack="leaf-swapped-while-file-handle-pinned"
          } catch(fileError) {
            if (!["EPERM","EACCES","EBUSY"].includes(fileError.code)) throw fileError
            childResult.leafSwapBlocked=fileError.code
            childResult.attack="Windows-blocked-directory-and-file-swaps-with-handles-open"
          }
        }
      }
      child.stdin.write("GO\n")
      child.stdin.end()
      const done=await exited
      childResult.exit=done.code
      childResult.stderr=stderr.trim()
      assert.deepEqual(await readFile(externalFile),bytes.outside,"outside sentinel changed")
      if(expectedRefusal) {
        assert.notEqual(done.code,0,"reparse-point attack unexpectedly succeeded")
        assert.match(stderr,/reparse|junction|NtCreateFile relative failed/i)
        assert.deepEqual(await readFile(remainingLocalFile),bytes.local)
        childResult.status="PASS:late-reparse-refused"
      } else {
        assert.equal(done.code,0,"native helper failed handle-based delete of fixture")
        await expectGone(remainingLocalFile)
        childResult.status=childResult.parentSwapBlocked && childResult.leafSwapBlocked
          ? "PASS:Windows-prevented-swap-while-handle-pinned"
          : "PASS:pinned-handle-delete-contained"
      }
      assert.equal((await readFile(path.join(root,".d16-poc-only"))).toString().trim(),"only test-generated directories")
    } else {
      const done=await exited
      childResult.exit=done.code
      childResult.stderr=stderr.trim()
      assert.notEqual(done.code,0,"junction should be denied during native relative open")
      assert.match(stderr,/reparse|junction|NtCreateFile relative failed/i)
      assert.deepEqual(await readFile(externalFile),bytes.outside)
      childResult.status="PASS:initial junction refused"
    }
    runs.push(childResult)
  } finally {
    if (child && child.exitCode === null) child.kill()
    // The root and outside are randomly created under the AUDIT worktree only.
    await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100})
    await rm(external,{recursive:true,force:true,maxRetries:4,retryDelay:100})
  }
}
try {
  execFileSync(dotnetCompiler,["/nologo","/target:exe",`/out:${exe}`,source],{cwd:repo,timeout:45000,stdio:"pipe"})
  for (let attempt=0;attempt<repeat;attempt++) {
    await scenario("root-only")
    await scenario("parent")
    await scenario("pinned")
    await scenario("reject-link",true)
  }
  console.log(JSON.stringify({status:"PASS",category:"D16 HANDLE-RELATIVE NATIVE POC ONLY",platform:process.platform,version:os.release(),iterations:repeat,totalScenarios:runs.length,scenarioCounts:Object.fromEntries(["root-only","parent","pinned","reject-link"].map(m=>[m,runs.filter(r=>r.mode===m).length])),sample:runs.slice(0,4),artifactTracked:false,releaseIntegration:false}))
} catch(error) {
  console.error(JSON.stringify({status:"FAIL",category:"D16 HANDLE-RELATIVE NATIVE POC",reason:error.message,stdout:String(error.stdout??"").slice(0,1500),stderr:String(error.stderr??"").slice(0,1500),runs}))
  process.exitCode=1
} finally {
  await rm(build,{recursive:true,force:true,maxRetries:4,retryDelay:100})
}
