#!/usr/bin/env node
// Actual Android WebView, explicitly opened disposable Vault only.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {loadGitHubE2EEnv,qualificationE2EBranch,validateGitHubE2EConfig,resolvePinnedGitHubE2ERepoId} from "./github-e2e-env.mjs";
import {preflightE2ERemote,readE2EBranch,cleanupE2EBranch} from "./github-e2e-remote.mjs";
import {CANONICAL_REPOSITORY_ID,readOriginFetchRepository} from "./github-repo.mjs";
import {restoreEncryptedToSecondObsidian} from "./obsidian-live-ui-peer.mjs";
import {cleanupGeneratedUiRun,cleanupGeneratedUiEvidence} from "./obsidian-live-ui-cleanup.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const port=Number(process.argv.find(x=>x.startsWith("--port="))?.slice(7));
const probe=process.argv.includes("--probe");
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
try{
 const pages=await (await fetch("http://127.0.0.1:"+port+"/json/list",{signal:AbortSignal.timeout(5000)})).json();
 const candidates=pages.filter(x=>x.type==="page"&&x.url==="http://localhost/"&&x.webSocketDebuggerUrl);
 assert.equal(candidates.length,1,"Expected one Obsidian Android WebView");
 ws=new WebSocket(candidates[0].webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error("Android WebView attach failed"));});
 ws.onmessage=({data})=>{const m=JSON.parse(String(data));const cb=pending.get(m.id);if(!cb)return;pending.delete(m.id);m.error?cb.reject(Error("Android CDP error")):cb.resolve(m.result);};
 const identity=await evaluate(identityExpression);
 console.log(JSON.stringify({kind:"android-identity",...identity}));
 assert.ok(identity.correct&&identity.loaded&&!identity.configured,"Expected exact unconfigured disposable Android Vault and loaded plugin");
 assert.deepEqual(identity.fileNames,["Smoke.md"]);
 if(probe){ok=true;}else{
  const sha=git(["rev-parse","HEAD"]);assert.equal(sha.status,0);
  assert.equal(git(["status","--porcelain"]).stdout.trim(),"","Clean checkout required");
  const env=(await loadGitHubE2EEnv({cwd:root,env:process.env})).env;
  const source=readOriginFetchRepository({runner:(cmd,args,opt)=>spawnSync(cmd,args,{...opt,shell:false}),cwd:root});
  config=validateGitHubE2EConfig({owner:env.GITHUB_E2E_OWNER,repo:env.GITHUB_E2E_REPO,token:env.GITHUB_E2E_TOKEN,branch:qualificationE2EBranch(sha.stdout.trim(),runId),expectedRepoId:resolvePinnedGitHubE2ERepoId(env.GITHUB_E2E_EXPECTED_REPO_ID,"1284153873"),currentSourceRepo:source});
  await preflightE2ERemote({config:{...config,currentSourceRepoId:CANONICAL_REPOSITORY_ID}});verified=true;
  assert.equal((await readE2EBranch(config)).kind,"absent");
  console.log(JSON.stringify({kind:"preflight",branch:config.branch,repoId:config.expectedRepoId,sourceSHA:sha.stdout.trim()}));
  const expectedContent="# Synthetic remote UI E2E\n\nAndroid source revision.\n";
  const smoke=await guarded('return await app.vault.read(app.vault.getAbstractFileByPath("Smoke.md"));');
  assert.equal(smoke,"# D496 disposable Android qualification\n\nSynthetic note only. No personal data or GitHub credentials.\n");
  const expectedBinary={path:"Assets/android-1mib.bin",size:1048576};
  const fixture=randomBytes(expectedBinary.size);expectedBinary.sha256=createHash("sha256").update(fixture).digest("hex");
  const d={owner:config.owner,repo:config.repo,branch:config.branch,token:config.token,passphrase};
  settingsAttempted=true;
  const configured=await guarded(`const d=${JSON.stringify(d)};if(p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)throw Error("Already configured");const nextSettings={...p.settings,githubOwner:d.owner,githubRepo:d.repo,githubBranch:d.branch,githubToken:d.token,encryptionMode:"encrypted",encryptionPassphrase:d.passphrase,syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false};await p.saveSettings(nextSettings);return p.settings.githubBranch===d.branch&&p.settings.githubToken===d.token&&p.settings.encryptionPassphrase===d.passphrase;`);
  assert.equal(configured,true);
  const init=await guarded(`await app.vault.create("UI-smoke.md",${JSON.stringify(expectedContent)});await app.vault.createFolder("Assets");const raw=Uint8Array.from(atob(${JSON.stringify(fixture.toString("base64"))}),c=>c.charCodeAt(0));await app.vault.createBinary(${JSON.stringify(expectedBinary.path)},raw.buffer);const outcome=await p.v4Runtime.manualSync();${summary}`,240000);
  console.log("android-initial "+safeError(JSON.stringify(init)));
  assert.equal(init.status,"completed");assert.equal(init.lifecycle,"success");
  const head=await readE2EBranch(config);assert.equal(head.kind,"present");
  const verifyBinary=async()=>guarded(`const f=app.vault.getAbstractFileByPath(${JSON.stringify(expectedBinary.path)});const b=await app.vault.readBinary(f);const h=new Uint8Array(await crypto.subtle.digest("SHA-256",b));return {size:b.byteLength,sha256:Array.from(h,x=>x.toString(16).padStart(2,"0")).join("")};`);
  assert.deepEqual(await verifyBinary(),{size:expectedBinary.size,sha256:expectedBinary.sha256});
  const noop=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  assert.equal(noop.lifecycle,"no-change");assert.equal(noop.changedFiles,0);assert.equal((await readE2EBranch(config)).sha,head.sha);
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
}catch(e){console.error("ANDROID_E2E_FAILED: "+safeError(e));process.exitCode=1;}
finally{
 if(settingsAttempted){
  try{const cleaned=await guarded(`const old=[p.settings.githubTokenSecretId,p.settings.encryptionPassphraseSecretId];const nextSettings={...p.settings,githubOwner:"",githubRepo:"",githubBranch:"main",githubToken:"",encryptionPassphrase:"",syncEnabled:false,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false};await p.saveSettings(nextSettings);return !p.settings.githubToken&&!p.settings.encryptionPassphrase&&!p.settings.syncEnabled&&old.every(id=>!id||!app.secretStorage.getSecret(id));`);assert.equal(cleaned,true);secretCleanup=true;}catch(e){console.error("ANDROID_SETTINGS_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}
 }
 if(ws)ws.close();
 if(verified&&config){try{await cleanupE2EBranch({...config,currentSourceRepoId:CANONICAL_REPOSITORY_ID});for(let i=0;i<2;i++)assert.equal((await readE2EBranch(config)).kind,"absent");branchCleanup=true;}catch(e){console.error("ANDROID_BRANCH_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}}
 if(!probe){try{await cleanupGeneratedUiRun(runRoot,{repoRoot:root});await cleanupGeneratedUiEvidence(runRoot,{repoRoot:root});}catch(e){console.error("ANDROID_PEER_CLEANUP_FAILED: "+safeError(e));process.exitCode=1;}}
 console.log(JSON.stringify({status:ok&&!process.exitCode?"PASS":"FAIL",probe,secretCleanup,branchCleanup,branch:config?.branch??null}));
}
