#!/usr/bin/env node
// Actual Android WebView, explicitly opened disposable Vault only.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {loadGitHubE2EEnv,qualificationE2EBranch,validateGitHubE2EConfig,resolvePinnedGitHubE2ERepoId} from "./github-e2e-env.mjs";
import {preflightE2ERemote,readE2EBranch,cleanupE2EBranch} from "./github-e2e-remote.mjs";
import {CANONICAL_REPOSITORY_ID,readOriginFetchRepository} from "./github-repo.mjs";
import {restoreEncryptedToSecondObsidian} from "./obsidian-live-ui-peer.mjs";
import {createAndroidRestart,runAndroidRestartJourney} from "./obsidian-android-restart.mjs";
import {runAndroidNetworkJourney} from "./obsidian-android-network.mjs";
import {runAndroidPublicationJourney} from "./obsidian-android-publication.mjs";
import {cleanupGeneratedUiRun,cleanupGeneratedUiEvidence} from "./obsidian-live-ui-cleanup.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let port=Number(process.argv.find(x=>x.startsWith("--port="))?.slice(7));
const probe=process.argv.includes("--probe");
const boundary=process.argv.includes("--mobile-boundary");
const remoteOversize=process.argv.includes("--remote-oversize");
const restart=process.argv.includes("--restart-journey");
const network=process.argv.includes("--network-journey");
const publication=process.argv.includes("--publication-journey");
assert.ok([remoteOversize,boundary,restart,network,publication].filter(Boolean).length<=1,"Choose a single mobile journey");
const resumeBoundary=process.argv.includes("--resume-d498");
assert.ok(!resumeBoundary||boundary,"D498 resume requires boundary journey");
const previousAutoPath="Auto-Android-037923305d0ee124.md";
const reducedFixture={path:"Assets/android-from-windows-oversize.bin",size:1048576,sha256:"23e7d18fa53f2a863310856b76d3863d1e9b5f55ea6236a228d38b80b4baef9b"};
const previousIncoming={path:"Assets/android-from-windows-1mib.bin",size:1048576,sha256:"e3d86672bd222a49d50bc59b4a0b24f9675c2b9a49d43de53bd4a509a1c6c785"};
const reuse=publication||network||restart||remoteOversize||boundary||process.argv.includes("--reuse-fixtures");
const transport=Number(process.argv.find(x=>x.startsWith("--transport="))?.slice(12));
assert.ok(!(publication||network||restart||boundary||remoteOversize)||Number.isSafeInteger(transport)&&transport>0,"Boundary journey needs explicit ADB transport ID");
assert.ok(Number.isInteger(port)&&port>1024&&port<=65535);
const name="ObsidianSync-D496-Disposable";
const pluginId="encrypted-github-sync-multi-platform";
const runId=randomBytes(8).toString("hex");
const runRoot=path.join(root,".tmp","obsidian-live-github-e2e",runId);
const passphrase=randomBytes(32).toString("base64url");
const git=args=>spawnSync("git",args,{cwd:root,encoding:"utf8",shell:false});
let ws,config,verified=false,settingsAttempted=false,secretCleanup=false,ok=false,branchCleanup=false;
let serial=0;
const pending=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const identityExpression=`(()=>{const a=globalThis.app;const v=a?.vault;const adapter=v?.adapter;const base=adapter?.getBasePath?.()??adapter?.basePath??adapter?.getFullPath?.("")??"";const normalized=String(base).replace(/^file:\\/\\//u,"").replace(/\\/$/u,"");const correct=v?.getName()===${JSON.stringify(name)}&&["/storage/emulated/0/Documents/${name}","/sdcard/Documents/${name}"].includes(normalized);const p=a?.plugins?.plugins?.[${JSON.stringify(pluginId)}];return {correct,nameMatches:v?.getName()===${JSON.stringify(name)},baseMatches:correct,adapterType:adapter?.constructor?.name,loaded:!!p?.v4Runtime,configured:!!(p?.settings?.githubOwner||p?.settings?.githubRepo||p?.settings?.githubToken||p?.settings?.encryptionPassphrase),fileNames:correct?v.getFiles().map(f=>f.path).sort():[],version:correct?p?.manifest?.version:null};})()`;
function send(expression,ms=25000){
 return new Promise((resolve,reject)=>{
  const id=++serial;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("Android CDP timeout"));},ms);
  pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
  ws.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));
 });
}
async function evaluate(expression,ms){
 const result=await send(expression,ms);
 if(result.exceptionDetails)throw Error("Android renderer evaluation rejected");
 return result.result.value;
}
async function guarded(body,ms=25000){
 return evaluate(`(async()=>{const identity=${identityExpression};if(!identity.correct||!identity.loaded)throw Error("Wrong Android Vault or unloaded plugin");const p=app.plugins.plugins[${JSON.stringify(pluginId)}];${body}})()`,ms);
}
const safeError=e=>String(e?.message??e).replaceAll(config?.token??"__no_token__","[redacted]").replaceAll(passphrase,"[redacted]").replace(/gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/gu,"[redacted]").slice(0,600);
const summary='const s=p.v4Runtime.progressSnapshot;return {status:outcome?.status,lifecycle:s.lifecycle,changedFiles:outcome?.changedFiles,trigger:s.trigger,diagnostics:s.diagnostics,error:s.errorMessage?.slice(0,180)};';
async function attach(nextPort=port){
 port=nextPort;
 const pages=await (await fetch("http://127.0.0.1:"+port+"/json/list",{signal:AbortSignal.timeout(5000)})).json();
 const candidates=pages.filter(x=>x.type==="page"&&x.url==="http://localhost/"&&x.webSocketDebuggerUrl);
 assert.equal(candidates.length,1,"Expected one Obsidian Android WebView");
 ws=new WebSocket(candidates[0].webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error("Android WebView attach failed"));});
 ws.onmessage=({data})=>{const m=JSON.parse(String(data));const cb=pending.get(m.id);if(!cb)return;pending.delete(m.id);m.error?cb.reject(Error("Android CDP error")):cb.resolve(m.result);};
 }
 const disconnect=()=>{assert.equal(pending.size,0,"CDP requests still active");if(ws)ws.close();ws=undefined;};
 const lifecycle=restart?createAndroidRestart({root,transport,name,guarded,evaluateIdentity:()=>evaluate(identityExpression),disconnect,attach,currentPort:()=>port}):null;
