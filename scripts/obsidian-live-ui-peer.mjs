// Independent real Obsidian peer vault for encrypted remote recovery.
// Only the caller's newly created synthetic run directory can be touched.
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {copyFile,mkdir,writeFile} from "node:fs/promises";
import {verifyPngBytes} from "./ui-visual-assertions.mjs";
import path from "node:path";

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function assertSecondVaultRestore(state,expectedContent){
 assert.ok(state && state.status==="success","Second-vault restore status was not successful");
 assert.equal(state.filename,"UI-smoke.md","Second-vault restored an unexpected path or filename");
 assert.equal(state.content,expectedContent,"Second-vault decrypted content mismatch");
 return true;
}
export async function restoreEncryptedToSecondObsidian({
 exe,runRoot,port,pluginId,sourceRoot,configuration,passphrase,expectedContent,
 expectedFiles=[],absentPaths=[],exercisePeerConflict=false,
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
   await p.saveSettings({...p.settings,
    githubOwner:data.owner,githubRepo:data.repo,githubBranch:data.branch,githubToken:data.token,
    encryptionMode:"encrypted",encryptionPassphrase:data.passphrase,
    syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,
    syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false,
   });
   try{
    await p.v4Runtime.forcePull(false);
   }catch{ return {status:"failed",filename:null,content:null}; }
   const s=p.v4Runtime.progressSnapshot;
   const file=app.vault.getAbstractFileByPath("UI-smoke.md");
   if(!file)return {status:s.lifecycle,filename:null,content:null};
   const content=await app.vault.read(file);
   await app.workspace.getLeaf("tab").openFile(file);
   return {status:s.lifecycle,filename:file.path,content};
  })()`,300000);
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
  await pause(500);
  const visible=await evaluate(`(()=>({shown:document.body.innerText.includes("Second revision from Obsidian."),settingsVisible:!!document.querySelector(".vertical-tab-header")}))()`);
  assert.ok(visible.shown&&!visible.settingsVisible,"Restored synthetic note is not visible in the second Obsidian editor");
  const image=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,fromSurface:true});
  const bytes=Buffer.from(image?.data??"","base64");
  verifyPngBytes(bytes,{minWidth:100,minHeight:100});
  const evidenceDir=path.join(sourceRoot,".tmp","obsidian-live-github-e2e-evidence");
  await mkdir(evidenceDir,{recursive:true});
  const evidencePath=path.join(evidenceDir,path.basename(runRoot)+"-peer-restored.png");
  await writeFile(evidencePath,bytes);
  let peerMutated=false;
  if(exercisePeerConflict){
   const result=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    const file=app.vault.getAbstractFileByPath("UI-smoke.md");
    await app.vault.modify(file,"# Synthetic remote UI E2E\\n\\nPeer conflicting revision.\\n");
    await p.v4Runtime.manualSync();
    return {lifecycle:p.v4Runtime.progressSnapshot.lifecycle};
   })()`,240000);
   assert.equal(result.lifecycle,"success","Second real Obsidian peer edit must publish");
   peerMutated=true;
  }
  return {peerRestored:true,peerVaultPathMatches:true,filenameMatched:true,bytesRestored:Buffer.byteLength(restored.content,"utf8"),peerScreenshot:evidencePath,verifiedJourneyFiles:verifiedFiles.length,peerMutated};
 }finally{
  if(ws){try{ws.close()}catch{}}
  if(child?.pid){
   const killed=spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{timeout:15000,encoding:"utf8"});
   if(killed.status!==0)throw Error("Second isolated Obsidian process could not be closed");
  }
 }
}
