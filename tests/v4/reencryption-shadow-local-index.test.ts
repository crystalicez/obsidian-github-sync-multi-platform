import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import {
  createEmptyV4LocalIndex, isV4LocalIndexCacheComplete, loadV4LocalIndex,
  saveV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { stageV4ReencryptionShadowLocalIndex } from "../../src/lib/v4/reencryption-shadow-local-index"

const source = "owner/vault#main"
const dest = "owner/vault#rekey/2026-10-28"
const sha = "b".repeat(40)
const oldCommit = "a".repeat(40)
const active = "plugin-private/v4-index"
const runId = "run_12345678"
const staged = active + "-rekey-" + runId
const id = "device1"

function index(repoId: string, remoteCommitSha: string): V4LocalIndex {
  const value = createEmptyV4LocalIndex({ repoId, deviceId: id, mode: "encrypted" })
  value.remoteCommitSha = remoteCommitSha
  const bucket = "aa"
  const pathId = bucket + "0".repeat(62)
  value.shards[bucket] = {
    bucket, hash: "remote-shard-hash-" + remoteCommitSha.slice(0, 6),
    records: {
      [pathId]: {
        path: "Note.md", pathId, fileId: "file-1", plaintextSha256: "f".repeat(64),
        size: 4, mtime: 10, remoteVersion: remoteCommitSha,
        remotePath: ".obsidian-github-sync-v4/data/aa/" + pathId + ".enc", storage: "single",
      },
    },
  }
  value.shardHashes[bucket] = value.shards[bucket]!.hash
  return value
}
function store() {
  const files = new Map<string,string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  let failAtWrite = 0
  const adapter: V4LocalIndexAdapter = {
    async read(path) { const value=files.get(path); if(value===undefined) throw Error("no test file"); return value },
    async write(path,text) {
      writes.push(path)
      if (failAtWrite > 0 && writes.length === failAtWrite) throw Error("injected partial staged-index write")
      files.set(path,text)
    },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
  }
  return {
    files, dirs, writes, adapter,
    failAt(writeNumber: number) { failAtWrite=writeNumber },
    input: (destinationIndex = index(dest,sha)) => ({
      adapter, activeRoot: active, runId, destinationIndex, expectedDestinationRepoId: dest,
      expectedDestinationCommitSha: sha, expectedDeviceId: id,
      assertInitiatorQuiescent: async () => {},
      assertCrashDurable: async () => {},
    }),
  }
}

test("D134 stages independent destination index and re-reads full shards, never changes active or grants cutover/cleanup", async () => {
  const s=store()
  const old=index(source,oldCommit)
  await saveV4LocalIndex(s.adapter,active,old)
  const oldFiles = new Map([...s.files].filter(([p])=>p.startsWith(active+"/")))
  const before=s.writes.length
  const fresh=index(dest,sha)
  const result=await stageV4ReencryptionShadowLocalIndex(s.input(fresh))
  assert.deepEqual(result, {
    status: "shadow-index-staged-uncommitted",
    stagingRoot: staged, destinationRepoId: dest, destinationCommitSha: sha,
    localCutoverAuthorized:false, resumeSyncAuthorized:false, oldPassphraseCleanupAuthorized:false,
  })
  assert.deepEqual([...s.files].filter(([p])=>p.startsWith(active+"/")), [...oldFiles])
  assert.ok(s.writes.slice(before).every(path=>path.startsWith(staged+"/")))
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
  const loaded=await loadV4LocalIndex(s.adapter,staged)
  assert.equal(loaded.repoId,dest)
  assert.equal(loaded.remoteCommitSha,sha)
  assert.ok(isV4LocalIndexCacheComplete(loaded))
  assert.equal(fresh.shards.aa!.contentDigest,undefined,"do not modify caller-owned source structures")
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(s.input()),/existing|occupied/i)
})

test("D134 each shadow write crash leaves old index fully readable and blocks unsafe replay",async()=>{
  for(const failAfter of [1,2]){
    const s=store()
    await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
    const oldFiles=new Map([...s.files].filter(([p])=>p.startsWith(active+"/")))
    s.writes.length=0
    s.failAt(failAfter)
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(s.input()),/injected partial staged-index write/)
    assert.deepEqual([...s.files].filter(([p])=>p.startsWith(active+"/")), [...oldFiles])
    const old=await loadV4LocalIndex(s.adapter,active)
    assert.equal(old.repoId,source)
    assert.equal(old.remoteCommitSha,oldCommit)
    assert.ok(isV4LocalIndexCacheComplete(old))
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(s.input()),/existing|occupied/i)
  }
})

test("D134 refused lease, durability error and corrupted staged readback cannot grant success",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  const initial=s.writes.length
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex({
    ...s.input(),assertInitiatorQuiescent:async()=>{throw Error("another settings writer active")},
  }),/settings writer/)
  assert.equal(s.writes.length,initial)
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex({
    ...s.input(),assertCrashDurable:async()=>{throw Error("directory fsync EPERM")},
  }),/EPERM/)
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
})

