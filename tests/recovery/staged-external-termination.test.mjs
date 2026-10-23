import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { build } from "esbuild"

const root=process.cwd()
const original=Buffer.from([1,2,3,4,5,6])
const replacement=Buffer.from([6,5,4,3,2,1,0])
const preload=path.join(root,"tests","recovery","support","staged-external-terminate-preload.cjs")

async function exists(filename){
 try{await stat(filename);return true}
 catch(e){if(e.code==="ENOENT")return false;throw e}
}

test("D11: external OS termination after each real commit/rollback rename retains provable WAL recovery", {timeout:90000}, async()=>{
 const tmp=path.join(root,".tmp")
 await mkdir(tmp,{recursive:true})
 const fixture=await mkdtemp(path.join(tmp,"native-kill-d11-external-"))
 const bundle=path.join(fixture,"child.cjs")
 try{
  await build({
   entryPoints:[path.join(root,"tests","recovery","support","staged-process-kill-child.ts")],
   outfile:bundle,bundle:true,platform:"node",format:"cjs",target:"node22",logLevel:"silent"
  })
  function fresh(mode,dir){
   const result=spawnSync(process.execPath,[bundle,mode,dir],{
    cwd:root,encoding:"utf8",windowsHide:true,timeout:16000
   })
   if(result.error)throw result.error
   assert.equal(result.status,0,mode+" failed: "+result.stderr)
   return result
  }
  async function terminateAt(mode,dir,cut){
   return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["-r",preload,bundle,mode,dir,String(cut)],{
     cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],
     env:{...process.env,V4_EXTERNAL_KILL_FIXTURE:"strict-disposable"}
    })
    let output="",errors="",sawMarker=false,killSent=false,settled=false
    const timer=setTimeout(()=>{
     child.kill("SIGKILL")
     if(!settled){settled=true;reject(new Error("Timeout waiting for OS kill handshake: "+output+" "+errors))}
    },18000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data",data=>{
     output+=data
     if(!sawMarker && output.includes("EXTERNAL_PAUSE_AFTER_RENAME="+cut)){
      sawMarker=true
      killSent=child.kill("SIGKILL")
     }
    })
    child.stderr.on("data",data=>{errors+=data})
    child.on("error",e=>{
     clearTimeout(timer)
     if(!settled){settled=true;reject(e)}
    })
    child.on("close",(code,signal)=>{
     clearTimeout(timer)
     if(settled)return
     settled=true
     if(!sawMarker||!killSent||(!signal && code===0))
      reject(new Error("Did not externally terminate paused child: "+JSON.stringify({mode,cut,code,signal,output,errors})))
     else resolve({code,signal,output})
    })
   })
  }
  for(const [kind,cut] of [["commit",1],["commit",2],["rollback",1],["rollback",2]]){
   const dir=path.join(fixture,kind+"-"+cut)
   fresh(kind==="commit"?"prepare":"prepare-rollback",dir)
   const killed=await terminateAt(kind==="commit"?"crash":"rollback-crash",dir,cut)
   assert.match(killed.output,new RegExp("EXTERNAL_PAUSE_AFTER_RENAME="+cut))
   assert.equal(await exists(path.join(dir,"wal","slot-1.json")),true)
   const target=path.join(dir,"note.md")
   const backup=path.join(dir,"stage.bin.target-backup")
   const stagedFile=path.join(dir,"stage.bin")
   const residue=path.join(dir,"stage.bin.replacement-residue")
   if(kind==="commit"){
    assert.equal(await exists(backup),true)
    assert.deepEqual(await readFile(backup),original)
    if(cut===1){
     assert.equal(await exists(target),false)
     assert.deepEqual(await readFile(stagedFile),replacement)
     fresh("discard",dir)
     assert.deepEqual(await readFile(target),original)
    }else{
     assert.deepEqual(await readFile(target),replacement)
     assert.equal(await exists(stagedFile),false)
     fresh("resume",dir)
     assert.deepEqual(await readFile(target),replacement)
    }
   }else{
    assert.deepEqual(await readFile(residue),replacement)
    if(cut===1){
     assert.equal(await exists(target),false)
     assert.deepEqual(await readFile(backup),original)
    }else{
     assert.equal(await exists(backup),false)
     assert.deepEqual(await readFile(target),original)
    }
    fresh("discard",dir)
    assert.deepEqual(await readFile(target),original)
   }
   assert.equal(await exists(backup),false)
   assert.equal(await exists(residue),false)
  }
 }finally{
  await rm(fixture,{recursive:true,force:true})
 }
})
