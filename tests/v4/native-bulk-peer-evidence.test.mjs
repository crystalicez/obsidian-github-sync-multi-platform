import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import {createNativeBulkNotes,selectNativePeerFiles,verifyNativeBulkDisk} from "../../scripts/obsidian-live-ui-mode.mjs";

test("bulk-only peer acceptance includes all 1000 unique notes without journey",()=>{
 const bulkFiles=createNativeBulkNotes();
 const journeyFiles=[{path:"journey.md",content:"journey"}];
 const restartFiles=[{path:"restart.md",content:"restart"}];
 assert.equal(bulkFiles.length,1000);
 assert.equal(new Set(bulkFiles.map(f=>f.path)).size,1000);
 assert.equal(bulkFiles[0].path,"Bulk/note-0000.md");
 assert.equal(bulkFiles[999].path,"Bulk/note-0999.md");
 assert.equal(bulkFiles[999].content,"# Bulk 999\n\n"+"x".repeat(480)+"\n");
 assert.deepEqual(selectNativePeerFiles({journey:false,journeyFiles,bulkFiles,restartFiles:[]}),bulkFiles);
 assert.deepEqual(selectNativePeerFiles({journey:true,journeyFiles,bulkFiles,restartFiles}),[...journeyFiles,...bulkFiles,...restartFiles]);
 assert.deepEqual(selectNativePeerFiles({journey:false,journeyFiles,bulkFiles:[],restartFiles}),restartFiles);
});

test("native bulk disk check rejects missing, extra and corrupted notes",async()=>{
 const scratch=path.resolve(".tmp");
 await mkdir(scratch,{recursive:true});
 const vault=await mkdtemp(path.join(scratch,"bulk-peer-evidence-"));
 try{
  const files=createNativeBulkNotes().slice(0,3);
  await mkdir(path.join(vault,"Bulk"));
  for(const f of files)await writeFile(path.join(vault,f.path),f.content);
  await verifyNativeBulkDisk(vault,files);
  await rm(path.join(vault,files[0].path));
  await assert.rejects(verifyNativeBulkDisk(vault,files),/inventory differs/);
  await writeFile(path.join(vault,files[0].path),files[0].content);
  const extra=path.join(vault,"Bulk","extra.md");
  await writeFile(extra,"extra");
  await assert.rejects(verifyNativeBulkDisk(vault,files),/inventory differs/);
  await rm(extra);
  await writeFile(path.join(vault,files[1].path),"corrupt");
  await assert.rejects(verifyNativeBulkDisk(vault,files),/disk bytes differ/);
 }finally{await rm(vault,{recursive:true,force:true});}
});
