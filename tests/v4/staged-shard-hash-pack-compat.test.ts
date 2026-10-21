import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import { decodeV4RemoteShard, buildV4RemoteMetadata } from "../../src/lib/v4/remote-index"
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types"
import { estimateV4PackGroupResources, planV4PackGroups, PACK_MAX_ENTRY_BYTES, type V4PackCandidateMeta } from "../../src/lib/v4/pack-planner"

const encoder = new TextEncoder()
const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "owner/repo#main", pathLayout: "plaintext-v1" }
async function record(path: string, id: string, dirty?: boolean): Promise<V4IndexFileRecord> {
  return { path, pathId: await sha256Hex(encoder.encode(`path:${path}`)), fileId: id,
    plaintextSha256: "a".repeat(64), size: 1, mtime: 1, remoteVersion: "v1",
    remotePath: path, storage: "single", ...(dirty === undefined ? {} : { dirty }) }
}

test("legacy shard hash equals sorted JSON-array signature of full writer records", async () => {
  const files = await Promise.all([record("Notes/Z.md", "z"), record("Notes/A.md", "a", false)])
  const sorted = [...files].sort((a, b) => a.pathId.localeCompare(b.pathId))
  const fullRecordHash = await sha256Hex(encoder.encode(JSON.stringify(sorted)))
  const scrubbed = sorted.map(({ dirty: _dirty, deleted: _deleted, ...remote }) => remote)
  const scrubbedHash = await sha256Hex(encoder.encode(JSON.stringify(scrubbed)))
  assert.notEqual(fullRecordHash, scrubbedHash,
    "Changing to a new canonicalized shard hash is a migration, not a reader-only check")
  const buckets = new Set(files.map(file => file.pathId.slice(0, 2)))
  // Build only metadata: no real large bytes or GitHub calls.
  const perBucketHashes: Record<string, string> = {}
  for (const bucket of buckets) {
    const bucketRecords = files.filter(rec => rec.pathId.startsWith(bucket))
      .sort((a, b) => a.pathId.localeCompare(b.pathId))
    perBucketHashes[bucket] = await sha256Hex(encoder.encode(JSON.stringify(bucketRecords)))
  }
  const head: V4RemoteHead = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 2,
    journalId: "v1", shardHashes: perBucketHashes,
    updatedAt: 1, deviceId: "d" }
  const metadata = await buildV4RemoteMetadata({ config, head, records: files })
  for (const bucket of buckets) {
    const file = metadata.find(entry => entry.path.endsWith(`/${bucket}.json`))!
    const shard = await decodeV4RemoteShard(file.bytes, bucket, config)
    assert.deepEqual(Object.values(shard.records), files.filter(rec => rec.pathId.startsWith(bucket)))
    const sortedDownloaded = Object.values(shard.records)
      .sort((a, b) => a.pathId.localeCompare(b.pathId))
    assert.equal(await sha256Hex(encoder.encode(JSON.stringify(sortedDownloaded))), head.shardHashes[bucket])
  }
})

function oldReference(groups: readonly V4PackCandidateMeta[], options: {
 maxPlaintextBytes?: number; maxResidentBytes?: number; maxTransportTransientBytes?: number
} = {}) {
  const maxPlaintext = Math.min(32 * 1024 * 1024, options.maxPlaintextBytes ?? 32 * 1024 * 1024)
  const within = (group: readonly V4PackCandidateMeta[]) => {
    const r = estimateV4PackGroupResources(group)
    return r.plaintextBytes <= maxPlaintext
      && r.residentBytes <= (options.maxResidentBytes ?? Number.POSITIVE_INFINITY)
      && r.transportBytes <= (options.maxTransportTransientBytes ?? Number.POSITIVE_INFINITY)
  }
  const eligible = groups.filter(item => item.size <= PACK_MAX_ENTRY_BYTES && within([item]))
  if (eligible.length < 64) return []
  const results: V4PackCandidateMeta[][] = []
  for (let start = 0; start < eligible.length;) {
    const folder = eligible[start].path.split("/").slice(0, -1).join("/")
    const group: V4PackCandidateMeta[] = []
    while (start < eligible.length && group.length < 500) {
      const item = eligible[start]
      if (group.length && item.path.split("/").slice(0, -1).join("/") !== folder) break
      if (group.length && !within([...group, item])) break
      group.push(item)
      start++
    }
    results.push(group)
  }
  return results
}

test("packing resource budgeting and grouping match established writer across mixed deterministic cases", () => {
  for (const maxPlaintextBytes of [64 * 1024, 1 * 1024 * 1024, 32 * 1024 * 1024]) {
    const inputs: V4PackCandidateMeta[] = Array.from({ length: 725 }, (_, i) => ({
      fileId: `file-${i}`, path: `${i % 7 < 4 ? "Docs" : "Others"}/${i}.md`,
      size: i % 37 === 0 ? PACK_MAX_ENTRY_BYTES + 1 : ((i * 1237) % (64 * 1024)) + 1,
    }))
    for (const opts of [
      { maxPlaintextBytes }, { maxPlaintextBytes, maxResidentBytes: 500_000 },
      { maxPlaintextBytes, maxTransportTransientBytes: 2_000_000 },
    ]) {
      assert.deepEqual(planV4PackGroups(inputs, opts), oldReference(inputs, opts))
    }
  }
})
