import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";

// One canonical fixture list is used for both creation and independent peer verification.
export function createNativeBulkNotes() {
 return Array.from({length:1000},(_,i)=>({
  path:"Bulk/note-"+String(i).padStart(4,"0")+".md",
  content:"# Bulk "+i+"\n\n"+"x".repeat(480)+"\n",
 }));
}

export function selectNativePeerFiles({journey,journeyFiles,bulkFiles,restartFiles}) {
 return [...(journey?journeyFiles:[]),...bulkFiles,...restartFiles];
}

export async function verifyNativeBulkDisk(vault,expectedFiles) {
 const bulkFiles=expectedFiles.filter(item=>item.path.startsWith("Bulk/"));
 if(!bulkFiles.length)return;
 for(const item of bulkFiles)assert.match(item.path,/^Bulk\/note-[0-9]{4}\.md$/u,"Unexpected synthetic bulk path");
 const directory=path.join(vault,"Bulk");
 const diskNames=await readdir(directory);
 assert.deepEqual(diskNames.sort(),bulkFiles.map(item=>item.path.slice(5)).sort(),"Second Obsidian bulk disk inventory differs");
 for(const item of bulkFiles){
  const actual=await readFile(path.join(directory,item.path.slice(5)));
  assert.deepEqual(actual,Buffer.from(item.content,"utf8"),"Second Obsidian bulk disk bytes differ: "+item.path);
 }
}

export function parseLiveUiMode(value) {
 const mode=value===undefined?"plaintext":value;
 assert.ok(mode==="plaintext"||mode==="encrypted","Live UI --mode must be exactly plaintext or encrypted");
 return mode;
}

export function assertEncryptedRemoteTree(tree,{logicalPaths}={}) {
 assert.ok(Array.isArray(tree),"Encrypted GitHub tree must be an array");
 const paths=tree.map(entry=>entry?.path).filter(path=>typeof path==="string");
 assert.ok(paths.includes(".obsidian-github-sync-v4/config.json"),"Encrypted GitHub protocol config is missing");
 assert.ok(paths.includes(".obsidian-github-sync-v4/head"),"Encrypted GitHub protocol head is missing");
 for(const logicalPath of logicalPaths??[]) {
  assert.ok(typeof logicalPath==="string" && logicalPath.length>0,"Invalid expected synthetic path");
  assert.ok(!paths.some(path=>path===logicalPath||path.endsWith("/"+logicalPath)),"Encrypted GitHub tree leaked plaintext logical filename");
 }
 assert.ok(paths.some(path=>/^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(path)),"Encrypted GitHub tree has no opaque ciphertext data objects");
 return {treePathCount:paths.length,opaqueDataPresent:true};
}
