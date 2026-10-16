import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {cleanupGeneratedUiRun} from "../../scripts/obsidian-live-ui-cleanup.mjs";

const repo=path.resolve("test-repo");
const target=path.join(repo,".tmp","obsidian-live-github-e2e","abcdef0123456789");

test("synthetic UI cleanup retries Windows EBUSY/EPERM locks and verifies scoped rm",async()=>{
 const calls=[];
 await cleanupGeneratedUiRun(target,{repoRoot:repo,maxAttempts:4,
  remove:async(p,opts)=>{calls.push({p,opts});if(calls.length<3)throw Object.assign(Error("busy"),{code:calls.length===1?"EBUSY":"EPERM"});},
  wait:async()=>{}});
 assert.equal(calls.length,3);
 assert.ok(calls.every(c=>c.p===target&&c.opts.recursive===true&&c.opts.force===true));
});
test("synthetic UI cleanup refuses any path not created below a project-local run directory",async()=>{
 for(const bad of [repo,path.join(repo,".tmp","obsidian-live-github-e2e"),path.join(repo,".tmp","other","abcdef0123456789"),path.join(repo,".tmp","obsidian-live-github-e2e","..","different")]){
  await assert.rejects(()=>cleanupGeneratedUiRun(bad,{repoRoot:repo,remove:async()=>assert.fail("must not delete")}),/disposable|synthetic|scoped|path/iu);
 }
});
test("persistent Windows file lock or unrecognized IO error does not silently pass",async()=>{
 await assert.rejects(()=>cleanupGeneratedUiRun(target,{repoRoot:repo,maxAttempts:2,remove:async()=>{throw Object.assign(Error("locked"),{code:"EBUSY"})},wait:async()=>{}}),/locked/u);
 await assert.rejects(()=>cleanupGeneratedUiRun(target,{repoRoot:repo,maxAttempts:5,remove:async()=>{throw Object.assign(Error("denied"),{code:"EINVAL"})},wait:async()=>{}}),/denied/u);
});
