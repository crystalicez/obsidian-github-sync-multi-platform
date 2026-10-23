import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import path from "node:path";

const RETRYABLE_WINDOWS_CODES=new Set(["EBUSY","EPERM","EACCES","ENOTEMPTY"]);

// The UI harness creates screenshot evidence outside its disposable vault.
// Remove only two exact files derived from the *same* validated random runId.
// Do not recursively remove this directory: another test session may own
// unrelated screenshots and we must never erase another run's evidence.
export async function cleanupGeneratedUiEvidence(runRoot,{
 repoRoot,remove=rm,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
 maxAttempts=16,retryDelayMs=1250,
}={}){
 assert.ok(repoRoot && typeof repoRoot==="string","Evidence cleanup requires an exact repository root");
 assert.ok(Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=30,"Invalid evidence cleanup retry budget");
 const expectedParent=path.resolve(repoRoot,".tmp","obsidian-live-github-e2e");
 const candidate=path.resolve(runRoot);
 assert.ok(path.dirname(candidate)===expectedParent&&/^[0-9a-f]{16}$/u.test(path.basename(candidate)),
  "Refusing to remove evidence for an untrusted synthetic UI run path");
 const runId=path.basename(candidate);
 const evidenceRoot=path.resolve(repoRoot,".tmp","obsidian-live-github-e2e-evidence");
 for(const suffix of ["-sync-center.png","-peer-restored.png"]){
  const exact=path.join(evidenceRoot,runId+suffix);
  for(let attempt=1;attempt<=maxAttempts;attempt++){
   try{
    await remove(exact,{force:true,maxRetries:2,retryDelay:250});
    break;
   }catch(error){
    if(!RETRYABLE_WINDOWS_CODES.has(error?.code)||attempt===maxAttempts)throw error;
    await wait(retryDelayMs);
   }
  }
 }
}


export async function cleanupGeneratedUiRun(target,{
 repoRoot,remove=rm,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
 maxAttempts=16,retryDelayMs=1250,
}={}){
 assert.ok(repoRoot && typeof repoRoot==="string","Cleanup requires an exact repository root");
 assert.ok(Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=30,"Invalid cleanup retry budget");
 const expectedParent=path.resolve(repoRoot,".tmp","obsidian-live-github-e2e");
 const candidate=path.resolve(target);
 assert.ok(path.dirname(candidate)===expectedParent&&/^[0-9a-f]{16}$/u.test(path.basename(candidate)),
  "Refusing to remove a path outside a uniquely named synthetic disposable UI test directory");
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  try{
   await remove(candidate,{recursive:true,force:true,maxRetries:2,retryDelay:250});
   return;
  }catch(error){
   if(!RETRYABLE_WINDOWS_CODES.has(error?.code)||attempt===maxAttempts)throw error;
   await wait(retryDelayMs);
  }
 }
}
