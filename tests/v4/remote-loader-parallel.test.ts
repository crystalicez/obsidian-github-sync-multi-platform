import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { buildV4RemoteMetadata, v4RemoteShardPath } from "../../src/lib/v4/remote-index"
import { loadV4RemoteState } from "../../src/lib/v4/remote-loader"
import { hashV4ShardRecords } from "../../src/lib/v4/shard-hash"
import { V4_HEAD_PATH, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types"

const config: V4RemoteConfig = {
  formatVersion: 4, mode: "plaintext", repoId: "sample/vault#main", pathLayout: "plaintext-v1",
}

async function fixture() {
  const records = await Promise.all(["Note-1.md", "Note-2.md", "Note-3.md"].map(async (path, n) => ({
    path,
    pathId: await sha256Hex(new TextEncoder().encode(`path:${path}`)),
    fileId: `file-${n}`, plaintextSha256: "a".repeat(64), size: 1, mtime: n + 1,
    remoteVersion: "journal-1", remotePath: path, storage: "single" as const,
  })))
  const buckets = records.map(record => record.pathId.slice(0, 2)).sort()
  assert.equal(new Set(buckets).size, 3, "Fixture needs three independent remote shards")
  const shardHashes: Record<string,string> = {}
  for(const record of records) shardHashes[record.pathId.slice(0,2)] = await hashV4ShardRecords([record])
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "plaintext", epoch: 1, generation: 1, journalId: "journal-1",
    shardHashes, updatedAt: 100, deviceId: "device-1",
  }
  const files = new Map((await buildV4RemoteMetadata({ config, head, records })).map(file => [file.path, file.bytes]))
  const index = createEmptyV4LocalIndex({
    repoId: config.repoId, deviceId: "receiver", mode: config.mode, pathLayout: config.pathLayout,
  })
  return { records, buckets, files, index }
}

test("cold remote metadata can fetch two shards concurrently and still returns verified order", async () => {
  const { records, buckets, files, index } = await fixture()
  const seen: string[] = []
  const first = v4RemoteShardPath(buckets[0], config.mode)
  const second = v4RemoteShardPath(buckets[1], config.mode)
  let unblockFirst!: () => void
  const blocked = new Promise<void>(resolve => { unblockFirst = resolve })
  const github = { async getFileBytes(path: string) {
    seen.push(path)
    if (path === first) await blocked
    const bytes = files.get(path)
    return bytes ? { bytes, sha: "a".repeat(40) } : null
  } }
  const job = loadV4RemoteState({ github, index, maxConcurrentShardReads: 2 }, "commit-1", config)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(seen.slice(0, 3), [V4_HEAD_PATH, first, second])
  } finally {
    unblockFirst()
  }
  const result = await job
  assert.deepEqual(result?.records.map(r => r.path).sort(), records.map(r => r.path).sort())
  assert.equal(result?.commitSha, "commit-1")
  assert.deepEqual(seen.slice(1), buckets.map(bucket => v4RemoteShardPath(bucket, config.mode)))
})

test("one in-flight shard keeps cold remote metadata serial on resource-constrained clients", async () => {
  const { records, buckets, files, index } = await fixture()
  const seen: string[] = []
  const first = v4RemoteShardPath(buckets[0], config.mode)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const github = { async getFileBytes(path: string) {
    seen.push(path)
    if(path === first) await gate
    const bytes = files.get(path)
    return bytes ? { bytes, sha: "a".repeat(40) } : null
  } }
  const job = loadV4RemoteState({ github, index, maxConcurrentShardReads: 1 }, "commit-1", config)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(seen, [V4_HEAD_PATH, first])
  } finally {
    release()
  }
  assert.deepEqual((await job)?.records.map(r => r.path).sort(), records.map(r => r.path).sort())
})

test("failed remote shard aborts metadata load before any partial index result is returned", async () => {
  const { buckets, files, index } = await fixture()
  const failure = v4RemoteShardPath(buckets[1], config.mode)
  const github = { async getFileBytes(path: string) {
    if(path === failure) throw Error("read shard B failed")
    const bytes = files.get(path)
    return bytes ? { bytes, sha: "a".repeat(40) } : null
  } }
  await assert.rejects(loadV4RemoteState({ github, index, maxConcurrentShardReads: 2 }, "commit-1", config), /read shard B failed/u)
  assert.deepEqual(index.shards, {})
  assert.deepEqual(index.shardHashes, {})
})
