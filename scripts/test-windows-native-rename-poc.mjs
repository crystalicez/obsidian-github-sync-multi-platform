#!/usr/bin/env node
// D17 opt-in Windows-only native rename/recovery crash-cut PoC. NOT plugin-integrated.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "win32") {
  console.log(JSON.stringify({status:"SKIP",reason:"D17 Windows-only native proof"}))
  process.exit(0)
}
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const tmp=path.join(repo,".tmp")
await mkdir(tmp,{recursive:true})
const build=await mkdtemp(path.join(tmp,"d17-native-build-"))
const exe=path.join(build,"RenameProbe.exe")
const src=path.join(repo,"poc","windows-handle-no-follow","RenameProbe.cs")
const compiler="C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
const original=Buffer.from("D17-ORIGINAL-CONTENT\n")
const candidate=Buffer.from("D17-CANDIDATE-CONTENT\n")
const unknown=Buffer.from("D17-UNKNOWN-EDIT\n")
const outsideBytes=Buffer.from("D17-EXTERNAL-DO-NOT-TOUCH\n")
const countArg=process.argv.find(v=>v.startsWith("--repeat="))
const repeat=countArg?Number(countArg.split("=")[1]):1
if(!Number.isSafeInteger(repeat)||repeat<1||repeat>10)throw Error("repeat must be 1..10")
const sha=bytes=>createHash("sha256").update(bytes).digest("hex")
let passes=[]
async function exists(name){try{await access(name);return true}catch(e){if(e.code==="ENOENT")return false;throw e}}
async function equalsFile(name,data){assert.deepEqual(await readFile(name),data,"different content at "+path.basename(name))}
async function absent(name){assert.equal(await exists(name),false,"unexpected file "+path.basename(name))}
function native(root,mode,{cut,changeAtReady,changeAtBackup}={}) {
  const child=spawn(exe,[root,mode],{stdio:["pipe","pipe","pipe"],windowsHide:true})
  let stderr="",lines=[]
  let chain=Promise.resolve(),settled=false
  child.stderr.setEncoding("utf8")
  child.stderr.on("data",s=>stderr+=s)
  const stdout=createInterface({input:child.stdout,crlfDelay:Infinity})
  const finished=new Promise((resolve,reject)=>{
    const watchdog=setTimeout(()=>{child.kill();reject(Error("D17 native timeout"))},20000)
    child.once("error",err=>{clearTimeout(watchdog);reject(err)})
    child.once("close",(code,signal)=>{clearTimeout(watchdog);resolve({code,signal,stderr,lines})})
  })
  stdout.on("line",line=>{
    lines.push(line)
    chain=chain.then(async()=>{
      if(settled)return
      if(line==="READY"&&changeAtReady)await changeAtReady()
      if(line==="CUT:BACKUP"&&changeAtBackup)await changeAtBackup()
      if(line==="CUT:"+cut){settled=true;child.kill();return}
      if(line==="READY"||line.startsWith("CUT:"))child.stdin.write("GO\n")
    }).catch(err=>{settled=true;stderr+=" CONTROLLER:"+err.message;child.kill()})
  })
  return finished.then(async result=>{await chain;return {...result,stderr}})
}
async function scenario(label,work){
  const root=await mkdtemp(path.join(tmp,"d17-native-root-"))
  const outside=await mkdtemp(path.join(tmp,"d17-native-outside-"))
  const notes=path.join(root,"notes")
  await mkdir(notes)
  await writeFile(path.join(root,".d17-poc-only"),"D17 disposable only\n")
  await writeFile(path.join(notes,"original.md"),original)
  await writeFile(path.join(notes,"candidate.stage"),candidate)
  const external=path.join(outside,"sentinel.md")
  await writeFile(external,outsideBytes)
  // Real fsync of the test-only intent file before any mutation, not a
  // simulation of an entire WAL/dir fsync protocol or physical power loss.
  const intentPath=path.join(root,".wal-intent-d17")
  const intent="D17-WAL-INTENT-V1\noriginal="+sha(original)+"\ncandidate="+sha(candidate)+"\n"
  const intentFd=fs.openSync(intentPath,"wx")
  try { fs.writeSync(intentFd,intent);fs.fsyncSync(intentFd) }
  finally { fs.closeSync(intentFd) }
  const x={root,outside,notes,external,intentPath,target:path.join(notes,"original.md"),
    stage:path.join(notes,"candidate.stage"),backup:path.join(notes,"original.backup"),
    residue:path.join(notes,"replacement.residue")}
  try{
    const details=await work(x)
    await equalsFile(external,outsideBytes)
    passes.push({case:label,status:"PASS",...details})
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})
    await rm(outside,{recursive:true,force:true,maxRetries:8,retryDelay:100})
  }
}
const requireNativeOk=r=>assert.equal(r.code,0,"native error "+r.stderr)
const requireNativeFail=r=>assert.notEqual(r.code,0,"unexpected native success")
try {
  execFileSync(compiler,["/nologo","/target:exe","/out:"+exe,src],{cwd:repo,timeout:45000,stdio:"pipe"})
  for(let iteration=0;iteration<repeat;iteration++){
    await scenario("reject-marker-root-outside-compiled-fixture-parent",async p=>{
      const spoof=path.join(p.notes,"d17-native-root-spoof")
      await mkdir(spoof)
      await writeFile(path.join(spoof,".d17-poc-only"),"spoof\n")
      const r=await native(spoof,"rollback-auto")
      assert.equal(r.code,3,"native root confinement must reject same marker outside its audit .tmp parent")
      await equalsFile(p.target,original)
      await equalsFile(p.stage,candidate)
      return {rootConfinement:true}
    })
    await scenario("commit-retains-proof-backup",async p=>{
      const r=await native(p.root,"commit");requireNativeOk(r)
      await equalsFile(p.target,candidate);await equalsFile(p.backup,original);await absent(p.stage)
      return {cuts:r.lines.filter(x=>x.startsWith("CUT:"))}
    })
    for(const cut of ["BACKUP","PUBLISH"]){
      await scenario("crash-after-"+cut.toLowerCase()+"-recover",async p=>{
        const stopped=await native(p.root,"commit",{cut})
        assert.ok(stopped.lines.includes("CUT:"+cut))
        assert.notEqual(stopped.code,0)
        if(cut==="BACKUP"){await absent(p.target);await equalsFile(p.backup,original);await equalsFile(p.stage,candidate)}
        else{await equalsFile(p.target,candidate);await equalsFile(p.backup,original)}
        requireNativeOk(await native(p.root,"rollback-auto"))
        await equalsFile(p.target,original);await absent(p.backup)
        if(cut==="BACKUP"){await equalsFile(p.stage,candidate);await absent(p.residue)}
        else{await absent(p.stage);await equalsFile(p.residue,candidate)}
        return {cut,restored:true}
      })
    }
    await scenario("rollback-complete-preserves-residue",async p=>{
      requireNativeOk(await native(p.root,"commit"))
      const r=await native(p.root,"rollback-steps");requireNativeOk(r)
      await equalsFile(p.target,original);await equalsFile(p.residue,candidate);await absent(p.backup)
      return {cuts:r.lines.filter(x=>x.startsWith("CUT:"))}
    })
    for(const cut of ["PARK","RESTORE"]){
      await scenario("crash-during-rollback-"+cut.toLowerCase(),async p=>{
        requireNativeOk(await native(p.root,"commit"))
        const stopped=await native(p.root,"rollback-steps",{cut})
        assert.ok(stopped.lines.includes("CUT:"+cut))
        requireNativeOk(await native(p.root,"rollback-auto"))
        await equalsFile(p.target,original);await equalsFile(p.residue,candidate);await absent(p.backup)
        return {cut,restored:true}
      })
    }
    await scenario("missing-wal-intent-refuses-recovery",async p=>{
      requireNativeOk(await native(p.root,"commit"))
      await rm(p.intentPath)
      const r=await native(p.root,"rollback-auto")
      requireNativeFail(r)
      assert.match(r.stderr,/WAL|native relative open rejected/)
      await equalsFile(p.target,candidate)
      await equalsFile(p.backup,original)
      return {manualReview:true}
    })
    await scenario("corrupt-wal-intent-refuses-recovery",async p=>{
      requireNativeOk(await native(p.root,"commit"))
      await writeFile(p.intentPath,"D17-WAL-INTENT-V1\noriginal=CORRUPTED\n")
      const r=await native(p.root,"rollback-auto")
      requireNativeFail(r)
      assert.match(r.stderr,/WAL|MANUAL_REVIEW/)
      await equalsFile(p.target,candidate)
      await equalsFile(p.backup,original)
      return {manualReview:true}
    })
    await scenario("stage-modified-after-backup-manual-review",async p=>{
      const r=await native(p.root,"commit",{changeAtBackup:async()=>{await writeFile(p.stage,unknown)}})
      requireNativeFail(r)
      assert.match(r.stderr,/MANUAL_REVIEW/)
      await absent(p.target)
      await equalsFile(p.backup,original)
      await equalsFile(p.stage,unknown)
      const recover=await native(p.root,"rollback-auto")
      requireNativeFail(recover)
      await equalsFile(p.backup,original)
      await equalsFile(p.stage,unknown)
      return {manualReview:true}
    })
    await scenario("changed-backup-manual-review",async p=>{
      requireNativeOk(await native(p.root,"commit"))
      await writeFile(p.backup,unknown)
      const r=await native(p.root,"rollback-auto");requireNativeFail(r)
      assert.match(r.stderr,/MANUAL_REVIEW/)
      await equalsFile(p.target,candidate);await equalsFile(p.backup,unknown)
      await absent(p.residue)
      return {manualReview:true}
    })
    await scenario("parent-rename-while-handles-open",async p=>{
      let blocked=false,dir=p.notes
      const parked=path.join(p.root,"parked-notes")
      const r=await native(p.root,"commit",{changeAtReady:()=>{
        try {
          fs.renameSync(p.notes,parked)
          fs.symlinkSync(p.outside,p.notes,"junction")
          dir=parked
        }catch(e){
          if(!["EPERM","EACCES","EBUSY"].includes(e.code))throw e
          blocked=true
        }
      }})
      requireNativeOk(r)
      await equalsFile(path.join(dir,"original.md"),candidate)
      await equalsFile(path.join(dir,"original.backup"),original)
      return {parentRenameBlocked:blocked,sourcePinned:true}
    })
    await scenario("changed-local-target-manual-review",async p=>{
      requireNativeOk(await native(p.root,"commit"))
      await writeFile(p.target,unknown)
      const r=await native(p.root,"rollback-auto");requireNativeFail(r)
      assert.match(r.stderr,/MANUAL_REVIEW/)
      await equalsFile(p.target,unknown);await equalsFile(p.backup,original);await absent(p.residue)
      return {manualReview:true}
    })
    await scenario("occupied-backup-symlink-refused",async p=>{
      const r=await native(p.root,"commit",{changeAtReady:()=>{
        fs.symlinkSync(p.external,p.backup,"file")
      }})
      requireNativeFail(r)
      await equalsFile(p.target,original);await equalsFile(p.stage,candidate)
      return {refused:true,diagnostic:r.stderr.slice(0,120)}
    })
    await scenario("hardlink-destination-no-replace",async p=>{
      const r=await native(p.root,"commit",{changeAtReady:()=>{
        fs.linkSync(p.external,p.backup)
      }})
      requireNativeFail(r)
      await equalsFile(p.target,original)
      await equalsFile(p.stage,candidate)
      await equalsFile(p.backup,outsideBytes)
      return {outsideHardlinkPreserved:true}
    })
    await scenario("occupied-target-symlink-after-backup-refused",async p=>{
      const r=await native(p.root,"commit",{changeAtBackup:()=>{
        fs.symlinkSync(p.external,p.target,"file")
      }})
      requireNativeFail(r)
      await equalsFile(p.backup,original);await equalsFile(p.stage,candidate)
      const recover=await native(p.root,"rollback-auto");requireNativeFail(recover)
      assert.match(recover.stderr,/reparse|junction|MANUAL_REVIEW/)
      await equalsFile(p.backup,original)
      return {manualReview:true}
    })
    await scenario("pinned-source-renamed-then-symlinked",async p=>{
      const parked=path.join(p.notes,"parked-third-party.md")
      const r=await native(p.root,"commit",{cut:"BACKUP",changeAtReady:()=>{
        fs.renameSync(p.target,parked)
        fs.symlinkSync(p.external,p.target,"file")
      }})
      assert.ok(r.lines.includes("CUT:BACKUP"))
      await equalsFile(p.backup,original);await equalsFile(p.stage,candidate)
      const recover=await native(p.root,"rollback-auto")
      requireNativeFail(recover)
      await equalsFile(p.backup,original)
      return {pinnedSourceStayedLocal:true,reviewRequired:true}
    })
    await scenario("edited-original-before-final-proof-rejected",async p=>{
      const r=await native(p.root,"commit",{changeAtReady:async()=>{await writeFile(p.target,unknown)}})
      requireNativeFail(r);assert.match(r.stderr,/MANUAL_REVIEW/)
      await equalsFile(p.target,unknown);await equalsFile(p.stage,candidate);await absent(p.backup)
      return {manualReview:true}
    })
  }
  console.log(JSON.stringify({status:"PASS",scope:"D17 ISOLATED POC ONLY",iterations:repeat,
    total:passes.length,byCase:Object.fromEntries([...new Set(passes.map(x=>x.case))].map(x=>[x,passes.filter(p=>p.case===x).length])),
    examples:passes.slice(0,4),trackedBinary:false,releaseIntegration:false}))
}catch(e){
  console.error(JSON.stringify({status:"FAIL",reason:e.message,stack:e.stack?.slice(0,1800),
    completed:passes.length,last:passes.slice(-3),nativeCompileStdErr:String(e.stderr??"").slice(0,1500)}))
  process.exitCode=1
}finally{
  await rm(build,{recursive:true,force:true,maxRetries:8,retryDelay:100})
}