try{
 await attach();
 const identity=await evaluate(identityExpression);
 console.log(JSON.stringify({kind:"android-identity",...identity}));
 assert.ok(identity.correct&&identity.loaded&&!identity.configured,"Expected exact unconfigured disposable Android Vault and loaded plugin");
 assert.deepEqual(identity.fileNames,publication?["Assets/android-1mib.bin",previousIncoming.path,"Assets/android-from-windows-2mib.bin","Assets/android-from-windows-32mib.bin",reducedFixture.path,"Assets/android-network-02197b9cb990415e.bin",previousAutoPath,"Smoke.md","UI-smoke.md"].sort():network?["Assets/android-1mib.bin",previousIncoming.path,"Assets/android-from-windows-2mib.bin","Assets/android-from-windows-32mib.bin",reducedFixture.path,previousAutoPath,"Smoke.md","UI-smoke.md"].sort():restart?["Assets/android-1mib.bin",previousIncoming.path,"Assets/android-from-windows-32mib.bin",reducedFixture.path,previousAutoPath,"Smoke.md","UI-smoke.md"].sort():remoteOversize?["Assets/android-1mib.bin",previousIncoming.path,"Assets/android-from-windows-32mib.bin",previousAutoPath,"Smoke.md","UI-smoke.md"].sort():resumeBoundary?["Assets/android-1mib.bin",previousIncoming.path,previousAutoPath,"Smoke.md","UI-smoke.md"].sort():reuse?["Assets/android-1mib.bin","Smoke.md","UI-smoke.md"]:["Smoke.md"]);
 if(probe){ok=true;}else{
  const sha=git(["rev-parse","HEAD"]);assert.equal(sha.status,0);
  assert.equal(git(["status","--porcelain"]).stdout.trim(),"","Clean checkout required");
  const env=(await loadGitHubE2EEnv({cwd:root,env:process.env})).env;
  const source=readOriginFetchRepository({runner:(cmd,args,opt)=>spawnSync(cmd,args,{...opt,shell:false}),cwd:root});
  config=validateGitHubE2EConfig({owner:env.GITHUB_E2E_OWNER,repo:env.GITHUB_E2E_REPO,token:env.GITHUB_E2E_TOKEN,branch:qualificationE2EBranch(sha.stdout.trim(),runId),expectedRepoId:resolvePinnedGitHubE2ERepoId(env.GITHUB_E2E_EXPECTED_REPO_ID,"1284153873"),currentSourceRepo:source});
  await preflightE2ERemote({config:{...config,currentSourceRepoId:CANONICAL_REPOSITORY_ID}});verified=true;
  assert.equal((await readE2EBranch(config)).kind,"absent");
  console.log(JSON.stringify({kind:"preflight",branch:config.branch,repoId:config.expectedRepoId,sourceSHA:sha.stdout.trim()}));
  const expectedContent=(publication||network||restart||boundary||remoteOversize)?"# Synthetic remote UI E2E\n\nPeer conflicting revision.\n":"# Synthetic remote UI E2E\n\nAndroid source revision.\n";
  const smoke=await guarded('return await app.vault.read(app.vault.getAbstractFileByPath("Smoke.md"));');
  assert.equal(smoke,"# D496 disposable Android qualification\n\nSynthetic note only. No personal data or GitHub credentials.\n");
  const expectedBinary={path:"Assets/android-1mib.bin",size:1048576};
  const fixture=reuse?null:randomBytes(expectedBinary.size);
  if(reuse){const existing=await guarded(`const note=await app.vault.read(app.vault.getAbstractFileByPath("UI-smoke.md"));const b=await app.vault.readBinary(app.vault.getAbstractFileByPath(${JSON.stringify(expectedBinary.path)}));const h=new Uint8Array(await crypto.subtle.digest("SHA-256",b));return {note,size:b.byteLength,sha256:Array.from(h,x=>x.toString(16).padStart(2,"0")).join("")};`);assert.equal(existing.note,expectedContent);assert.equal(existing.size,expectedBinary.size);assert.match(existing.sha256,/^[a-f0-9]{64}$/u);expectedBinary.sha256=existing.sha256;if(publication||network||restart||boundary||remoteOversize)assert.equal(existing.sha256,"794b7f16e056bc9c3afd0e3f71efe45c6b32b16b2757c698bf48719fe539c653");}else expectedBinary.sha256=createHash("sha256").update(fixture).digest("hex");
  if(publication||network||restart||resumeBoundary||remoteOversize){const previous=await guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(previousIncoming.path)});const b=await app.vault.readBinary(f);const h=new Uint8Array(await crypto.subtle.digest("SHA-256",b));return {size:b.byteLength,sha256:Array.from(h,x=>x.toString(16).padStart(2,"0")).join(""),auto:await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(previousAutoPath)}))};`);assert.deepEqual(previous,{size:previousIncoming.size,sha256:previousIncoming.sha256,auto:"# Android auto sync\n\nFinal native local event.\n"});console.log(JSON.stringify({kind:"android-resumed-fixtures",...previousIncoming,autoPath:previousAutoPath}));}
  if(publication||network||restart||remoteOversize){
   const existing=await guarded('const f=app.vault.getAbstractFileByPath("Assets/android-from-windows-32mib.bin");return f?.stat?.size??null;');
   assert.equal(existing,32*1024*1024);
   const disk=spawnSync("adb",["-t",String(transport),"shell","sha256sum","/sdcard/Documents/"+name+"/Assets/android-from-windows-32mib.bin"],{cwd:root,encoding:"utf8",shell:false,timeout:30000});
   assert.equal(disk.status,0);assert.equal(disk.stdout.trim().split(/\s+/u)[0],"034c9f70be9932cb5d9f132df2a75b14bdd04e00136df5997ac07163ef757b63");
  }
  if(restart){
   assert.equal(await guarded(`return app.vault.getAbstractFileByPath(${JSON.stringify(reducedFixture.path)})?.stat?.size??null;`),reducedFixture.size);
   assert.equal(lifecycle.diskHash(reducedFixture.path),reducedFixture.sha256);
  }
  if(publication||network){
   for(const spec of [reducedFixture,{path:"Assets/android-from-windows-2mib.bin",size:2097152,sha256:"eceb4134615117215d2b7788bf53b5cf90f234142095144aea421725b0c2b1cf"}]){
    assert.equal(await guarded(`return app.vault.getAbstractFileByPath(${JSON.stringify(spec.path)})?.stat?.size??null;`),spec.size);
    const out=spawnSync("adb",["-t",String(transport),"shell","sha256sum","/sdcard/Documents/"+name+"/"+spec.path],{cwd:root,encoding:"utf8",shell:false,timeout:30000});
    assert.equal(out.status,0);assert.equal(out.stdout.trim().split(/\s+/u)[0],spec.sha256);
   }
  }
  if(publication){
   const out=spawnSync("adb",["-t",String(transport),"shell","sha256sum","/sdcard/Documents/"+name+"/Assets/android-network-02197b9cb990415e.bin"],{cwd:root,encoding:"utf8",shell:false,timeout:30000});
   assert.equal(out.status,0);assert.equal(out.stdout.trim().split(/\s+/u)[0],"eab88ffb974dd84649c255db2137cf268866c00d6ed5f048185d1a3482bbe7d2");
  }
  const d={owner:config.owner,repo:config.repo,branch:config.branch,token:config.token,passphrase};
  settingsAttempted=true;
  const configured=await guarded(`const d=${JSON.stringify(d)};if(p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)throw Error("Already configured");const nextSettings={...p.settings,githubOwner:d.owner,githubRepo:d.repo,githubBranch:d.branch,githubToken:d.token,encryptionMode:"encrypted",encryptionPassphrase:d.passphrase,syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false};await p.saveSettings(nextSettings);return p.settings.githubBranch===d.branch&&p.settings.githubToken===d.token&&p.settings.encryptionPassphrase===d.passphrase;`);
  assert.equal(configured,true);
  const create=reuse?"":`await app.vault.create("UI-smoke.md",${JSON.stringify(expectedContent)});await app.vault.createFolder("Assets");const raw=Uint8Array.from(atob(${JSON.stringify(fixture.toString("base64"))}),c=>c.charCodeAt(0));await app.vault.createBinary(${JSON.stringify(expectedBinary.path)},raw.buffer);`;
  const init=await guarded(`${create}const outcome=await p.v4Runtime.manualSync();${summary}`,240000);
  console.log("android-initial "+safeError(JSON.stringify(init)));
  assert.equal(init.status,"completed");assert.equal(init.lifecycle,"success");
  const head=await readE2EBranch(config);assert.equal(head.kind,"present");console.log(JSON.stringify({kind:"android-published",binaryBytes:expectedBinary.size,sha256:expectedBinary.sha256,reusedFixture:reuse}));
  const verifyBinary=async()=>guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(expectedBinary.path)});const b=await app.vault.readBinary(f);const h=new Uint8Array(await crypto.subtle.digest("SHA-256",b));return {size:b.byteLength,sha256:Array.from(h,x=>x.toString(16).padStart(2,"0")).join("")};`);
  assert.deepEqual(await verifyBinary(),{size:expectedBinary.size,sha256:expectedBinary.sha256});
  const noop=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  assert.equal(noop.lifecycle,"no-change");assert.equal(noop.changedFiles,0);assert.equal((await readE2EBranch(config)).sha,head.sha);
  if(publication){
   const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
   await mkdir(runRoot,{recursive:true});
   await runAndroidPublicationJourney({root,transport,name,guarded,configuration:config,head,readState:()=>readE2EBranch(config),runId,summary,runPeer:options=>restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedBinary,...options,expectedFiles:[{path:"Smoke.md",content:smoke},{path:previousAutoPath,content:"# Android auto sync\n\nFinal native local event.\n"},...options.expectedFiles]})});
   ok=true;
  }else if(network){
   const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
   await mkdir(runRoot,{recursive:true});
   await runAndroidNetworkJourney({root,transport,name,guarded,configuration:config,head,readState:()=>readE2EBranch(config),runRoot,runId,summary,runPeer:options=>restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedFiles:[{path:"Smoke.md",content:smoke},{path:previousAutoPath,content:"# Android auto sync\n\nFinal native local event.\n"}],expectedBinary,...options})});
   ok=true;
  }else if(restart){
   const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
   await mkdir(runRoot,{recursive:true});
   await runAndroidRestartJourney({lifecycle,guarded,evaluateIdentity:()=>evaluate(identityExpression),identity,configuration:config,credentials:d,head,readState:()=>readE2EBranch(config),runPeer:options=>restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedFiles:[{path:"Smoke.md",content:smoke},{path:previousAutoPath,content:"# Android auto sync\n\nFinal native local event.\n"}],expectedBinary,...options})});
   ok=true;
  }else if(remoteOversize){
   const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
   const target="Assets/android-from-windows-oversize.bin";
   const bytes=32*1024*1024+1;
   const digest=async file=>{const out=spawnSync("adb",["-t",String(transport),"shell","sha256sum","/sdcard/Documents/"+name+"/"+file],{cwd:root,encoding:"utf8",shell:false,timeout:30000});assert.equal(out.status,0);return out.stdout.trim().split(/\s+/u)[0];};
   const fileSize=async file=>guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(file)});return f?.stat?.size??null;`);
   const existingHash=await digest("Assets/android-from-windows-32mib.bin");
   let current=head.sha,refusalVerified=false,recovered=false;
   await mkdir(runRoot,{recursive:true});
   const peer=await restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedFiles:[{path:"Smoke.md",content:smoke},{path:previousAutoPath,content:"# Android auto sync\n\nFinal native local event.\n"}],expectedBinary,peerBinaryJourneys:[{path:target,size:bytes,reduceToSize:1048576}],afterPeerBinary:async spec=>{
    const remote=await readE2EBranch(config);assert.ok(remote.kind==="present"&&remote.sha!==current);current=remote.sha;
    assert.equal(await fileSize(target),null,"Unexpected local target before remote pull");
    const result=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
    console.log(JSON.stringify({kind:spec.reduced?"android-reduced-recovery":"android-remote-oversize-refusal",...spec,outcome:result}));
    if(!spec.reduced){
     assert.ok(result.status==="failed"&&result.lifecycle==="failed"&&result.changedFiles===0&&result.diagnostics?.uploadBytes===0&&result.diagnostics?.downloadBytes<1048576,"Oversized pull did not fail before content transfer");
     assert.match(result.error??"",/cannot download files larger than 32 MiB/u);
     assert.match(result.error??"",/desktop device/u);
     assert.equal(await fileSize(target),null);assert.equal(await digest("Assets/android-from-windows-32mib.bin"),existingHash);
     assert.equal((await readE2EBranch(config)).sha,current);
     refusalVerified=true;
    }else{
     assert.ok(result.status==="completed"&&result.lifecycle==="success"&&result.diagnostics?.apiFailures===0,"Reduced-file normal retry failed");
     assert.equal(await fileSize(target),spec.size);assert.equal(await digest(target),spec.sha256);
     assert.equal(await digest("Assets/android-from-windows-32mib.bin"),existingHash);
     assert.equal((await readE2EBranch(config)).sha,current);
     const noop=await guarded("const outcome=await p.v4Runtime.manualSync();const s=p.v4Runtime.progressSnapshot;return {status:outcome?.status,lifecycle:s.lifecycle,changedFiles:outcome?.changedFiles,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused};",240000);
     assert.ok(noop.status==="completed"&&noop.lifecycle==="no-change"&&noop.changedFiles===0&&!noop.paused,"Reduced-file recovery did not settle: "+JSON.stringify(noop));
     assert.equal((await readE2EBranch(config)).sha,current);recovered=true;
    }
   }});
   assert.ok(peer.peerRestored&&refusalVerified&&recovered&&peer.binaryJourneys.length===1);
   console.log(JSON.stringify({kind:"android-remote-oversize-complete",refusalVerified,recovered,originalPreserved:true,noOp:true}));
   ok=true;
  }else if(boundary){
   const autoPath=resumeBoundary?previousAutoPath:"Auto-Android-"+runId+".md";
   const autoText="# Android auto sync\n\nFinal native local event.\n";
   let current=head.sha;
   if(!resumeBoundary){
   const enabled=await guarded("await p.saveSettings({...p.settings,syncOnLocalChange:true});return {enabled:p.settings.syncOnLocalChange,watch:p.isWatchEnabled,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused};");
   assert.ok(enabled.enabled&&enabled.watch&&!enabled.paused,"Android Auto Sync not ready");
   const queued=await guarded(`const baseline=p.v4Runtime.progressSnapshot.lastSyncTime;const file=await app.vault.create(${JSON.stringify(autoPath)},"Initial native event.\\n");await app.vault.modify(file,${JSON.stringify(autoText)});const s=p.v4Runtime.progressSnapshot;return {baseline,lifecycle:s.lifecycle,phase:s.phase,trigger:s.trigger,pending:p.v4Runtime.pendingCount};`);
   assert.ok(queued.lifecycle==="waiting"&&queued.phase==="debouncing"&&queued.trigger==="localChange"&&queued.pending>0,"Android local debounce was not observed: "+JSON.stringify(queued));
   let terminal=null;const stop=Date.now()+180000;
   while(Date.now()<stop&&!terminal){
    terminal=await guarded("const s=p.v4Runtime.progressSnapshot;return s.trigger==='localChange'&&['success','failed','no-change'].includes(s.lifecycle)&&!p.isSyncInProgress?{lifecycle:s.lifecycle,lastSyncTime:s.lastSyncTime,pending:p.v4Runtime.pendingCount,error:s.errorMessage?.slice(0,180),diagnostics:s.diagnostics}:null;");
    if(!terminal)await pause(350);
   }
   assert.ok(terminal?.lifecycle==="success"&&terminal.lastSyncTime>queued.baseline&&terminal.pending===0&&terminal.diagnostics?.apiFailures===0,"Android Auto Sync failed: "+JSON.stringify(terminal));
   current=(await readE2EBranch(config)).sha;assert.ok(current&&current!==head.sha);
   assert.equal(await guarded("await p.saveSettings({...p.settings,syncOnLocalChange:false});return !p.settings.syncOnLocalChange;"),true);
   console.log(JSON.stringify({kind:"android-auto",waitingObserved:true,pendingAfter:terminal.pending,remoteHeadChanged:true,diagnostics:terminal.diagnostics}));
   }
   const adb=args=>{const result=spawnSync("adb",["-t",String(transport),...args],{cwd:root,encoding:"utf8",shell:false,timeout:120000});assert.equal(result.status,0,"ADB exact fixture operation failed");return result.stdout.trim();};
   const mobileRoot="/sdcard/Documents/"+name;
   const binaryHash=async(spec)=>{const value=adb(["shell","sha256sum",mobileRoot+"/"+spec.path]).split(/\s+/u)[0];assert.match(value,/^[a-f0-9]{64}$/u);return value;};
   const inventoryCheck=async(spec)=>guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(spec.path)});return f?.stat?.size??null;`);
   const evidence=resumeBoundary?[{...previousIncoming,pulled:true,verifiedOnResume:true}]:[];
   if(resumeBoundary)assert.equal(await binaryHash(previousIncoming),previousIncoming.sha256);
   const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
   await mkdir(runRoot,{recursive:true});
   const peer=await restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedFiles:[{path:"Smoke.md",content:smoke},{path:autoPath,content:autoText}],expectedBinary,peerBinaryJourneys:[...(resumeBoundary?[]:[{path:"Assets/android-from-windows-1mib.bin",size:1048576}]),{path:"Assets/android-from-windows-32mib.bin",size:32*1024*1024}],afterPeerBinary:async spec=>{
    const remote=await readE2EBranch(config);assert.ok(remote.kind==="present"&&remote.sha!==current,"Windows binary publication did not advance ref");current=remote.sha;
    assert.equal(await inventoryCheck(spec),null,"New remote binary unexpectedly already present");
    const pulled=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
    console.log(JSON.stringify({kind:"android-binary-pull",...spec,outcome:pulled}));
    assert.ok(pulled.status==="completed"&&pulled.lifecycle==="success"&&pulled.diagnostics?.apiFailures===0,"Android binary pull failed: "+safeError(JSON.stringify(pulled)));
    assert.equal(await inventoryCheck(spec),spec.size);
    assert.equal(await binaryHash(spec),spec.sha256,"Android disk SHA differs from Windows source");
    assert.equal((await readE2EBranch(config)).sha,current,"Android pull unexpectedly published a commit");
    evidence.push({...spec,pulled:true,diagnostics:pulled.diagnostics});
    if(spec.size===32*1024*1024){
     const modified=await guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(spec.path)});const b=await app.vault.readBinary(f);if(b.byteLength!==${spec.size})throw Error("32 MiB file size mismatch");const bytes=new Uint8Array(b);bytes[0]^=255;await app.vault.modifyBinary(f,b);return true;`,90000);
     assert.equal(modified,true);
     const expectedReturnHash=await binaryHash(spec);assert.notEqual(expectedReturnHash,spec.sha256);
     const sent=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
     console.log(JSON.stringify({kind:"android-boundary-upload",size:spec.size,sha256:expectedReturnHash,outcome:sent}));
     assert.ok(sent.status==="completed"&&sent.lifecycle==="success"&&sent.diagnostics?.apiFailures===0,"Android 32 MiB upload failed: "+safeError(JSON.stringify(sent)));
     const advanced=await readE2EBranch(config);assert.ok(advanced.kind==="present"&&advanced.sha!==current);current=advanced.sha;
     return {expectedReturnHash};
    }
   }});
   assert.ok(peer.peerRestored&&peer.binaryJourneys.length===(resumeBoundary?1:2)&&peer.binaryJourneys.at(-1).returned,"Windows peer did not verify Android 32 MiB revision");
   const big={path:"Assets/android-oversize-"+runId+".bin",size:32*1024*1024+1};
   assert.equal(await inventoryCheck(big),null);
   const bigBytes=randomBytes(big.size);big.sha256=createHash("sha256").update(bigBytes).digest("hex");
   const hostFile=path.join(runRoot,"oversize.bin");
   await writeFile(hostFile,bigBytes,{flag:"wx"});
   adb(["push",hostFile,mobileRoot+"/"+big.path]);
   const deadline=Date.now()+45000;let indexed=false;
   while(Date.now()<deadline&&!indexed){indexed=await inventoryCheck(big)===big.size;if(!indexed)await pause(300);}
   assert.ok(indexed,"Android did not index oversized synthetic fixture");
   assert.equal(await binaryHash(big),big.sha256);
   const refusal=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
   console.log(JSON.stringify({kind:"android-oversized-refusal",size:big.size,outcome:refusal}));
   assert.ok(refusal.status==="failed"&&refusal.lifecycle==="failed"&&/bounded-read|bounded read|32 MiB/u.test(refusal.error??""),"Expected explicit oversized bounded-read refusal");
   assert.equal((await readE2EBranch(config)).sha,current,"Oversized attempt changed remote HEAD");
   assert.equal(await binaryHash(big),big.sha256,"Oversized local bytes were changed");
   assert.equal(await guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(big.path)});if(f?.stat?.size!==${big.size})throw Error("Unexpected synthetic fixture size");await app.vault.delete(f);return !app.vault.getAbstractFileByPath(${JSON.stringify(big.path)});`),true);
   const recovered=await guarded("const outcome=await p.v4Runtime.manualSync();const s=p.v4Runtime.progressSnapshot;return {status:outcome?.status,lifecycle:s.lifecycle,changedFiles:outcome?.changedFiles,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused};",240000);
   assert.ok(recovered.status==="completed"&&recovered.lifecycle==="no-change"&&recovered.changedFiles===0&&!recovered.paused,"Android recovery after removing oversized fixture failed: "+JSON.stringify(recovered));
   assert.equal((await readE2EBranch(config)).sha,current);
   console.log(JSON.stringify({kind:"android-boundary-complete",autoSync:resumeBoundary?"verified-earlier-run":true,downloaded:evidence.map(x=>({path:x.path,size:x.size,sha256:x.sha256})),exact32MiBReturnVerified:true,oversizeRefused:true,oversizeSourcePreserved:true,headUnchanged:true,recoveryNoop:true}));
   ok=true;
  }else{
  const exe="C:\\Program Files\\Obsidian\\Obsidian.exe";
  await mkdir(runRoot,{recursive:true});
  const peer=await restoreEncryptedToSecondObsidian({exe,runRoot,port:20000+process.pid%35000,pluginId,sourceRoot:root,configuration:config,passphrase,expectedContent,expectedFiles:[{path:"Smoke.md",content:smoke}],expectedBinary,exercisePeerConflict:true});
  assert.ok(peer.peerRestored&&peer.peerMutated);
  let remote;for(let i=0;i<30;i++){remote=await readE2EBranch(config);if(remote.kind==="present"&&remote.sha!==head.sha)break;await pause(1000);}
  assert.ok(remote.kind==="present"&&remote.sha!==head.sha);
  const pull=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  assert.equal(pull.status,"completed");assert.equal(pull.lifecycle,"success");
  const note=await guarded('return await app.vault.read(app.vault.getAbstractFileByPath("UI-smoke.md"));');
  assert.equal(note,"# Synthetic remote UI E2E\n\nPeer conflicting revision.\n");
  assert.deepEqual(await verifyBinary(),{size:expectedBinary.size,sha256:expectedBinary.sha256});
  const final=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  assert.equal(final.lifecycle,"no-change");assert.equal(final.changedFiles,0);assert.equal((await readE2EBranch(config)).sha,remote.sha);
  console.log(JSON.stringify({kind:"android-roundtrip",binaryBytes:expectedBinary.size,sha256:expectedBinary.sha256,windowsPeerVerified:true,androidPulledPeerEdit:true,finalNoop:true,uploadDiagnostics:init.diagnostics,pullDiagnostics:pull.diagnostics}));ok=true;
  }
 }
}catch(e){console.error("ANDROID_E2E_FAILED: "+safeError(e));process.exitCode=1;}
finally{
 if(settingsAttempted){
  try{if(lifecycle)await lifecycle.reconnectForCleanup();const cleaned=await guarded(`const old=[p.settings.githubTokenSecretId,p.settings.encryptionPassphraseSecretId];const nextSettings={...p.settings,githubOwner:"",githubRepo:"",githubBranch:"main",githubToken:"",encryptionPassphrase:"",syncEnabled:false,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false};await p.saveSettings(nextSettings);return !p.settings.githubToken&&!p.settings.encryptionPassphrase&&!p.settings.syncEnabled&&old.every(id=>!id||!app.secretStorage.getSecret(id));`);assert.equal(cleaned,true);secretCleanup=true;}catch(e){console.error("ANDROID_SETTINGS_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}
 }
 if(ws)ws.close();
 if(lifecycle){try{lifecycle.cleanupForwards();}catch(e){console.error("ANDROID_FORWARD_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}}
 if(verified&&config){try{await cleanupE2EBranch({...config,currentSourceRepoId:CANONICAL_REPOSITORY_ID});for(let i=0;i<2;i++)assert.equal((await readE2EBranch(config)).kind,"absent");branchCleanup=true;}catch(e){console.error("ANDROID_BRANCH_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}}
 if(!probe){try{await cleanupGeneratedUiRun(runRoot,{repoRoot:root});await cleanupGeneratedUiEvidence(runRoot,{repoRoot:root});}catch(e){console.error("ANDROID_PEER_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}}
 console.log(JSON.stringify({status:ok&&!process.exitCode?"PASS":"FAIL",probe,secretCleanup,branchCleanup,branch:config?.branch??null}));
}
