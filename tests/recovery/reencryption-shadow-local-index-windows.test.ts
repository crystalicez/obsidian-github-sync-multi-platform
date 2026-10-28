import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import {
  createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex,
  type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { stageV4ReencryptionShadowLocalIndex } from "../../src/lib/v4/reencryption-shadow-local-index"

const source="owner/repo#main"
const dest="owner/repo#rekey/test"
const oldSha="a".repeat(40)
const newSha="b".repeat(40)
const active="private/current-index"
const runId="winrun123456"
const staged=active+"-rekey-"+runId

test("D134 real Windows: failed shadow header write preserves on-disk active index and blocks reuse",{
  skip:process.platform!=="win32",
},async()=>{
  const root=await mkdtemp(join(process.cwd(),".tmp","d134-shadow-"))
  const absolute=(path:string)=>{
    const found=resolve(root,path.replaceAll("/",sep))
    if(!found.startsWith(root+sep)) throw Error("outside disposable test root")
    return found
  }
  let failPath=""
  const adapter: V4LocalIndexAdapter={
    async exists(path) {
      try { await stat(absolute(path)); return true }
      catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT") return false; throw e}
    },
    async mkdir(path){await mkdir(absolute(path),{recursive:true})},
    async write(path,value) {
      if(path===failPath) throw Error("injected physical shadow header failure")
      await writeFile(absolute(path),value,"utf8")
    },
    async read(path){return readFile(absolute(path),"utf8")},
  }
  const make=(repoId:string,sha:string)=>{
    const v=createEmptyV4LocalIndex({repoId,deviceId:"device1",mode:"encrypted"})
    v.remoteCommitSha=sha
    const pathId="aa"+"0".repeat(62)
    v.shards.aa={bucket:"aa",hash:"remote-hash-"+sha.slice(0,4),records:{
      [pathId]:{
        path:"Note.md",pathId,fileId:"file1",plaintextSha256:"f".repeat(64),
        size:4,mtime:10,remoteVersion:sha,
        remotePath:".obsidian-github-sync-v4/data/aa/"+pathId+".enc",storage:"single",
      },
    }}
    v.shardHashes.aa=v.shards.aa.hash
    return v
  }
  try {
    await saveV4LocalIndex(adapter,active,make(source,oldSha))
    const beforeHeader=await readFile(absolute(active+"/index.json"))
    const beforeShard=await readFile(absolute(active+"/shards/aa.json"))
    failPath=staged+"/index.json"
    const candidate=make(dest,newSha)
    const input={
      adapter,activeRoot:active,runId,destinationIndex:candidate,
      expectedDestinationRepoId:dest,expectedDestinationCommitSha:newSha,expectedDeviceId:"device1",
      assertInitiatorQuiescent:async()=>{},
      assertCrashDurable:async()=>{},
    }
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(input),/injected physical/)
    assert.deepEqual(await readFile(absolute(active+"/index.json")),beforeHeader)
    assert.deepEqual(await readFile(absolute(active+"/shards/aa.json")),beforeShard)
    assert.equal((await loadV4LocalIndex(adapter,active)).repoId,source)
    assert.equal((await loadV4LocalIndex(adapter,active)).remoteCommitSha,oldSha)
    assert.equal(await adapter.exists(staged),true)
    failPath=""
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(input),/existing|occupied/i)
    const fresh={...input,runId:"winrun234567"}
    const result=await stageV4ReencryptionShadowLocalIndex(fresh)
    assert.equal(result.localCutoverAuthorized,false)
    assert.equal(result.oldPassphraseCleanupAuthorized,false)
    assert.equal((await loadV4LocalIndex(adapter,active)).repoId,source)
    assert.equal((await loadV4LocalIndex(adapter,active+"-rekey-"+fresh.runId)).repoId,dest)
  } finally {
    await rm(root,{force:true,recursive:true})
  }
})
