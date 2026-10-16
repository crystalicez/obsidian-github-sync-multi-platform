import assert from "node:assert/strict";
import test from "node:test";
import {parseLiveUiMode,assertEncryptedRemoteTree} from "../../scripts/obsidian-live-ui-mode.mjs";

test("live UI modes fail closed instead of silently falling back to plaintext",()=>{
 assert.equal(parseLiveUiMode(undefined),"plaintext");
 assert.equal(parseLiveUiMode("plaintext"),"plaintext");
 assert.equal(parseLiveUiMode("encrypted"),"encrypted");
 for(const input of ["", "encrypt", "Encrypted", "plain", "off", "../main"]) {
  assert.throws(()=>parseLiveUiMode(input),/mode|plaintext|encrypted/iu);
 }
});
test("encrypted remote tree has protocol metadata and opaque encrypted objects with no logical filename",()=>{
 const tree=[{type:"blob",path:".obsidian-github-sync-v4/config.json"},
  {type:"blob",path:".obsidian-github-sync-v4/head"},
  {type:"blob",path:".obsidian-github-sync-v4/data/ab/"+"b".repeat(64)+".enc"}];
 assert.doesNotThrow(()=>assertEncryptedRemoteTree(tree,{logicalPaths:["UI-smoke.md"]}));
});
test("encrypted remote acceptance refuses missing ciphertext and any plaintext filename leak",()=>{
 const metadata=[{type:"blob",path:".obsidian-github-sync-v4/config.json"},{type:"blob",path:".obsidian-github-sync-v4/head"}];
 assert.throws(()=>assertEncryptedRemoteTree(metadata,{logicalPaths:["UI-smoke.md"]}),/encrypted|opaque|ciphertext/iu);
 assert.throws(()=>assertEncryptedRemoteTree([...metadata,{type:"blob",path:"UI-smoke.md"},{type:"blob",path:".obsidian-github-sync-v4/data/ab/"+"b".repeat(64)+".enc"}],{logicalPaths:["UI-smoke.md"]}),/plaintext|leak/iu);
});
