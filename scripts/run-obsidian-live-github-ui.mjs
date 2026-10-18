#!/usr/bin/env node
// Live Obsidian UI + GitHub roundtrip. Dedicated disposable GitHub repo only.
// Never reuse a vault, CDP port or remote branch. All screenshot content synthetic.
// Requires an EXPLICIT, pinned GITHUB_E2E_EXPECTED_REPO_ID (do not infer at runtime).
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {copyFile,mkdir,open,stat,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {loadGitHubE2EEnv,qualificationE2EBranch,validateGitHubE2EConfig} from "./github-e2e-env.mjs";
import {preflightE2ERemote,readE2EBranch,cleanupE2EBranch} from "./github-e2e-remote.mjs";
import {CANONICAL_REPOSITORY_ID,readOriginFetchRepository} from "./github-repo.mjs";
import {verifyPngBytes,visibleIntersection} from "./ui-visual-assertions.mjs";
import {parseLiveUiMode,assertEncryptedRemoteTree} from "./obsidian-live-ui-mode.mjs";
import {cleanupGeneratedUiRun} from "./obsidian-live-ui-cleanup.mjs";
import {restoreEncryptedToSecondObsidian} from "./obsidian-live-ui-peer.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const opts=process.argv.slice(2);
const option=(key,def)=>opts.find(x=>x.startsWith(`--${key}=`))?.slice(key.length+3)??def;
const exe=option("obsidian","C:\\Program Files\\Obsidian\\Obsidian.exe");
const dryRun=opts.includes("--preflight-only");
const mode=parseLiveUiMode(option("mode",undefined));
const verifyPeer=opts.includes("--verify-peer");
const journey=opts.includes("--journey");
const native100mb=opts.includes("--native-100mb");
assert.ok(!native100mb||(mode==="encrypted"&&verifyPeer),"Native 100 MB test requires encrypted mode and a second real Obsidian vault");
assert.ok(!verifyPeer||mode==="encrypted","A second-vault restore requires --mode=encrypted");
const passphrase=mode==="encrypted"?randomBytes(32).toString("base64url"):"";
const id="encrypted-github-sync-multi-platform";
const runId=randomBytes(8).toString("hex");
const runRoot=path.join(root,".tmp","obsidian-live-github-e2e",runId);
const vault=path.join(runRoot,"vault");
const profile=path.join(runRoot,"profile");
const screenshot=path.join(root,".tmp","obsidian-live-github-e2e-evidence",runId+"-sync-center.png");
const port=Number(option("port",String(20000+process.pid%35000)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assertTrue=(condition,message)=>assert.ok(condition,message);
const readState=async({owner,repo,branch,token})=>readE2EBranch({owner,repo,branch,token});
async function githubReadJson(route){
 const url=`https://api.github.com/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/${route}`;
 const response=await fetch(url,{headers:{Authorization:`Bearer ${configuration.token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(`Encrypted remote read returned GitHub HTTP ${response.status}`);
 return response.json();
}
async function verifyEncryptedGitHubTree(commitSha){
 const commit=await githubReadJson(`git/commits/${commitSha}`);
 assertTrue(/^[0-9a-f]{40}$/u.test(commit?.tree?.sha??""),"Encrypted commit has no valid Git tree");
 const data=await githubReadJson(`git/trees/${commit.tree.sha}?recursive=1`);
 assertTrue(data?.truncated===false,"Encrypted Git tree is truncated");
 const inspected=assertEncryptedRemoteTree(data.tree,{logicalPaths:["UI-smoke.md"]});
 const configNode=data.tree.find(node=>node.path===".obsidian-github-sync-v4/config.json"&&node.type==="blob");
 const cipherNode=data.tree.find(node=>/^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(node.path)&&node.type==="blob");
 assertTrue(!!configNode?.sha&&!!cipherNode?.sha,"Encrypted config or ciphertext blob missing");
 const configBlob=await githubReadJson(`git/blobs/${configNode.sha}`);
 const configJson=JSON.parse(Buffer.from(configBlob.content.replace(/\s/gu,""),"base64").toString("utf8"));
 assertTrue(configJson.mode==="encrypted"&&configJson.pathLayout==="opaque-stable-v1"&&configJson.algorithm==="AES-GCM","Remote encrypted metadata is not V4 opaque AES-GCM");
 const cipherBlob=await githubReadJson(`git/blobs/${cipherNode.sha}`);
 const bytes=Buffer.from(cipherBlob.content.replace(/\s/gu,""),"base64");
 assertTrue(bytes.length>=33&&bytes.subarray(0,4).equals(Buffer.from([0x4f,0x47,0x53,0x34])),"Remote ciphertext does not carry authenticated encrypted payload header");
 assertTrue(!bytes.includes(Buffer.from("Second revision from Obsidian")),"Remote ciphertext exposes synthetic note content");
 return {mode:"encrypted",opaqueObjects:true,cipherHeaderValid:true,configValid:true,...inspected};
}
const runGit=(args)=>spawnSync("git",args,{cwd:root,encoding:"utf8",shell:false});
const redact=(value)=>{
 let msg=String(value?.message||value);
 for(const secret of [configuration?.token,passphrase].filter(Boolean))msg=msg.replaceAll(secret,"[redacted]");
 return msg.replace(/gh[pousr]_[A-Za-z0-9_]+/gu,"[redacted]").replace(/github_pat_[A-Za-z0-9_]+/gu,"[redacted]").slice(0,550);
};
let processHandle,ws,configuration,branch,verified=false,passed=false,initialSha,finalSha;
let cleanupState="not-started",screenBytes=0,remoteEncryptionVerified=false,peerRestored=false,peerScreenshot=null;
const sendErrors=[];
const journeySteps=[];
let nativeBinary=null;
const requestMap=new Map();let serial=0;
function send(method,params={},timeoutMs=25000){
 return new Promise((resolve,reject)=>{
  const cid=++serial;
  requestMap.set(cid,{resolve,reject});
  ws.send(JSON.stringify({id:cid,method,params}));
  setTimeout(()=>{if(requestMap.delete(cid))reject(Error("CDP command timed out: "+method));},timeoutMs).unref();
 });
}
async function evaluate(expression,timeoutMs=25000){
 const v=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},timeoutMs);
 if(v.exceptionDetails)throw Error("Obsidian UI evaluation failed: "+String(v.exceptionDetails.exception?.description||v.exceptionDetails.text).slice(0,240));
 return v.result.value;
}
async function waitApp(timeoutMs=65000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  try{
   const r=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)});
   const list=await r.json();const t=list.find(x=>x.type==="page"&&x.url==="app://obsidian.md/index.html"&&x.webSocketDebuggerUrl);
   if(t)return t;
  }catch{}
  await sleep(350);
 }
 throw Error("Isolated Obsidian window did not load");
}
async function waitUntil(predicate,ms,label){
 const stop=Date.now()+ms;
 while(Date.now()<stop){const v=await predicate();if(v)return v;await sleep(320);}
 throw Error("Timed out: "+label);
}
async function captureSyncedCenter(){
 const dims=await evaluate(`(()=>{
  const el=document.querySelector(".github-sync-center");
  if(!el)return null;const b=el.getBoundingClientRect();
  return {rect:{x:b.x,y:b.y,width:b.width,height:b.height},viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,
    title:document.querySelector(".github-sync-center__header h3")?.textContent,
    lifecycle:app.plugins.plugins[${JSON.stringify(id)}].v4Runtime.progressSnapshot.lifecycle,
    syncAction:!![...el.querySelectorAll("button")].find(b=>b.textContent.trim()==="Sync now"),
    leakedToken:el.innerText.includes(app.plugins.plugins["encrypted-github-sync-multi-platform"].settings.githubToken),
    leakedPassphrase:!!app.plugins.plugins["encrypted-github-sync-multi-platform"].settings.encryptionPassphrase&&el.innerText.includes(app.plugins.plugins["encrypted-github-sync-multi-platform"].settings.encryptionPassphrase)};
 })()`);
 assertTrue(dims?.syncAction && dims?.lifecycle==="success" && !dims?.leakedToken && !dims?.leakedPassphrase,"Sync Center must show a completed sync without leaking credentials");
 const clip=visibleIntersection(dims.rect,dims.viewport);
 const png=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,fromSurface:true,clip});
 const bytes=Buffer.from(png.data??"","base64");
 const size=verifyPngBytes(bytes);
 assertTrue(Math.abs(size.width-clip.width*dims.dpr)<4 && Math.abs(size.height-clip.height*dims.dpr)<4,"Screenshot crop mismatch");
 await mkdir(path.dirname(screenshot),{recursive:true});
 await writeFile(screenshot,bytes);
 screenBytes=bytes.byteLength;
 return {width:size.width,height:size.height,bytes:screenBytes};
}
try{
 assertTrue(Number.isInteger(port)&&port>=1024&&port<=(verifyPeer?65534:65535),"Safe CDP port required");
 const sha=runGit(["rev-parse","HEAD"]);
 assertTrue(sha.status===0&&/^[0-9a-f]{40}$/u.test(sha.stdout.trim()),"Valid pinned source SHA required");
 const status=runGit(["status","--porcelain"]);
 assertTrue(status.status===0&&status.stdout.trim()==="","Live UI roundtrip requires a clean source checkout");
 const source=readOriginFetchRepository({runner:(cmd,args,opt)=>spawnSync(cmd,args,{...opt,shell:false}),cwd:root});
 const env=(await loadGitHubE2EEnv({cwd:root,env:process.env})).env;
 assertTrue(env.GITHUB_E2E_EXPECTED_REPO_ID,"Pinned expected repository ID is required");
 branch=qualificationE2EBranch(sha.stdout.trim(),runId);
 configuration=validateGitHubE2EConfig({owner:env.GITHUB_E2E_OWNER,repo:env.GITHUB_E2E_REPO,
  token:env.GITHUB_E2E_TOKEN,branch,expectedRepoId:env.GITHUB_E2E_EXPECTED_REPO_ID,currentSourceRepo:source});
 assertTrue(configuration.expectedRepoId!==CANONICAL_REPOSITORY_ID,"Target ID equals source ID");
 const verifiedTarget=await preflightE2ERemote({config:{...configuration,currentSourceRepoId:CANONICAL_REPOSITORY_ID}});
 verified=true;
 const before=await readState(configuration);
 assertTrue(before.kind==="absent","Randomized test branch unexpectedly exists");
 console.log(JSON.stringify({preflight:"PASSED",target:configuration.targetRepository,expectedRepoId:configuration.expectedRepoId,
  defaultBranch:verifiedTarget.defaultBranch,disposableBranch:branch,branchBefore:"absent",sourceSHA:sha.stdout.trim(),mode}));
 if(dryRun){passed=true;}else{
  try{
   const existing=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1200)});
   if(existing.ok)throw Error("CDP port already occupied: refusing to attach to other Obsidian instance");
  }catch(e){if(!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(e)))throw e;}
  await mkdir(path.dirname(runRoot),{recursive:true});
  await mkdir(runRoot);await mkdir(vault);await mkdir(profile);
  await mkdir(path.join(vault,".obsidian","plugins",id),{recursive:true});
  for(const file of ["main.js","manifest.json","styles.css"])await copyFile(path.join(root,file),path.join(vault,".obsidian","plugins",id,file));
  await writeFile(path.join(vault,".obsidian","community-plugins.json"),JSON.stringify([id])+"\n");
  await writeFile(path.join(vault,"UI-smoke.md"),"# Synthetic remote UI E2E\n\nFirst revision.\n");
  await writeFile(path.join(profile,"obsidian.json"),JSON.stringify({vaults:{"da9d8e727d6c1aba":{path:vault,ts:Date.now(),open:true}}})+"\n");
  processHandle=spawn(exe,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`],{detached:true,windowsHide:false,stdio:"ignore"});
  processHandle.on("error",()=>{});
  processHandle.unref();
  const target=await waitApp();
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error("Isolated CDP attach failed"));});
  ws.onmessage=({data})=>{
   const msg=JSON.parse(String(data));
   if(msg.method==="Runtime.exceptionThrown")sendErrors.push("Uncaught UI exception");
   if(!msg.id)return;const waiter=requestMap.get(msg.id);if(!waiter)return;
   requestMap.delete(msg.id);
   if(msg.error)waiter.reject(Error(String(msg.error.message).slice(0,200)));else waiter.resolve(msg.result);
  };
  await send("Runtime.enable");await send("Page.enable");
  const identity=await waitUntil(()=>evaluate(`(()=>{
   if(typeof app==="undefined"||!app.vault?.adapter?.getBasePath)return null;
   return {base:app.vault.adapter.getBasePath(),name:app.vault.getName()};
  })()`),45000,"isolated Obsidian vault API");
  assertTrue(identity.base.toLowerCase()===vault.toLowerCase()&&identity.name===path.basename(vault),
   "Refusing live GitHub credentials: Obsidian vault is not the new synthetic vault");
  const loaded=await evaluate(`(async()=>{
   const pid=${JSON.stringify(id)};
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
  assertTrue(loaded,"Production plugin did not load in synthetic Obsidian vault");
  // Credential does not enter stdout, screenshot, console or a tracked file.
  // The vault/profile are securely disposed after the isolated process exits.
  const prepared={
   owner:configuration.owner,repo:configuration.repo,branch:configuration.branch,token:configuration.token,mode,passphrase
  };
  const setup=await evaluate(`(async()=>{
   const p=app.plugins.plugins[${JSON.stringify(id)}];
   const before={configured:!!(p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)};
   if(before.configured)throw Error("Isolated vault was already configured");
   const data=${JSON.stringify(prepared)};
   await p.saveSettings({...p.settings,
     githubOwner:data.owner,githubRepo:data.repo,githubBranch:data.branch,githubToken:data.token,
     syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,
     encryptionMode:data.mode,encryptionPassphrase:data.passphrase,syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false,
   });
   return {configured:p.settings.githubOwner===data.owner&&p.settings.githubRepo===data.repo
     &&p.settings.githubBranch===data.branch && !!p.settings.githubToken,
     mode:p.settings.encryptionMode,passphrasePresent:!!p.settings.encryptionPassphrase,autoEnabled:p.settings.syncOnLocalChange};
  })()`);
  assertTrue(setup?.configured&&setup?.mode===mode&&setup.passphrasePresent===(mode==="encrypted")&&!setup?.autoEnabled,"GitHub credentials not safely installed");
  // First initialization via plugin runtime on an absent, random test branch.
  // Then test the *actual Sync Center button* for the next mutation.
  const initial=await evaluate(`(async()=>{
   const p=app.plugins.plugins[${JSON.stringify(id)}];
   try{
    const value=await p.v4Runtime.forcePush(false);
    return {ok:true,status:value?.status??null,lifecycle:p.v4Runtime.progressSnapshot.lifecycle,phase:p.v4Runtime.progressSnapshot.failurePhase??null,error:p.v4Runtime.progressSnapshot.errorMessage?.slice(0,180)??null};
   }catch(err){return {ok:false,error:String(err?.message||err).slice(0,210),lifecycle:p.v4Runtime.progressSnapshot.lifecycle};}
  })()`,240000);
  assertTrue(initial.ok&&["success","no-change"].includes(initial.lifecycle),"Initial synthetic branch forcePush failed: "+JSON.stringify(initial));
  const initRemote=await readState(configuration);
  assertTrue(initRemote.kind==="present","Initial Force Push did not create random remote branch");
  initialSha=initRemote.sha;
  const updated=await evaluate(`(async()=>{
   const note=app.vault.getAbstractFileByPath("UI-smoke.md");
   if(!note)throw Error("Synthetic note missing");
   await app.vault.modify(note,"# Synthetic remote UI E2E\\n\\nSecond revision from Obsidian.\\n");
   await app.plugins.plugins[${JSON.stringify(id)}].openSyncCenter();
   await new Promise(r=>setTimeout(r,500));
   const button=[...document.querySelectorAll(".github-sync-center__actions button")].find(e=>e.textContent.trim()==="Sync now");
   if(!button)throw Error("Sync Center action missing");
   button.click();
   return {clicked:true};
  })()`);
  assertTrue(updated.clicked,"Actual Sync Center button was not clicked");
  const end=await waitUntil(()=>evaluate(`(()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const s=p.v4Runtime.progressSnapshot;
    if(s.lifecycle==="success"||s.lifecycle==="no-change"||s.lifecycle==="failed")
      return {lifecycle:s.lifecycle,operation:s.operation,trigger:s.trigger,error:s.errorMessage?.slice(0,160)};
    return null;
  })()`),180000,"manual GitHub sync from actual Obsidian UI");
  assertTrue(end.lifecycle==="success"&&end.trigger==="manual","UI Sync now did not succeed: "+JSON.stringify(end));
  const remote=await readState(configuration);
  assertTrue(remote.kind==="present"&&remote.sha!==initialSha,"Remote HEAD did not advance after UI Sync now");
  finalSha=remote.sha;
  if(mode==="encrypted"){
   const encryptionProof=await verifyEncryptedGitHubTree(remote.sha);
   remoteEncryptionVerified=Boolean(encryptionProof.configValid&&encryptionProof.cipherHeaderValid&&encryptionProof.opaqueObjects);
  }
  await captureSyncedCenter();
  const expectedPeerFiles=[
   {path:"Notes/renamed-สวัสดี 🌏.md",content:"# Native combined test\n\nEdited after rename.\n"},
   {path:"Scratch.md",content:"Recreated after deletion.\n"},
  ];
  if(journey){
   const original="Notes/สวัสดี 🌏.md";
   const renamed=expectedPeerFiles[0].path;
   const pluginExpr="app.plugins.plugins["+JSON.stringify(id)+"]";
   const step=async(label,mutation)=>{
    const before=finalSha;
    const result=await evaluate(mutation,120000);
    assertTrue(result?.ok,"Native combined action failed: "+label+" "+JSON.stringify(result));
    const outcome=await evaluate("(async()=>{const p="+pluginExpr+";await p.v4Runtime.manualSync();return {lifecycle:p.v4Runtime.progressSnapshot.lifecycle,trigger:p.v4Runtime.progressSnapshot.trigger};})()",240000);
    assertTrue(outcome.lifecycle==="success"&&outcome.trigger==="manual","Native combined sync failed: "+label+" "+JSON.stringify(outcome));
    const remote=await readState(configuration);
    assertTrue(remote.kind==="present"&&remote.sha!==before,"Combined user action was not published: "+label);
    finalSha=remote.sha;
    journeySteps.push(label);
   };
   await step("create nested Unicode and scratch notes",
    "(async()=>{await app.vault.createFolder('Notes');await app.vault.create("+JSON.stringify(original)+",'# Native combined test\\n\\nInitial Unicode name.\\n');await app.vault.create('Scratch.md','Temporary note.\\n');return {ok:true};})()");
   await step("rename, modify, and delete together",
    "(async()=>{const file=app.vault.getAbstractFileByPath("+JSON.stringify(original)+");const scratch=app.vault.getAbstractFileByPath('Scratch.md');if(!file||!scratch)return {ok:false};await app.vault.rename(file,"+JSON.stringify(renamed)+");await app.vault.modify(file,"+JSON.stringify(expectedPeerFiles[0].content)+");await app.vault.delete(scratch);return {ok:true};})()");
   await step("recreate deleted note",
    "(async()=>{if(app.vault.getAbstractFileByPath('Scratch.md'))return {ok:false};await app.vault.create('Scratch.md',"+JSON.stringify(expectedPeerFiles[1].content)+");return {ok:true};})()");
   const checked=await evaluate("(async()=>{const expected="+JSON.stringify(expectedPeerFiles)+";for(const entry of expected){const file=app.vault.getAbstractFileByPath(entry.path);if(!file||(await app.vault.read(file))!==entry.content)return {ok:false};}return {ok:!app.vault.getAbstractFileByPath("+JSON.stringify(original)+")};})()");
   assertTrue(checked?.ok,"Native source files diverged after combined changes");
  }
  if(native100mb){
   const name="Assets/payload-100mb.bin";
   const size=100_000_000;
   const before=finalSha;
   await evaluate("(async()=>{await app.vault.createFolder('Assets');return true;})()");
   const full=path.join(vault,"Assets","payload-100mb.bin");
   const block=Buffer.allocUnsafe(8*1024*1024);
   for(let i=0;i<block.length;i++)block[i]=(i*31+17)&255;
   const checksum=createHash("sha256");
   const handle=await open(full,"wx");
   let written=0;
   try{
    while(written<size){
     const wanted=Math.min(block.length,size-written);
     const next=await handle.write(block,0,wanted,written);
     assertTrue(next.bytesWritten>0,"Native 100 MB fixture write did not advance");
     checksum.update(block.subarray(0,next.bytesWritten));
     written+=next.bytesWritten;
    }
   }finally{await handle.close();}
   assertTrue((await stat(full)).size===size,"Native 100 MB fixture size changed");
   const observed=await waitUntil(()=>evaluate("(()=>{const f=app.vault.getAbstractFileByPath('Assets/payload-100mb.bin');return f?.stat?.size===100000000?{size:f.stat.size}:null;})()"),60000,"real Obsidian indexed new 100 MB binary");
   assertTrue(observed.size===size,"Native Obsidian did not index the synthetic 100 MB file");
   const uploaded=await evaluate("(async()=>{const p=app.plugins.plugins["+JSON.stringify(id)+"];await p.v4Runtime.manualSync();return {lifecycle:p.v4Runtime.progressSnapshot.lifecycle,trigger:p.v4Runtime.progressSnapshot.trigger};})()",480000);
   assertTrue(uploaded.lifecycle==="success"&&uploaded.trigger==="manual","Native Obsidian 100 MB GitHub Push failed");
   const remote=await readState(configuration);
   assertTrue(remote.kind==="present"&&remote.sha!==before,"Native Obsidian 100 MB upload did not publish a commit");
   finalSha=remote.sha;
   nativeBinary={path:name,size,sha256:checksum.digest("hex")};
   journeySteps.push("real Obsidian indexed and uploaded exact 100 MB binary");
  }
  if(verifyPeer){
   const restored=await restoreEncryptedToSecondObsidian({
    exe,runRoot,port:port+1,pluginId:id,sourceRoot:root,configuration,passphrase,
    expectedContent:"# Synthetic remote UI E2E\n\nSecond revision from Obsidian.\n",
    expectedFiles:journey?expectedPeerFiles:[],absentPaths:journey?["Notes/สวัสดี 🌏.md"]:[],exercisePeerConflict:journey,expectedBinary:nativeBinary,
   });
   assertTrue(restored.peerRestored&&restored.bytesRestored>0,"Second real Obsidian vault could not decrypt remote data");
   const afterPull=await readState(configuration);
   if(journey){
    assertTrue(restored.peerMutated&&afterPull.kind==="present"&&afterPull.sha!==finalSha,
     "Real peer edit did not publish a competing GitHub commit");
    const localEdit=await evaluate("(async()=>{const p=app.plugins.plugins["+JSON.stringify(id)+"];const file=app.vault.getAbstractFileByPath('UI-smoke.md');await app.vault.modify(file,'# Synthetic remote UI E2E\\n\\nMain conflicting revision.\\n');await p.v4Runtime.manualSync();return {lifecycle:p.v4Runtime.progressSnapshot.lifecycle};})()",240000);
    assertTrue(localEdit.lifecycle==="success","Real Obsidian conflict reconciliation did not succeed");
    const checked=await evaluate("(async()=>{const files=app.vault.getFiles();let local=false,peer=false;for(const file of files){if(!file.path.endsWith('.md'))continue;const text=await app.vault.read(file);if(text.includes('Main conflicting revision.'))local=true;if(text.includes('Peer conflicting revision.'))peer=true;}return {local,peer,count:files.length};})()",240000);
    assertTrue(checked.local&&checked.peer,"Local/remote conflicting text was not preserved in two Obsidian notes: "+JSON.stringify(checked));
    journeySteps.push("two-device simultaneous conflict retained both revisions");
    finalSha=(await readState(configuration)).sha;
   }else{
    assertTrue(afterPull.kind==="present"&&afterPull.sha===finalSha,"Second-device Force Pull unexpectedly changed GitHub HEAD");
   }
   peerRestored=true;
   peerScreenshot=restored.peerScreenshot;
  }
  passed=true;
 }
}catch(error){
 console.error("OBSIDIAN_LIVE_UI_E2E_FAILED: "+redact(error));
 process.exitCode=1;
}finally{
 if(ws)try{ws.close()}catch{}
 if(processHandle?.pid){
  const stopped=spawnSync("taskkill",["/PID",String(processHandle.pid),"/T","/F"],{timeout:15000,encoding:"utf8"});
  if(stopped.status!==0)console.error("WARNING: isolated Obsidian process could not be terminated");
 }
 if(verified&&configuration&&!dryRun){
  try{
   await cleanupE2EBranch({...configuration,currentSourceRepoId:CANONICAL_REPOSITORY_ID});
   const final=await readState(configuration);
   assertTrue(final.kind==="absent","Disposal branch remains after cleanup");
   cleanupState="absent-verified";
  }catch(error){cleanupState="FAILED";process.exitCode=1;console.error("GITHUB_BRANCH_CLEANUP_FAILED: "+redact(error));}
 }
 // Always erase isolated credentials, encrypted secrets, synthetic notes and
 // profile only after terminating the process. PNG is also deleted: it can be
 // retained only via an explicit sanitized export in a later reviewed workflow.
 if(!dryRun){
  try{await cleanupGeneratedUiRun(runRoot,{repoRoot:root});}catch(error){console.error("WARNING: isolated test vault cleanup incomplete ("+String(error?.code||"unknown").slice(0,30)+")");process.exitCode=1;}
 }
 console.log(JSON.stringify({status:passed&&!process.exitCode?"PASS":"FAIL",cleanup:cleanupState,remoteHeadChanged:Boolean(initialSha&&finalSha&&initialSha!==finalSha),
  screenshotCaptured:screenBytes>1000,screenshotPath:screenBytes>1000?screenshot:null,uiExceptions:sendErrors.length,mode,remoteEncryptionVerified,peerRestored,peerScreenshot,journeySteps,native100mbBytes:nativeBinary?.size??0,native100mbSha256:nativeBinary?.sha256??null,runBranch:branch,repository:configuration?.targetRepository,token:"[not reported]"}));
}