test("D134 readback rejects substituted shard content even with self-consistent SHA256 and unchanged remote shard label",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  const original=s.input()
  const reportInput = {
    ...original,
    adapter: {
      ...original.adapter,
      async read(path:string) {
        const raw=await original.adapter.read(path)
        if (!path.startsWith(staged+"/shards/")) return raw
        const shard=JSON.parse(raw) as {
          bucket:string; contentDigest:string; records: Record<string, {path:string}>
        }
        const key=Object.keys(shard.records)[0]!
        shard.records[key]!.path="Forged-note.md"
        shard.contentDigest=createHash("sha256")
          .update("v4-local-shard:"+shard.bucket+":"+JSON.stringify(shard.records))
          .digest("hex")
        return JSON.stringify(shard)
      },
    },
  }
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(reportInput),/strict readback|changed|digest/i)
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
})

test("D134 mutation of caller-owned candidate and run identity during awaited lease fails closed",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  const mutable=s.input()
  const sourceCandidate=mutable.destinationIndex
  let changed=false
  const input={
    ...mutable,
    assertInitiatorQuiescent:async()=>{
      if(!changed){
        changed=true
        sourceCandidate.shards.aa!.records["aa"+"0".repeat(62)]!.path="Mutated-note.md"
      }
    },
  }
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(input),/changed|mutation|readback/i)
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
})

test("D134 overlapping same-run staging cannot pass even when two callers see an initially absent directory",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  let enter!: () => void
  let release!: () => void
  const entered=new Promise<void>(resolve=>{enter=resolve})
  const held=new Promise<void>(resolve=>{release=resolve})
  let firstLease=true
  const first=stageV4ReencryptionShadowLocalIndex({
    ...s.input(),
    assertInitiatorQuiescent:async()=>{
      if(firstLease){firstLease=false;enter();await held}
    },
  })
  await entered
  const writesBefore=s.writes.length
  try{
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(s.input()),/Concurrent|active|already/i)
    assert.equal(s.writes.length,writesBefore,"second caller must not write its own staging files")
  }finally{release()}
  const result=await first
  assert.equal(result.localCutoverAuthorized,false)
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
})

test("D134 a write that persists staged bytes then loses acknowledgement must not be retried",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  const original=s.adapter
  let intercepted=false
  const adapter:V4LocalIndexAdapter={
    ...original,
    async write(path,value){
      await original.write(path,value)
      if(path.startsWith(staged+"/")&&!intercepted){
        intercepted=true
        throw Error("lost index write acknowledgement")
      }
    },
  }
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex({...s.input(),adapter}),/lost index write acknowledgement/)
  assert.equal(intercepted,true)
  assert.equal((await loadV4LocalIndex(original,active)).repoId,source)
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex(s.input()),/existing|occupied|recovery/i)
})

test("D134 mutating caller candidate after shard write never certifies the completed staging readback",async()=>{
  const s=store()
  await saveV4LocalIndex(s.adapter,active,index(source,oldCommit))
  const original=s.input()
  let changed=false
  const candidate=original.destinationIndex
  const adapter:V4LocalIndexAdapter={
    ...original.adapter,
    async write(path,value){
      await original.adapter.write(path,value)
      if(!changed&&path.startsWith(staged+"/shards/")){
        changed=true
        candidate.shards.aa!.records["aa"+"0".repeat(62)]!.size=999
      }
    },
  }
  await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex({
    ...original,adapter,destinationIndex:candidate,
  }),/candidate changed|identity changed/i)
  assert.equal(changed,true)
  assert.equal((await loadV4LocalIndex(s.adapter,active)).repoId,source)
})

test("D134 refuses source/incorrect-index/dirty-files/bad scope/run before any writes",async()=>{
  const s=store()
  const candidate=index(dest,sha)
  const dirty=index(dest,sha)
  dirty.shards.aa!.records["aa"+"0".repeat(62)]!.dirty=true
  for(const bad of [
    {destinationIndex:index(source,oldCommit)},
    {destinationIndex:index(dest,"d".repeat(40))},
    {destinationIndex:dirty},
    {expectedDestinationRepoId:source},
    {expectedDestinationRepoId:"owner/vault#rekey/../escape",
      destinationIndex:index("owner/vault#rekey/../escape",sha)},
    {expectedDestinationCommitSha:"HEAD"},
    {expectedDeviceId:"wrong"},
    {runId:"../escape"},
    {activeRoot:"../outside"},
    {activeRoot:"singleRoot"},
    {assertCrashDurable:undefined as never},
    {assertInitiatorQuiescent:undefined as never},
  ]){
    const before=s.writes.length
    await assert.rejects(()=>stageV4ReencryptionShadowLocalIndex({...s.input(candidate),...bad}))
    assert.equal(s.writes.length,before)
  }
})
