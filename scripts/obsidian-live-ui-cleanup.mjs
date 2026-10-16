import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import path from "node:path";

const RETRYABLE_WINDOWS_CODES=new Set(["EBUSY","EPERM","EACCES","ENOTEMPTY"]);

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
