// Native HTTP boundary fault injection on the exact disposable Vault.
// Actual TCP handshake interruption via ADB reverse; NOT a real GitHub socket cut.
// Never send GitHub credentials or fixture bytes to the fault sink.
import assert from "node:assert/strict";
import net from "node:net";
import {spawnSync} from "node:child_process";
import {randomBytes,createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function runAndroidNetworkJourney({root,transport,name,guarded,configuration,head,readState,runPeer,runRoot,runId,summary}){
 const adb=args=>{const out=spawnSync("adb",["-t",String(transport),...args],{cwd:root,encoding:"utf8",shell:false,timeout:120000});assert.equal(out.status,0,"Scoped ADB operation failed");return out.stdout.trim();};
 const file="Assets/android-network-"+runId+".bin";
 const size=8*1024*1024;
 const fixture=randomBytes(size);
 const sha256=createHash("sha256").update(fixture).digest("hex");
 const deviceFile="/sdcard/Documents/"+name+"/"+file;
 const diskHash=()=>adb(["shell","sha256sum",deviceFile]).split(/\s+/u)[0];
 const sockets=new Set();let accepted=0,handshakeBytes=0,reversePort,installed=false;
 const sink=net.createServer(socket=>{
  accepted++;sockets.add(socket);
  socket.on("error",()=>socket.destroy());
  socket.once("close",()=>sockets.delete(socket));
  socket.setTimeout(1500,()=>socket.destroy());
  socket.once("data",bytes=>{handshakeBytes+=bytes.byteLength;socket.destroy();});
 });
 const hookKey="__obsidianD501_"+runId;
 const key=JSON.stringify(hookKey);
 const restore=async()=>guarded(`const h=globalThis[${key}];if(!h)return false;if(globalThis.__obsidianD501NativeRequest!==h.wrapper)throw Error("Unexpected test hook replacement");delete globalThis.__obsidianD501NativeRequest;delete globalThis[${key}];return true;`);
 try{
  await new Promise((resolve,reject)=>{sink.once("error",reject);sink.listen(0,"127.0.0.1",resolve);});
  const addr=sink.address();assert.ok(addr&&typeof addr!=="string");
  reversePort=Number(adb(["reverse","tcp:0","tcp:"+addr.port]));assert.ok(Number.isInteger(reversePort)&&reversePort>1024&&reversePort<=65535);
  const options={prefix:"https://api.github.com/repos/"+configuration.owner+"/"+configuration.repo+"/",branch:configuration.branch,file,faultUrl:"https://127.0.0.1:"+reversePort+"/d501"};
  const hookInstalled=await guarded(`const opts=${JSON.stringify(options)};if(globalThis[${key}]||globalThis.__obsidianD501NativeRequest||p.settings.githubBranch!==opts.branch)throw Error("Unexpected test hook state");const h={wrapper:null,blocked:false,observed:0,blobs:0,redirects:0,nativeRejections:0,unexpectedSuccess:0,phaseAtFault:null};h.wrapper=function(original,request){const matches=request&&typeof request.url==="string"&&request.url.startsWith(opts.prefix)&&p.settings.githubBranch===opts.branch&&app.vault.getName()===${JSON.stringify(name)};if(!matches)return original(request);h.observed++;const blob=request.url===opts.prefix+"git/blobs"&&String(request.method??"GET").toUpperCase()==="POST";if(blob)h.blobs++;if(!blob||!h.blocked)return original(request);h.redirects++;const s=p.v4Runtime.progressSnapshot;h.phaseAtFault={phase:s.phase,path:s.currentPath,active:p.isSyncInProgress};return Promise.resolve(original({url:opts.faultUrl,method:"GET",headers:{},throw:true})).then(()=>{h.unexpectedSuccess++;throw Error("Fault sink unexpectedly returned HTTP response");},error=>{h.nativeRejections++;throw error;});};globalThis[${key}]=h;globalThis.__obsidianD501NativeRequest=h.wrapper;return globalThis.__obsidianD501NativeRequest===h.wrapper;`);
  assert.equal(hookInstalled,true);installed=true;
  const observe=()=>guarded(`const h=globalThis[${key}];return {observed:h.observed,blobs:h.blobs,redirects:h.redirects,nativeRejections:h.nativeRejections,unexpectedSuccess:h.unexpectedSuccess,phaseAtFault:h.phaseAtFault};`);
  const baseline=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  const seen=await observe();
  console.log(JSON.stringify({kind:"android-transport-route",observed:seen.observed,baseline:baseline.lifecycle}));
  assert.ok(baseline.status==="completed"&&baseline.lifecycle==="no-change"&&seen.observed>0,"Test-only requestUrl hook route not observed; cannot safely inject fault");
  assert.equal((await readState()).sha,head.sha);
  await writeFile(path.join(runRoot,"android-network-fixture.bin"),fixture,{flag:"wx"});
  assert.equal(await guarded(`return app.vault.getAbstractFileByPath(${JSON.stringify(file)})??null;`),null);
  adb(["push",path.join(runRoot,"android-network-fixture.bin"),deviceFile]);
  const deadline=Date.now()+45000;let indexed=false;
  while(Date.now()<deadline&&!indexed){indexed=await guarded(`return app.vault.getAbstractFileByPath(${JSON.stringify(file)})?.stat?.size===${size};`);if(!indexed)await sleep(300);}
  assert.ok(indexed);assert.equal(diskHash(),sha256);
  assert.equal(await guarded(`globalThis[${key}].blocked=true;return globalThis[${key}].blocked;`),true);
  const failed=await guarded("const outcome=await p.v4Runtime.manualSync();const s=p.v4Runtime.progressSnapshot;return {status:outcome?.status,lifecycle:s.lifecycle,changedFiles:outcome?.changedFiles,phase:s.failurePhase,path:s.failurePath,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused,diagnostics:s.diagnostics,error:s.errorMessage?.slice(0,180)};",240000);
  const fault=await observe();
  console.log(JSON.stringify({kind:"android-native-transport-fault",...fault,tcpConnections:accepted,handshakeBytes,outcome:failed}));
  assert.ok(fault.redirects>0&&fault.nativeRejections===fault.redirects&&fault.unexpectedSuccess===0&&accepted>0&&handshakeBytes>0,"No verified native TCP transport rejection");
  assert.ok(fault.phaseAtFault?.active&&fault.phaseAtFault.phase==="uploading"&&fault.phaseAtFault.path===file,"Fault was not during intended upload");
  assert.ok(failed.status==="failed"&&failed.lifecycle==="failed"&&failed.changedFiles===0&&failed.paused&&failed.diagnostics?.apiFailures>0&&failed.diagnostics?.inFlightApiRequests===0,"Native transport fault did not fail safely");
  assert.equal((await readState()).sha,head.sha);assert.equal(diskHash(),sha256);
  assert.equal(await restore(),true);installed=false;
  const recovered=await guarded("const outcome=await p.v4Runtime.manualSync();const s=p.v4Runtime.progressSnapshot;return {status:outcome?.status,lifecycle:s.lifecycle,changedFiles:outcome?.changedFiles,paused:p.v4Runtime.coordinator.isAutomaticSyncPaused,diagnostics:s.diagnostics,error:s.errorMessage?.slice(0,180)};",240000);
  console.log(JSON.stringify({kind:"android-transport-recovery",outcome:recovered}));
  assert.ok(recovered.status==="completed"&&recovered.lifecycle==="success"&&recovered.changedFiles>0&&!recovered.paused&&recovered.diagnostics?.apiFailures===0);
  const advanced=await readState();assert.ok(advanced.kind==="present"&&advanced.sha!==head.sha);
  assert.equal(diskHash(),sha256);
  const peer=await runPeer({expectedBinary:{path:file,size,sha256}});
  assert.ok(peer.peerRestored);
  const noop=await guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
  assert.ok(noop.status==="completed"&&noop.lifecycle==="no-change"&&noop.changedFiles===0);
  assert.equal((await readState()).sha,advanced.sha);
  console.log(JSON.stringify({kind:"android-transport-complete",nativeFaultInjection:true,instrumentedTestBundle:true,actualGitHubSocketCut:false,size,sha256,file,sourcePreserved:true,headUnchangedDuringFailure:true,autoResumed:true,peerVerified:true,finalNoop:true}));
 }finally{
  if(installed)assert.equal(await restore(),true);
  try{if(reversePort)adb(["reverse","--remove","tcp:"+reversePort]);}finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>sink.close(resolve));}
 }
}
