// D502: real GitHub strict CAS, successful response withheld at requestUrl boundary.
import assert from "node:assert/strict";
import {randomBytes,createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
export async function runAndroidPublicationJourney({root,transport,name,guarded,configuration,head,readState,runPeer,runId,summary}){
 const file="Publication-"+runId+".md";
 const content="# D502 publication recovery\n\n"+randomBytes(32).toString("hex")+"\n";
 const sha256=createHash("sha256").update(content).digest("hex");
 const key=JSON.stringify("__obsidianD502_"+runId);
 const refName="refs/heads/"+configuration.branch;
 const prefix="https://api.github.com/repos/"+configuration.owner+"/"+configuration.repo+"/git/ref/heads/"+configuration.branch.split("/").map(encodeURIComponent).join("/");
 const opts={refName,branch:configuration.branch,expected:head.sha,prefix};
 let installed=false;
 const restore=()=>guarded(`const h=globalThis[${key}];if(!h||globalThis.__obsidianD501NativeRequest!==h.wrapper)throw Error("Unexpected test hook");delete globalThis.__obsidianD501NativeRequest;delete globalThis[${key}];return true;`);
 const observe=()=>guarded(`const h=globalThis[${key}];return {observed:h.observed,casCalls:h.casCalls,lost:h.lost,candidate:h.candidate,before:h.before,status:h.status,verifiedReads:h.verifiedReads,blockedReads:h.blockedReads,phase:h.phase};`);
 const sync=()=>guarded("const outcome=await p.v4Runtime.manualSync();"+summary,240000);
 const diskHash=()=>{const r=spawnSync("adb",["-t",String(transport),"shell","sha256sum","/sdcard/Documents/"+name+"/"+file],{cwd:root,encoding:"utf8",shell:false,timeout:30000});assert.equal(r.status,0);return r.stdout.trim().split(/\s+/u)[0];};
 try{
  assert.equal(await guarded(`const opts=${JSON.stringify(opts)};if(globalThis.__obsidianD501NativeRequest||p.settings.githubBranch!==opts.branch)throw Error("Unexpected hook state");const h={wrapper:null,observed:0,casCalls:0,lost:0,candidate:null,before:null,status:null,verifiedReads:0,blockedReads:0,phase:null,armed:false,blockReads:false};h.wrapper=async function(original,request){if(p.settings.githubBranch!==opts.branch||app.vault.getName()!==${JSON.stringify(name)})return original(request);h.observed++;const url=String(request.url);if(h.lost&&url.split("?")[0]===opts.prefix&&String(request.method??"GET").toUpperCase()==="GET"){if(h.blockReads){h.blockedReads++;throw Error("D502 simulated unavailable ref read");}const result=await original(request);if(result.status===200&&result.json?.object?.sha===h.candidate)h.verifiedReads++;return result;}if(!h.armed||url!=="https://api.github.com/graphql"||String(request.method).toUpperCase()!=="POST")return original(request);const body=JSON.parse(request.body??"{}");if(!String(body.query??"").includes("updateRefs(input:"))return original(request);const refs=body.variables?.input?.refUpdates;const ref=refs?.[0];if(refs?.length!==1||ref.name!==opts.refName||ref.beforeOid!==opts.expected||ref.force!==false||!/^[a-f0-9]{40}$/u.test(ref.afterOid)||ref.afterOid===opts.expected)throw Error("D502 CAS scope mismatch");h.casCalls++;if(h.casCalls!==1)throw Error("D502 refused duplicate CAS");h.candidate=ref.afterOid;h.before=ref.beforeOid;h.phase=p.v4Runtime.progressSnapshot.phase;const result=await original(request);if(result.status!==200||!result.json?.data?.updateRefs||result.json?.errors?.length)throw Error("D502 actual CAS not confirmed");h.status=result.status;h.lost++;throw Error("D502 simulated lost successful CAS response");};globalThis[${key}]=h;globalThis.__obsidianD501NativeRequest=h.wrapper;return true;`),true);installed=true;
  const baseline=await sync();assert.equal(baseline.lifecycle,"no-change");assert.ok((await observe()).observed>0);assert.equal((await readState()).sha,head.sha);
  assert.equal(await guarded(`if(app.vault.getAbstractFileByPath(${JSON.stringify(file)}))throw Error("Unexpected existing fixture");await app.vault.create(${JSON.stringify(file)},${JSON.stringify(content)});return true;`),true);
  assert.equal(diskHash(),sha256);
  // First exercise the difficult case: the CAS succeeds, but reconciliation reads fail too.
  assert.equal(await guarded(`globalThis[${key}].armed=true;globalThis[${key}].blockReads=true;return true;`),true);
  const uncertain=await sync();const fault=await observe();
  console.log(JSON.stringify({kind:"publication-confirmation-withheld",...fault,outcome:uncertain}));
  assert.ok(fault.casCalls===1&&fault.lost===1&&fault.status===200&&fault.before===head.sha&&fault.blockedReads>0&&fault.candidate,"Real CAS and unavailable readback not proven");
  assert.ok(uncertain.status==="failed"&&uncertain.lifecycle==="failed"&&uncertain.diagnostics?.apiFailures>0,"Expected uncertain publication failure");
  assert.equal((await readState()).sha,fault.candidate,"Actual remote ref differs from published candidate");
  assert.equal(diskHash(),sha256);
  assert.equal(await guarded(`globalThis[${key}].blockReads=false;return true;`),true);
  const recovered=await sync();const receipt=await observe();
  console.log(JSON.stringify({kind:"publication-normal-recovery",...receipt,outcome:recovered}));
  assert.ok(recovered.status==="completed"&&["success","no-change"].includes(recovered.lifecycle)&&recovered.diagnostics?.apiFailures===0,"Normal recovery did not succeed");
  assert.equal(receipt.casCalls,1);assert.ok(receipt.verifiedReads>0);
  assert.equal((await readState()).sha,fault.candidate,"Recovery changed already-published HEAD");
  assert.equal(diskHash(),sha256);
  assert.equal(await restore(),true);installed=false;
  const peer=await runPeer({expectedFiles:[{path:file,content}]});assert.ok(peer.peerRestored);
  const noop=await sync();assert.ok(noop.status==="completed"&&noop.lifecycle==="no-change"&&noop.changedFiles===0);assert.equal((await readState()).sha,fault.candidate);
  console.log(JSON.stringify({kind:"publication-recovery-complete",file,sha256,candidate:fault.candidate,before:head.sha,successfulCas:1,withheldResponse:true,readbackUnavailable:true,normalRecovery:true,duplicateCommit:false,peerVerified:true,finalNoop:true}));
 }finally{if(installed)assert.equal(await restore(),true);}
}
