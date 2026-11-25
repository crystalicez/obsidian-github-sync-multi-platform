// Native lifecycle acceptance for the explicitly opened synthetic Android Vault.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function createAndroidRestart({root,transport,name,guarded,evaluateIdentity,disconnect,attach,currentPort}){
 const ownedForwards=new Set();
 let stopped=false;
 const adb=(args,allowMissing=false)=>{
  const r=spawnSync("adb",["-t",String(transport),...args],{cwd:root,encoding:"utf8",shell:false,timeout:30000});
  if(allowMissing&&r.status===1&&!r.stdout?.trim()&&!r.stderr?.trim())return "";
  assert.equal(r.status,0,"Scoped Android ADB operation failed");
  return r.stdout.trim();
 };
 const pid=()=>adb(["shell","pidof","md.obsidian"],true);
 const diskHash=file=>adb(["shell","sha256sum","/sdcard/Documents/"+name+"/"+file]).split(/\s+/u)[0];
 const removeForward=port=>{adb(["forward","--remove","tcp:"+port]);ownedForwards.delete(port);};
 async function stop(branch){
  const state=await guarded("return {idle:!p.isSyncInProgress&&p.v4Runtime.pendingCount===0,branch:p.settings.githubBranch,startup:p.settings.syncOnStartup};");
  assert.ok(state.idle&&state.branch===branch&&state.startup,"Restart requires idle configured test Vault");
  const oldPid=pid();assert.match(oldPid,/^[1-9][0-9]*$/u);
  const port=currentPort();
  assert.ok(adb(["forward","--list"]).split(/\r?\n/u).some(line=>line.endsWith(" tcp:"+port+" localabstract:webview_devtools_remote_"+oldPid)),"CDP connection is not pinned to selected Android process");
  disconnect();
  adb(["shell","am","force-stop","md.obsidian"]);
  stopped=true;
  assert.equal(pid(),"","Android process still alive");
  removeForward(port);
  console.log(JSON.stringify({kind:"android-stopped",oldPid}));
  return oldPid;
 }
 async function reopen(oldPid){
  adb(["shell","am","start","-a","android.intent.action.VIEW","-d","obsidian://open?vault="+name,"-p","md.obsidian"]);
  const deadline=Date.now()+60000;
  let newPid="",ready=false;
  while(Date.now()<deadline){
   newPid=pid();
   if(/^[1-9][0-9]*$/u.test(newPid)&&newPid!==oldPid&&adb(["shell","grep","webview_devtools_remote","/proc/net/unix"],true).includes("@webview_devtools_remote_"+newPid)){ready=true;break;}
   await sleep(500);
  }
  assert.ok(ready,"Android process or WebView was not restarted");
  const port=Number(adb(["forward","tcp:0","localabstract:webview_devtools_remote_"+newPid]));
  assert.ok(Number.isInteger(port)&&port>1024&&port<=65535);
  ownedForwards.add(port);
  while(Date.now()<deadline){
   try{await attach(port);const identity=await evaluateIdentity();if(identity.correct&&identity.loaded){stopped=false;return newPid;}}catch{/* Renderer may still be starting. */}
   disconnect();await sleep(500);
  }
  throw Error("Restarted Android did not load exact disposable Vault");
 }
 return {pid,diskHash,stop,reopen,async reconnectForCleanup(){if(stopped)await reopen("");},cleanupForwards(){for(const port of ownedForwards)removeForward(port);}};
}
export async function runAndroidRestartJourney({lifecycle,guarded,evaluateIdentity,identity,configuration,credentials,head,readState,runPeer}){
 const target="Assets/android-from-windows-2mib.bin";
 const expectedPaths=[...identity.fileNames,target].sort();
 const checkSecrets=()=>guarded(`const d=${JSON.stringify(credentials)};const s=p.settings;const raw=await p.loadData();const saved=raw?.settings??raw;const tokenId=s.githubTokenSecretId,passId=s.encryptionPassphraseSecretId;return {device:s.vault,matched:s.githubOwner===d.owner&&s.githubRepo===d.repo&&s.githubBranch===d.branch&&s.githubToken===d.token&&s.encryptionPassphrase===d.passphrase,settings:s.syncEnabled&&s.syncOnStartup&&!s.syncOnLocalChange&&!s.scheduledSyncEnabled&&s.encryptionMode==="encrypted",distinct:!!tokenId&&!!passId&&tokenId!==passId,secretStorage:app.secretStorage.getSecret(tokenId)===d.token&&app.secretStorage.getSecret(passId)===d.passphrase,notPlaintext:!JSON.stringify(raw).includes(d.token)&&!JSON.stringify(raw).includes(d.passphrase),savedIds:saved?.githubTokenSecretId===tokenId&&saved?.encryptionPassphraseSecretId===passId,saveIdle:!p.settingsSaveInProgress};`);
 assert.equal(await guarded("await p.saveSettings({...p.settings,syncOnStartup:true});return p.settings.syncOnStartup;"),true);
 const prior=await checkSecrets();
 assert.ok(/^device-[a-f0-9]{32}$/u.test(prior.device)&&prior.matched&&prior.settings&&prior.distinct&&prior.secretStorage&&prior.notPlaintext&&prior.savedIds&&prior.saveIdle,"Expected exact persisted SecretStorage-backed settings");
 const waitStartup=async wanted=>{
  const deadline=Date.now()+180000;
  let state;
  while(Date.now()<deadline){
   state=await guarded("const s=p.v4Runtime.progressSnapshot;return {trigger:s.trigger,lifecycle:s.lifecycle,operation:s.operation,pending:p.v4Runtime.pendingCount,active:p.isSyncInProgress,lastSyncTime:s.lastSyncTime,diagnostics:s.diagnostics,error:s.errorMessage?.slice(0,240)};");
   if(state.trigger==="startup"&&!state.active&&["success","no-change","failed"].includes(state.lifecycle))break;
   await sleep(500);
  }
  assert.ok(state?.trigger==="startup"&&state.operation==="normal"&&state.lifecycle===wanted&&state.pending===0&&!state.active&&state.diagnostics?.apiFailures===0&&state.diagnostics?.uploadBytes===0,"Startup Sync did not meet expected terminal outcome: "+JSON.stringify(state));
  assert.deepEqual(await checkSecrets(),prior,"Settings or SecretStorage changed across restart");
  return state;
 };
 let oldPid,firstPid,secondPid,firstStartup,secondStartup,remoteHash,expectedSha;
 const peer=await runPeer({
  peerBinaryJourneys:[{path:target,size:2*1024*1024}],
  beforePeerBinary:async()=>{
   assert.equal((await readState()).sha,head.sha);
   oldPid=await lifecycle.stop(configuration.branch);
  },
  afterPeerBinary:async spec=>{
   assert.equal(lifecycle.pid(),"","Android restarted before peer publication");
   const remote=await readState();assert.ok(remote.kind==="present"&&remote.sha!==head.sha);expectedSha=remote.sha;remoteHash=spec.sha256;
   firstPid=await lifecycle.reopen(oldPid);
   firstStartup=await waitStartup("success");
   assert.deepEqual((await evaluateIdentity()).fileNames,expectedPaths);
   assert.equal(await guarded(`return app.vault.getAbstractFileByPath(${JSON.stringify(target)})?.stat?.size??null;`),spec.size);
   assert.equal(lifecycle.diskHash(target),spec.sha256);
   assert.equal((await readState()).sha,expectedSha);
   console.log(JSON.stringify({kind:"android-startup-pull",oldPid,firstPid,size:spec.size,sha256:spec.sha256,credentialPersistence:true,deviceIdUnchanged:true,headUnchanged:true,state:firstStartup}));
   assert.equal(await lifecycle.stop(configuration.branch),firstPid);
   secondPid=await lifecycle.reopen(firstPid);
   secondStartup=await waitStartup("no-change");
   assert.equal((await readState()).sha,expectedSha);
   assert.equal(lifecycle.diskHash(target),spec.sha256);
   assert.equal(lifecycle.diskHash("Assets/android-from-windows-32mib.bin"),"034c9f70be9932cb5d9f132df2a75b14bdd04e00136df5997ac07163ef757b63");
   assert.deepEqual((await evaluateIdentity()).fileNames,expectedPaths);
  }
 });
 assert.ok(peer.peerRestored&&firstStartup&&secondStartup&&oldPid!==firstPid&&firstPid!==secondPid);
 console.log(JSON.stringify({kind:"android-restart-complete",firstPid,secondPid,credentialPersistence:true,deviceIdUnchanged:true,sha256:remoteHash,startupPull:true,startupNoop:true,headUnchanged:true,state:secondStartup}));
}
