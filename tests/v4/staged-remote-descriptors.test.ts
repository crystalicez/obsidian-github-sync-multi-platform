import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { assertV4RemoteRecordSet, assertV4RemoteShardRecords, buildV4RemoteMetadata, decodeV4RemoteShard } from "../../src/lib/v4/remote-index"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types"

const config: V4RemoteConfig = { formatVersion: 4, repoId: "owner/repo#main", mode: "plaintext", pathLayout: "plaintext-v1" }
async function sample(): Promise<V4IndexFileRecord> {
  const path = "Documents/One.md"
  return { path, pathId: await sha256Hex(new TextEncoder().encode(`path:${path}`)), fileId: "file-1",
    plaintextSha256: "a".repeat(64), size: 1, mtime: 42, remoteVersion: "old-revision-1",
    remotePath: path, storage: "single" }
}

test("valid historic plaintext record shape remains accepted and round trips", async () => {
  const value = await sample()
  await assert.doesNotReject(() => assertV4RemoteRecordSet([value], config))
  const bucket = value.pathId.slice(0, 2)
  const head: V4RemoteHead = { formatVersion: 4, mode: "plaintext", epoch: 1, generation: 1,
    journalId: "old-revision-1", shardHashes: {}, updatedAt: 42, deviceId: "d" }
  const output = await buildV4RemoteMetadata({ config, head, records: [value] })
  const bytes = output.find(x => x.path.endsWith(`/${bucket}.json`))!.bytes
  const parsed = await decodeV4RemoteShard(bytes, bucket, config)
  assert.deepEqual(parsed.records[value.pathId], value)
})

test("malformed metadata record types fail closed before their descriptor reaches a read", async () => {
  const valid = await sample()
  const mutations: Record<string, unknown>[] = [
    { path: 123 }, { fileId: 123 }, { remoteVersion: 17 }, { remoteVersion: "" },
    { plaintextSha256: 22 }, { size: -1 }, { size: 1.1 },
    { size: Number.MAX_SAFE_INTEGER + 1 }, { mtime: Number.POSITIVE_INFINITY },
    { remotePath: 3 }, { remotePath: "" },
  ]
  await assert.rejects(() => assertV4RemoteRecordSet([null as unknown as V4IndexFileRecord], config), /descriptor is invalid/iu)
  for (const mutation of mutations) {
    const value = { ...valid, ...mutation } as V4IndexFileRecord
    await assert.rejects(
      () => assertV4RemoteRecordSet([value], config),
      /invalid|empty|unsafe|unsupported|descriptor|path|hash|size|mtime|version|fileId/iu,
      `invalid ${Object.keys(mutation).join(",")}`,
    )
  }
})

test("record descriptor validator rejects invalid paths even when metadata bucket is correct", async () => {
  const valid = await sample()
  const bucket = valid.pathId.slice(0, 2)
  const invalid = { ...valid, size: Number.NaN }
  assert.throws(() => assertV4RemoteShardRecords({ bucket, records: { [valid.pathId]: invalid } }, bucket, config), /size|invalid/iu)
})

test("legacy encrypted packed record is still accepted by the shard reader", async () => {
  const value = await sample()
  const legacy: V4RemoteConfig = { ...config, mode: "encrypted", pathLayout: undefined }
  const bucket = value.pathId.slice(0, 2)
  const packed = { ...value, storage: "pack" as const, packId: "old-pack-v1",
    remotePath: ".obsidian-github-sync-v4/packs/aa/old-pack-v1.enc",
    encryptedPath: ".obsidian-github-sync-v4/data/aa/old-path.enc" }
  assert.doesNotThrow(() => assertV4RemoteShardRecords({ bucket, records: { [packed.pathId]: packed } }, bucket, legacy))
})

test("historical 48 MiB chunked descriptor remains accepted without allocating a large file", async () => {
  const value = await sample()
  const parts = [".obsidian-github-sync-v4/large/Documents/One.md/v1/000001.part",
    ".obsidian-github-sync-v4/large/Documents/One.md/v1/000002.part"]
  const chunked = { ...value, storage: "chunked" as const, size: 50 * 1024 * 1024 + 1,
    partPaths: parts, remotePath: parts[0] }
  const bucket = value.pathId.slice(0, 2)
  assert.doesNotThrow(() => assertV4RemoteShardRecords({ bucket, records: { [chunked.pathId]: chunked } }, bucket, config))
})


test("D59 untrusted chunk part coordinates fail closed before remote content reads", async () => {
  const value = await sample()
  const canonical = ".obsidian-github-sync-v4/large/Documents/One.md/v1/000001.part"
  const next = ".obsidian-github-sync-v4/large/Documents/One.md/v1/000002.part"
  const invalidCases: Array<[string, unknown]> = [
    ["string instead of array", canonical],
    ["object pretending to be array", { 0: canonical, length: 1 }],
    ["non-string entry", [canonical, null]],
    ["remote parent traversal", ["../../.obsidian/plugins/secret.json"]],
    ["embedded traversal", [".obsidian-github-sync-v4/large/Documents/../One.md/v1/000001.part"]],
    ["absolute remote coordinate", ["/" + canonical]],
    ["backslash aliases", [canonical.replaceAll("/", "\\")]],
    ["metadata namespace spoofing", [".obsidian-github-sync-v4/config.json"]],
    ["unrelated vault file spoofing", ["Notes/user.md"]],
    ["duplicate part", [canonical, canonical]],
  ]
  for (const [label, partPaths] of invalidCases) {
    const chunked = {
      ...value, storage: "chunked" as const,
      size: 50 * 1024 * 1024 + 1,
      remotePath: Array.isArray(partPaths) ? String(partPaths[0]) : canonical,
      partPaths,
    } as unknown as V4IndexFileRecord
    await assert.rejects(
      () => assertV4RemoteRecordSet([chunked], config),
      /part|chunk|path|descriptor|unsafe|duplicate|namespace/iu,
      label,
    )
  }
  const legitimate = {
    ...value, storage: "chunked" as const,
    size: 50 * 1024 * 1024 + 1, partPaths: [canonical, next], remotePath: canonical,
  }
  await assert.doesNotReject(() => assertV4RemoteRecordSet([legitimate], config),
    "historical large-file part names must remain readable")
})


test("D59 encrypted chunks stay readable only with normalized V4 part coordinates", async () => {
  const value = await sample()
  const encrypted = { ...config, mode: "encrypted" as const, pathLayout: undefined }
  const prefix = ".obsidian-github-sync-v4/parts/ab/" + "a".repeat(64) + "/v1/"
  const parts = [prefix + "000001.enc", prefix + "000002.enc"]
  const valid = { ...value, storage: "chunked" as const, remotePath: parts[0]!, partPaths: parts }
  const bucket = value.pathId.slice(0, 2)
  assert.doesNotThrow(() => assertV4RemoteShardRecords({
    bucket, records: { [value.pathId]: valid },
  }, bucket, encrypted))
  const forged = { ...valid, partPaths: [parts[0]!, ".obsidian-github-sync-v4/head"] }
  assert.throws(() => assertV4RemoteShardRecords({
    bucket, records: { [value.pathId]: forged },
  }, bucket, encrypted), /part|namespace/iu)
})

test("legacy 9 MiB single-blob record and external commit marker remain readable", async () => {
  const oldWriterSingle = { ...await sample(), size: 9 * 1024 * 1024, remoteVersion: "external:direct-github-commit" }
  await assert.doesNotReject(() => assertV4RemoteRecordSet([oldWriterSingle], config))
})
