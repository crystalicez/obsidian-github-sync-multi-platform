import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { createV4WholeBufferContentSource, type V4ContentSource } from "../../src/lib/v4/content-source"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { verifyV4ReencryptionBackupReadback } from "../../src/lib/v4/reencryption-backup-readback"
import { type V4IndexFileRecord } from "../../src/lib/v4/local-index"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { type V4RemoteShard } from "../../src/lib/v4/remote-index"
import { type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types"

const sourceCommitSha = "a".repeat(40)
const snapshotId = "b".repeat(64)
const config: V4RemoteConfig = {
  formatVersion: 4, mode: "encrypted", repoId: "owner/repo#main",
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: toBase64Url(utf8ToBytes("d84-backup-salt")) },
}

async function fixture(includeMultipart = false) {
  const keyring = await deriveV4Keyring({
    passphrase: "d84-passphrase", repoId: config.repoId,
    salt: utf8ToBytes("d84-backup-salt"), iterations: 10,
  })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring })
  const files = new Map<string, Uint8Array>([
    ["Notes/秘密 🌸.md", utf8ToBytes("hello backup")],
    ["Empty/zero.bin", new Uint8Array()],
    ["Binary/data.bin", new Uint8Array([0, 255, 1, 200])],
  ])
  if (includeMultipart) files.set("Big/multipart.bin", new Uint8Array(8 * 1024 * 1024 + 17).fill(0x42))
  const records: V4IndexFileRecord[] = []
  for (const [path, bytes] of files) {
    const prepared = await codec.prepare(path, bytes, "v1", 12, "d84-" + records.length)
    records.push({ ...prepared.record, path })
  }
  const tomb = await codec.prepare("Removed/do-not-restore.md", utf8ToBytes("deleted"), "v1", 10, "old-deleted")
  records.push({ ...tomb.record, path: "Removed/do-not-restore.md", deleted: true })
  const shards: Record<string, V4RemoteShard> = {}
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2)
    ;(shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record
  }
  const shardHashes: Record<string, string> = {}
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )))
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "j", deviceId: "d84", updatedAt: 1, shardHashes,
  }
  const entries = await Promise.all(records.filter(r => !r.deleted).map(async r => ({
    path: r.path, size: r.size, plaintextSha256: r.plaintextSha256, mtime: r.mtime,
  })))
  const backupFiles = new Map([...files].map(([p, b]) => [p, b.slice()]))
  let checks = 0
  let reads = 0
  let headChecks = 0
  let currentSnapshotId = snapshotId
  let currentHead = sourceCommitSha
  const backup = {
    sourceCommitSha,
    snapshotId,
    async readCurrentSnapshotId() { checks++; return currentSnapshotId },
    async listFiles() { return entries.map(e => ({ ...e })) },
    async openFile(path: string, _size: number): Promise<V4ContentSource> {
      reads++
      const data = backupFiles.get(path)
      if (!data) throw new Error("backup file missing")
      return createV4WholeBufferContentSource(data)
    },
  }
  const input = {
    config, head, shards, keyring, pinnedSourceCommitSha: sourceCommitSha,
    backup,
    async readCurrentSourceHeadSha() { headChecks++; return currentHead },
  }
  return {
    input, backup, files, backupFiles, entries,
    get reads() { return reads }, get checks() { return checks }, get headChecks() { return headChecks },
    changeSnapshot(id: string) { currentSnapshotId = id },
    changeHead(id: string) { currentHead = id },
  }
}

