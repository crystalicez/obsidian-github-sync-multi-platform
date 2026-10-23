import assert from "node:assert/strict";

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
