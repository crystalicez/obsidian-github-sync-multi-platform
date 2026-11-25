// Independent real Obsidian peer vault for encrypted remote recovery.
// Only the caller's newly created synthetic run directory can be touched.
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile,mkdir,stat,writeFile} from "node:fs/promises";
import {verifyPngBytes} from "./ui-visual-assertions.mjs";
import path from "node:path";

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function assertSecondVaultRestore(state,expectedContent){
 assert.ok(state && state.status==="success","Second-vault restore status was not successful");
 assert.equal(state.filename,"UI-smoke.md","Second-vault restored an unexpected path or filename");
 assert.equal(state.content,expectedContent,"Second-vault decrypted content mismatch");
 return true;
}
// Observe the actual installed Vault bytes, not a fixture or remote inventory.
export const nativeVaultInventoryExpression = `(async()=>{
 const result=[];
 for(const file of app.vault.getFiles()){
  const bytes=await app.vault.readBinary(file);
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  result.push({path:file.path,size:bytes.byteLength,sha256:[...digest].map(b=>b.toString(16).padStart(2,"0")).join("")});
 }
 return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
})()`;
export async function restoreEncryptedToSecondObsidian({
 exe,runRoot,port,pluginId,sourceRoot,configuration,passphrase,expectedContent,
 expectedFiles=[],absentPaths=[],exercisePeerConflict=false,expectedBinary=null,convergeAfterPeerEdit=null,
}){
 assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,"Second CDP port is unsafe");
 assert.ok(path.basename(runRoot).match(/^[0-9a-f]{16}$/u),"Second vault requires a synthetic random run ID");
 assert.ok(typeof passphrase==="string"&&passphrase.length>=32,"Second vault requires a strong ephemeral test passphrase");
 const vault=path.join(runRoot,"peer-vault");
 const profile=path.join(runRoot,"peer-profile");
 let child,ws,serial=0;
 const pending=new Map();
 try{
  try{
   const exists=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1250)});
   if(exists.ok)throw Error("Second CDP port is in use; refusing to attach to another Obsidian");
  }catch(error){
   if(!/fetch failed|ECONNREFUSED|TimeoutError|timed out/u.test(String(error)))throw error;
  }
  await mkdir(vault);
  await mkdir(profile);
  const pluginPath=path.join(vault,".obsidian","plugins",pluginId);
  await mkdir(pluginPath,{recursive:true});
  for(const file of ["main.js","manifest.json","styles.css"])await copyFile(path.join(sourceRoot,file),path.join(pluginPath,file));
  await writeFile(path.join(vault,".obsidian","community-plugins.json"),JSON.stringify([pluginId])+"\n");
  await writeFile(path.join(profile,"obsidian.json"),JSON.stringify({vaults:{"e9cedd8a741fb12a":{path:vault,ts:Date.now(),open:true}}})+"\n");
  child=spawn(exe,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`],{detached:true,windowsHide:false,stdio:"ignore"});
  child.on("error",()=>{});child.unref();
  let target;
  const until=Date.now()+75000;
  while(Date.now()<until && !target){
   try{
    const res=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)});
    if(res.ok)target=(await res.json()).find(p=>p.type==="page"&&p.url==="app://obsidian.md/index.html"&&p.webSocketDebuggerUrl);
   }catch{}
   if(!target)await pause(300);
  }
  assert.ok(target?.webSocketDebuggerUrl,"Second Obsidian isolated UI never opened");
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error("Second Obsidian CDP connection failed"));});
  ws.onmessage=({data})=>{
   const msg=JSON.parse(String(data));
   if(!msg.id)return;
   const callback=pending.get(msg.id);
   if(!callback)return;
   pending.delete(msg.id);
   if(msg.error)callback.reject(Error("Second Obsidian CDP error"));else callback.resolve(msg.result);
  };
  const send=(method,params={},timeoutMs=25000)=>new Promise((resolve,reject)=>{
   const id=++serial;
   pending.set(id,{resolve,reject});
   ws.send(JSON.stringify({id,method,params}));
   setTimeout(()=>{if(pending.delete(id))reject(Error("Second Obsidian "+method+" timed out"));},timeoutMs).unref();
  });
  const evaluate=async(expression,ms=25000)=>{
   const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},ms);
   if(result.exceptionDetails)throw Error("Second Obsidian rejected evaluated operation");
   return result.result.value;
  };
  await send("Runtime.enable");await send("Page.enable");
  const deadline=Date.now()+55000;
  let identity=null;
  while(Date.now()<deadline&&!identity){
   identity=await evaluate(`(()=>{
     if(typeof app==="undefined"||!app.vault?.adapter?.getBasePath)return null;
     return {base:app.vault.adapter.getBasePath(),name:app.vault.getName()};
   })()`);
   if(!identity)await pause(200);
  }
  assert.equal(identity?.base.toLowerCase(),vault.toLowerCase(),"Second Obsidian vault path does not match synthetic test vault");
  assert.equal(identity.name,path.basename(vault),"Second Obsidian vault name does not match");
  const loaded=await evaluate(`(async()=>{
   const pid=${JSON.stringify(pluginId)};
   if(!app.plugins.isEnabled())await app.plugins.setEnable(true);
   if(!app.plugins.enabledPlugins.has(pid))await app.plugins.enablePluginAndSave(pid);
   await app.plugins.loadPlugin(pid);
   const deadline=Date.now()+15000;
   while(!app.plugins.plugins[pid]&&Date.now()<deadline){
    await new Promise(r=>setTimeout(r,250));
    if(app.plugins.isEnabled()&&app.plugins.manifests[pid]&&!app.plugins.loadingPluginId)await app.plugins.loadPlugin(pid);
   }
   return !!app.plugins.plugins[pid];
  })()`);
  assert.ok(loaded,"Second Obsidian did not load the production plugin");
  const configForPeer={owner:configuration.owner,repo:configuration.repo,
   branch:configuration.branch,token:configuration.token,passphrase};
  const restored=await evaluate(`(async()=>{
   const pid=${JSON.stringify(pluginId)};
   const p=app.plugins.plugins[pid];
   const data=${JSON.stringify(configForPeer)};
   if(p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)
    throw Error("Nonempty second-vault GitHub settings");
   if(app.vault.getAbstractFileByPath("UI-smoke.md"))
    throw Error("Second vault unexpectedly contained the sample note before restore");
   const nextSettings = {...p.settings,
    githubOwner:data.owner,githubRepo:data.repo,githubBranch:data.branch,githubToken:data.token,
    encryptionMode:"encrypted",encryptionPassphrase:data.passphrase,
    syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,
    syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false,
   };
   await p.saveSettings(nextSettings);
   const started=performance.now();
   try{
    await p.v4Runtime.forcePull(false);
   }catch{ return {status:"failed",filename:null,content:null}; }
   const peerPullWallMs=performance.now()-started;
   const s=p.v4Runtime.progressSnapshot;
   const file=app.vault.getAbstractFileByPath("UI-smoke.md");
   if(!file)return {status:s.lifecycle,filename:null,content:null};
   const content=await app.vault.read(file);
   await app.workspace.getLeaf("tab").openFile(file);
   return {status:s.lifecycle,filename:file.path,content,diagnostics:s.diagnostics,peerPullWallMs};
  })()`,expectedBinary?.size>100_000_000?1200000:expectedFiles.length>=1000?900000:300000);
  assertSecondVaultRestore(restored,expectedContent);
  const verifiedFiles=await evaluate(`(async()=>{
   const expected=${JSON.stringify(expectedFiles)};
   const absent=${JSON.stringify(absentPaths)};
   const files=[];
   for(const item of expected){
    const file=app.vault.getAbstractFileByPath(item.path);
    if(!file)throw Error("Peer is missing a synced journey file");
    const content=await app.vault.read(file);
    if(content!==item.content)throw Error("Peer synced journey bytes do not match");
    files.push(item.path);
   }
   for(const path of absent){
    if(app.vault.getAbstractFileByPath(path))throw Error("Peer retains a deleted/renamed original");
   }
   return files;
  })()`);
  assert.equal(verifiedFiles.length,expectedFiles.length,"Second Obsidian journey file count");
  if(expectedBinary){
   assert.ok(Number.isSafeInteger(expectedBinary.size)&&expectedBinary.size>0&&expectedBinary.size<=500*1024*1024,"Native binary fixture must not exceed 500 MiB");
   assert.ok(/^Assets\/[A-Za-z0-9-]+\.bin$/u.test(expectedBinary.path),"Expected native binary must stay inside test Assets");
   const indexed=await evaluate("(()=>{const f=app.vault.getAbstractFileByPath("+JSON.stringify(expectedBinary.path)+");return {size:f?.stat?.size??null};})()");
   assert.equal(indexed.size,expectedBinary.size,"Second Obsidian did not index restored binary file");
   const full=path.join(vault,...expectedBinary.path.split("/"));
   assert.equal((await stat(full)).size,expectedBinary.size);
   const digest=createHash("sha256");
   for await(const chunk of createReadStream(full,{highWaterMark:8*1024*1024}))digest.update(chunk);
   assert.equal(digest.digest("hex"),expectedBinary.sha256,"Native Obsidian peer binary bytes changed after GitHub Force Pull");
  }
  await pause(500);
  const visibleText=expectedContent.trim().split(/\r?\n/u).filter(line=>line.trim()&&!line.startsWith("#")).at(-1);
  assert.ok(visibleText,"Peer expected content must include a visible text line");
  const visible=await evaluate(`(()=>({shown:document.body.innerText.includes(${JSON.stringify(visibleText)}),settingsVisible:!!document.querySelector(".vertical-tab-header")}))()`);
  assert.ok(visible.shown&&!visible.settingsVisible,"Restored synthetic note is not visible in the second Obsidian editor");
  const image=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,fromSurface:true});
  const bytes=Buffer.from(image?.data??"","base64");
  verifyPngBytes(bytes,{minWidth:100,minHeight:100});
  const evidenceDir=path.join(sourceRoot,".tmp","obsidian-live-github-e2e-evidence");
  await mkdir(evidenceDir,{recursive:true});
  const evidencePath=path.join(evidenceDir,path.basename(runRoot)+"-peer-restored.png");
  await writeFile(evidencePath,bytes);
  let peerMutated=false,peerConverged=false,peerOpenEditorGuardVerified=false,peerFinalInventoryCount=0;
  if(exercisePeerConflict){
   const result=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    const file=app.vault.getAbstractFileByPath("UI-smoke.md");
    await app.vault.modify(file,"# Synthetic remote UI E2E\\n\\nPeer conflicting revision.\\n");
    const outcome=await p.v4Runtime.manualSync();
    const s=p.v4Runtime.progressSnapshot;
    return {status:outcome?.status,lifecycle:s.lifecycle,trigger:s.trigger,changedFiles:outcome?.changedFiles,failurePhase:s.failurePhase,apiRequests:s.diagnostics?.apiRequests,apiFailures:s.diagnostics?.apiFailures,error:s.errorMessage?.slice(0,240)};
   })()`,240000);
   assert.ok(result.status==="completed"&&result.lifecycle==="success"&&result.trigger==="manual"&&result.changedFiles>0,"Second real Obsidian peer edit must publish: "+JSON.stringify(result));
   peerMutated=true;
   if(convergeAfterPeerEdit){
    const expected=await convergeAfterPeerEdit();
    // The installed runtime deliberately defers writes to an open note.
    // Prove the real protection and user recovery workflow, not a Force Pull.
    const blocked=await evaluate(`(async()=>{
     const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
     const file=app.vault.getAbstractFileByPath("UI-smoke.md");
     const before=await app.vault.read(file);
     const open=app.workspace.getLeavesOfType("markdown").some(l=>l.view?.file?.path===file.path);
     const outcome=await p.v4Runtime.manualSync();
     const s=p.v4Runtime.progressSnapshot;
     const modal=[...document.querySelectorAll(".modal")].find(m=>m.innerText.includes("Open note needs review"));
     return {status:outcome?.status,lifecycle:s.lifecycle,error:s.errorMessage,open,originalPreserved:(await app.vault.read(file))===before&&before.includes("Peer conflicting revision."),modalVisible:!!modal,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused};
    })()`,240000);
    assert.ok(blocked.open&&blocked.status==="failed"&&blocked.lifecycle==="failed"&&blocked.originalPreserved&&blocked.paused&&blocked.modalVisible&&/open in an Obsidian editor/u.test(blocked.error??""),"Expected real open-editor guard with preserved bytes and recovery guidance: "+JSON.stringify(blocked));
    const closed=await evaluate(`(async()=>{
     const modal=[...document.querySelectorAll(".modal")].find(m=>m.innerText.includes("Open note needs review"));
     const button=[...modal?.querySelectorAll("button")??[]].find(b=>b.textContent.trim()==="Keep files unchanged");
     if(!button)return false;
     button.click();
     for(const leaf of app.workspace.getLeavesOfType("markdown"))if(leaf.view?.file?.path==="UI-smoke.md")leaf.detach();
     return !app.workspace.getLeavesOfType("markdown").some(l=>l.view?.file?.path==="UI-smoke.md");
    })()`);
    assert.equal(closed,true,"Could not close only the saved synthetic editor");
    const caughtUp=await evaluate(`(async()=>{
     const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
     const outcome=await p.v4Runtime.manualSync();
     const s=p.v4Runtime.progressSnapshot;
     return {status:outcome?.status,lifecycle:s.lifecycle,error:s.errorMessage,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused};
    })()`,240000);
    assert.ok(caughtUp.status==="completed"&&["success","no-change"].includes(caughtUp.lifecycle)&&!caughtUp.paused,"Peer normal recovery after closing editor failed: "+JSON.stringify(caughtUp));
    peerOpenEditorGuardVerified=true;
    const actual=await evaluate(nativeVaultInventoryExpression,240000);
    assert.deepEqual(actual,expected,"Final native Vault path/size/SHA-256 inventories differ");
    const noop=await evaluate(`(async()=>{
     const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
     const outcome=await p.v4Runtime.manualSync();
     return {status:outcome?.status,changedFiles:outcome?.changedFiles,lifecycle:p.v4Runtime.progressSnapshot.lifecycle,uploadBytes:p.v4Runtime.progressSnapshot.diagnostics?.uploadBytes};
    })()`,240000);
    assert.deepEqual(noop,{status:"completed",changedFiles:0,lifecycle:"no-change",uploadBytes:0},"Converged peer must be a no-op");
    peerConverged=true;
    peerFinalInventoryCount=actual.length;
   }
  }
  return {peerConverged,peerOpenEditorGuardVerified,peerFinalInventoryCount,peerRestored:true,peerVaultPathMatches:true,filenameMatched:true,bytesRestored:Buffer.byteLength(restored.content,"utf8"),peerScreenshot:evidencePath,verifiedJourneyFiles:verifiedFiles.length,peerMutated,peerDiagnostics:restored.diagnostics,peerPullWallMs:restored.peerPullWallMs};
 }finally{
  if(ws){try{ws.close()}catch{}}
  if(child?.pid){
   const killed=spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{timeout:15000,encoding:"utf8"});
   if(killed.status!==0)throw Error("Second isolated Obsidian process could not be closed");
  }
 }
}