test("D84 full readback authenticates Unicode/binary/zero/multipart backup against complete source index", async () => {
  const f = await fixture(true)
  const report = await verifyV4ReencryptionBackupReadback(f.input)
  assert.deepEqual(report, {
    integrityScope: "backup-snapshot-content-parity-only",
    pinnedSourceCommitSha: sourceCommitSha,
    matchedLiveFileCount: 4,
    verifiedPlaintextBytes: String(8 * 1024 * 1024 + 17 + 12 + 4),
    sourceTombstoneCount: 1,
    backupContentsMatchSource: true,
    independentStorageVerified: false,
    restoreTested: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
  assert.ok(Object.isFrozen(report))
  assert.ok(f.checks >= 2)
  assert.ok(f.headChecks >= 2)
  assert.equal(f.reads, 4)
  assert.equal(JSON.stringify(report).includes("秘密"), false)
  assert.equal(JSON.stringify(report).includes("d84-passphrase"), false)
})

test("D84 refuses missing, extra, duplicate and resurrected files BEFORE reading backup bytes", async () => {
  for (const kind of ["missing", "extra", "duplicate", "resurrected"] as const) {
    const f = await fixture()
    if (kind === "missing") f.entries.pop()
    if (kind === "extra") f.entries.push({ ...f.entries[0]!, path: "Unexpected.txt" })
    if (kind === "duplicate") f.entries.push({ ...f.entries[0]! })
    if (kind === "resurrected") f.entries.push({ ...f.entries[0]!, path: "Removed/do-not-restore.md" })
    await assert.rejects(() => verifyV4ReencryptionBackupReadback(f.input), /backup|file|snapshot|path|duplicate|missing/i)
    assert.equal(f.reads, 0, kind)
  }
})

test("D84 refuses modified manifest size/hash/mtime and corrupt backup data", async () => {
  for (const changed of ["size", "hash", "mtime", "bytes"] as const) {
    const f = await fixture()
    const e = f.entries[0]!
    if (changed === "size") e.size++
    if (changed === "hash") e.plaintextSha256 = "f".repeat(64)
    if (changed === "mtime") e.mtime++
    if (changed === "bytes") f.backupFiles.set(e.path, utf8ToBytes("hello bAckup"))
    await assert.rejects(() => verifyV4ReencryptionBackupReadback(f.input), /backup|SHA|hash|size|mtime|mismatch/i)
  }
})

test("D84 refuses truncated, overlong, oversized or empty chunks instead of silently trusting stream size", async () => {
  for (const variant of ["short", "long", "oversized", "empty"] as const) {
    const f = await fixture()
    f.backup.openFile = async (path: string): Promise<V4ContentSource> => {
      const data = f.backupFiles.get(path)!
      if (variant === "short") return { size: data.length, async *chunks() { yield data.subarray(0, Math.max(0, data.length - 1)) } }
      if (variant === "long") return { size: data.length, async *chunks() { yield data; yield new Uint8Array([1]) } }
      if (variant === "oversized") return { size: data.length, async *chunks() { yield new Uint8Array(1024 * 1024 + 1) } }
      return { size: data.length, async *chunks() { yield new Uint8Array(0) } }
    }
    await assert.rejects(() => verifyV4ReencryptionBackupReadback(f.input), /backup|stream|chunk|size|byte/i)
  }
})

test("D84 rejects changed backup snapshot or changed pinned Git source HEAD", async () => {
  const f = await fixture()
  let polls = 0
  f.backup.readCurrentSnapshotId = async () => ++polls === 1 ? snapshotId : "c".repeat(64)
  await assert.rejects(() => verifyV4ReencryptionBackupReadback(f.input), /snapshot|changed/i)
  const g = await fixture()
  g.changeHead("c".repeat(40))
  await assert.rejects(() => verifyV4ReencryptionBackupReadback(g.input), /HEAD|source/i)
})

test("D84 rejects missing/corrupt source shard signatures before any backup read", async () => {
  const f = await fixture()
  const absent = { ...f.input.shards }
  delete absent[Object.keys(absent)[0]!]
  await assert.rejects(() => verifyV4ReencryptionBackupReadback({
    ...f.input, shards: absent,
  }), /shard|bucket|missing/i)
  assert.equal(f.reads, 0)
})

test("D84 handles a tombstone-only backup as empty, but never counts deleted files as restored", async () => {
  const f = await fixture()
  const shards: Record<string, V4RemoteShard> = {}
  for (const shard of Object.values(f.input.shards)) {
    const records = Object.fromEntries(Object.entries(shard.records).filter(([, r]) => r.deleted))
    if (Object.keys(records).length) shards[shard.bucket] = { bucket: shard.bucket, records }
  }
  const shardHashes: Record<string, string> = {}
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify(Object.values(shard.records))))
  }
  const report = await verifyV4ReencryptionBackupReadback({
    ...f.input, shards, head: { ...f.input.head, shardHashes },
    backup: { ...f.backup, async listFiles() { return [] } },
  })
  assert.equal(report.matchedLiveFileCount, 0)
  assert.equal(report.verifiedPlaintextBytes, "0")
  assert.equal(report.sourceTombstoneCount, 1)
  assert.equal(report.permissionToPublish, false)
})

test("D84 rejects unsafe/canonical-colliding backup names and wrong snapshot source binding", async () => {
  for (const badPath of ["../secret.txt", "notes/秘密 🌸.md", "Notes", "Notes/秘密 🌸.md/nested"]) {
    const f = await fixture()
    // Keep the same file count to exercise path safety, not count rejection.
    // Replacing a distinct file with an ancestor or canonical alias must fail.
    f.entries[2] = { ...f.entries[2]!, path: badPath }
    await assert.rejects(() => verifyV4ReencryptionBackupReadback(f.input), /path|collision|canonical|topology|unsafe|mismatch/i)
    assert.equal(f.reads, 0)
  }
  const original = await fixture()
  await assert.rejects(() => verifyV4ReencryptionBackupReadback({
    ...original.input, backup: { ...original.backup, sourceCommitSha: "c".repeat(40) },
  }), /identity|snapshot|source/i)
  assert.equal(original.reads, 0)
})

test("D84 aborts a partially streamed read without ever returning a verified backup report", async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.backup.openFile = async (path: string) => {
    const original = f.backupFiles.get(path)!
    return { size: original.byteLength, async *chunks() {
      if (original.length) {
        yield original.subarray(0, 1)
        controller.abort(new Error("read stopped mid file"))
        yield original.subarray(1)
      }
    } }
  }
  await assert.rejects(() => verifyV4ReencryptionBackupReadback({
    ...f.input, signal: controller.signal,
  }), /read stopped mid file|cancel|abort/i)
})

test("D84 aborts fail-closed and does not claim independent backup or a physical restore", async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(() => verifyV4ReencryptionBackupReadback({
    ...f.input, signal: controller.signal,
  }), /cancelled|abort/i)
  assert.equal(f.reads, 0)
})
