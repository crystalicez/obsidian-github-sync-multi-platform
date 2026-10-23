"use strict"
// Loaded ONLY into the process started by staged-external-termination.test.mjs.
// Patch this child process's Node fs metadata rename to pause immediately
// after the real syscall returns, until the parent externally terminates it.
const fs = require("node:fs")
const path = require("node:path")
const [, , mode, fixtureRoot, cutString] = process.argv
if (process.env.V4_EXTERNAL_KILL_FIXTURE !== "strict-disposable"
 || !["crash", "rollback-crash"].includes(mode)
 || !path.isAbsolute(fixtureRoot || "")
 || !path.resolve(fixtureRoot).includes("native-kill-d11-")
 || !["1", "2"].includes(cutString)) {
 throw new Error("Refusing external kill hook on unknown process or fixture")
}
const allowedRoot=path.resolve(fixtureRoot)+path.sep
const cut=Number(cutString)
const actual=fs.renameSync
let count=0
fs.renameSync=(from,to)=>{
 const fromPath=path.resolve(String(from))
 const toPath=path.resolve(String(to))
 if(!fromPath.startsWith(allowedRoot)||!toPath.startsWith(allowedRoot))
  throw new Error("External kill hook prevented rename outside disposable fixture")
 actual(from,to)
 count++
 if(count===cut){
  // This synchronous pipe write is the parent handshake. Atomics.wait
  // prevents any JS cleanup or second rename before TerminateProcess/SIGKILL.
  fs.writeSync(1,"EXTERNAL_PAUSE_AFTER_RENAME="+cut+"\n")
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,70000)
  throw new Error("External kill driver did not terminate its child")
 }
}
