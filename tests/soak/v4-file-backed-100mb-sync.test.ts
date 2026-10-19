import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types"
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto"
import { sha256Hex } from "../../src/lib/bytes"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { buildV4PartPaths, V4_LARGE_FILE_THRESHOLD_BYTES, V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { assertV4RemoteRecordDescriptor } from "../../src/lib/v4/remote-index"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import { V4SyncSession } from "../../src/lib/v4/sync-session"
import { TEST_100MB_BYTES, generateTest100MBFile, generateTestFile, hashFile100MB, hashTestFile, TestDisk100MBVault } from "../helpers/file-backed-100mb-vault"

function blobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")
}

// In-process Git object backend: exercises the production V4 publisher/reader
// without credentials, transport or any write to a GitHub repository.
class IsolatedGitHub {
  ref: { ref: string; sha: string; type: string } | null = null
  files = new Map<string, Uint8Array>()
  blobs = new Map<string, Uint8Array>()
  trees = new Map<string, Map<string, Uint8Array>>()
  treeViews = new Map<string, Map<string, Uint8Array>>()
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>()
  mutationCount = 0

  async getFileBytes(name: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined
    const bytes = commit ? this.trees.get(commit.treeSha)?.get(name) : this.files.get(name)
    return bytes ? { bytes: new Uint8Array(bytes), sha: blobSha(bytes) } : null
  }
  async getGitRefOrNull() { return this.ref }
  async ensureGitRepositoryInitialized() { return null }
  async getGitCommit(sha: string) {
    const value = this.commits.get(sha)
    if (!value) throw new Error("Missing simulated Git commit")
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message }
  }
  async getTreeAt(treeSha: string, recursive = true) {
    const tree = this.trees.get(treeSha) ?? this.treeViews.get(treeSha) ?? new Map()
    if (recursive) return {
      sha: treeSha, url: "", truncated: false,
      tree: [...tree].map(([name, bytes]) =>
        ({ path: name, mode: "100644", type: "blob" as const, sha: blobSha(bytes), size: bytes.length, url: "" })),
    }
    const root = new Map<string, Uint8Array>()
    const dirs = new Map<string, Array<[string, Uint8Array]>>()
    for (const [name, bytes] of tree) {
      const slash = name.indexOf("/")
      if (slash < 0) { root.set(name, bytes); continue }
      const dir = name.slice(0, slash)
      const entries = dirs.get(dir) ?? []
      entries.push([name.slice(slash + 1), bytes])
      dirs.set(dir, entries)
    }
    const children: Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string; url: string; size?: number }> =
      [...root].map(([name, bytes]) => ({
        path: name, mode: "100644", type: "blob", sha: blobSha(bytes), size: bytes.length, url: "",
      }))
    for (const [dir, entries] of dirs) {
      const treeIdentity = createHash("sha256")
        .update(entries.map(([name, bytes]) => `${name}:${blobSha(bytes)}`).sort().join("\n")).digest("hex")
      this.treeViews.set(treeIdentity, new Map(entries))
      children.push({ path: dir, mode: "040000", type: "tree", sha: treeIdentity, url: "" })
    }
    return { sha: treeSha, url: "", truncated: false, tree: children }
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`
    this.blobs.set(sha, new Uint8Array(bytes))
    this.mutationCount++
    return sha
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined)
    for (const entry of entries) {
      if (entry.sha === null) tree.delete(entry.path)
      else {
        const blob = this.blobs.get(entry.sha)
        if (!blob) throw new Error("Missing simulated Git blob")
        tree.set(entry.path, new Uint8Array(blob))
      }
    }
    const sha = `tree-${this.trees.size + 1}`
    this.trees.set(sha, tree)
    this.mutationCount++
    return sha
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`
    this.commits.set(sha, { treeSha, parents, message })
    this.mutationCount++
    return sha
  }
  async createGitRef(sha: string) {
    const commit = this.commits.get(sha)
    if (!commit) throw new Error("Cannot set ref to missing commit")
    this.ref = { ref: "refs/heads/isolated-test", sha, type: "commit" }
    this.files = new Map(this.trees.get(commit.treeSha))
    this.mutationCount++
  }
  async updateGitRef(sha: string, expected?: string) {
    if (expected && this.ref?.sha !== expected) throw new Error("Simulated stale branch")
    await this.createGitRef(sha)
  }
}

test("legacy 32 MB encrypted single-blob payload remains decryptable after writer threshold lowers", {
  skip: process.env.V4_RUN_SOAK !== "1", timeout: 120_000,
}, async () => {
  const plaintext = new Uint8Array(32_000_000)
  for (let index = 0; index < plaintext.length; index += 4093) plaintext[index] = index % 251
  const repoId = "synthetic-owner/synthetic-repo#isolated-test"
  const keys = await deriveV4Keyring({ passphrase: "legacy-medium", repoId,
    salt: new TextEncoder().encode("salt"), iterations: 10 })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys })
  const fixture = await codec.prepare("legacy.bin", new Uint8Array([1]), "v1", 1, "legacy-file")
  const record = { ...fixture.record, size: plaintext.byteLength, plaintextSha256: await sha256Hex(plaintext),
    storage: "single" as const }
  assertV4RemoteRecordDescriptor({ ...record, path: "legacy.bin" }, {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 10, salt: "c2FsdA" },
  })
  const encrypted = await encryptV4Payload(keys.contentKey, plaintext,
    { kind: "content", aad: "legacy-file:v1" })
  const decoded = await codec.read(record, async () => encrypted)
  assert.equal(await sha256Hex(decoded), record.plaintextSha256)
  assert.deepEqual(decoded, plaintext)
})


test("legacy encrypted 48 MiB part decodes through bounded sink and detects corruption", {
  skip: process.env.V4_RUN_SOAK !== "1", timeout: 180_000,
}, async () => {
  const logicalBytes = V4_LARGE_FILE_THRESHOLD_BYTES + 1
  assert.ok(logicalBytes < TEST_100MB_BYTES)
  const plaintext = new Uint8Array(logicalBytes)
  for (let i = 0; i < logicalBytes; i += 4093) plaintext[i] = (i / 4093) & 255
  plaintext[logicalBytes - 1] = 0x7f
  const hash = await sha256Hex(plaintext)
  const repoId = "synthetic-owner/synthetic-repo#legacy48"
  const keys = await deriveV4Keyring({ passphrase: "legacy48", repoId,
    salt: new TextEncoder().encode("salt"), iterations: 10 })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys })
  const fileId = "legacy-file", version = "legacy-v1"
  const sample = await codec.prepare("legacy.bin", new Uint8Array([1]), version, 1, fileId)
  const partPaths = buildV4PartPaths({ mode: "encrypted", logicalPath: "legacy.bin",
    version, partCount: 2, opaqueId: "legacy-opaque-id" })
  const chunks = [plaintext.subarray(0, V4_PART_BYTES), plaintext.subarray(V4_PART_BYTES)]
  assert.equal(chunks[0].byteLength, 48 * 1024 * 1024)
  const cipher = await Promise.all(chunks.map((part, index) => encryptV4Payload(keys.contentKey,
    part, { kind: "part", aad: fileId + ":" + version + ":" + index })))
  const blobs = new Map(partPaths.map((name, index) => [name, cipher[index]]))
  const record = { ...sample.record, size: logicalBytes, plaintextSha256: hash,
    remotePath: partPaths[0], storage: "chunked" as const, partPaths, encryptedPath: undefined }
  assertV4RemoteRecordDescriptor({ ...record, path: "legacy.bin" }, {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId,
    pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  })
  let count = 0, bytes = 0
  const digest = createHash("sha256")
  const sink = { append: async (plaintextPart: Uint8Array) => {
    count++
    bytes += plaintextPart.byteLength
    digest.update(plaintextPart)
  }, finish: async () => { throw new Error("No filesystem commit expected") },
     abort: async () => {} }
  const decoded = await codec.readToSink({ record, reader: async name => {
    const value = blobs.get(name)
    if (!value) throw new Error("Missing part")
    return value
  }, sink })
  assert.equal(decoded.size, logicalBytes)
  assert.equal(decoded.plaintextSha256, hash)
  assert.equal(bytes, logicalBytes)
  assert.equal(count, 2)
  assert.equal(digest.digest("hex"), hash)
  const tampered = new Uint8Array(cipher[1])
  tampered[tampered.length - 1] ^= 1
  await assert.rejects(() => codec.readToSink({ record,
    reader: async name => name === partPaths[1] ? tampered : blobs.get(name)!,
    sink: { append: async () => {}, finish: sink.finish, abort: sink.abort },
  }))
  console.log(JSON.stringify({ test: "legacy-48m-encrypted", logicalBytes,
    firstPartBytes: V4_PART_BYTES, appends: count, tamperingRejected: true }))
})

test("buffered encrypted 8 MiB plus one byte becomes two REST-safe parts", {
  skip: process.env.V4_RUN_SOAK !== "1", timeout: 120_000,
}, async () => {
  const plaintext = new Uint8Array(8 * 1024 * 1024 + 1)
  plaintext[0] = 13
  plaintext[plaintext.length - 1] = 71
  const repoId = "synthetic-owner/synthetic-repo#buffered"
  const keys = await deriveV4Keyring({ passphrase: "buffered-boundary", repoId,
    salt: new TextEncoder().encode("salt"), iterations: 10 })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys })
  const prepared = await codec.prepare("medium.bin", plaintext, "v1", 1, "medium-file")
  assert.equal(prepared.record.storage, "chunked")
  assert.equal(prepared.files.length, 2)
  assert.ok(prepared.files.every(part => part.bytes.byteLength <= 8 * 1024 * 1024 + 64))
  const remote = new Map(prepared.files.map(part => [part.path, part.bytes]))
  assert.deepEqual(await codec.read(prepared.record, async name => remote.get(name)!), plaintext)
})

test("16, 32 and 50 MB encrypted medium files round-trip through V4 with new 8 MiB part writer", {
  skip: process.env.V4_RUN_SOAK !== "1", timeout: 180_000,
}, async () => {
  for (const logicalBytes of [16_000_000, 32_000_000, 50_000_000]) {
    const tempRoot = path.join(process.cwd(), ".tmp")
    await mkdir(tempRoot, { recursive: true })
    const root = await mkdtemp(path.join(tempRoot, "v4-medium-"))
    try {
      const source = new TestDisk100MBVault(path.join(root, "source"))
      const target = new TestDisk100MBVault(path.join(root, "target"))
      await mkdir(source.root)
      await mkdir(target.root)
      const sourceHash = await generateTestFile(source.payloadPath(), logicalBytes)
      const remote = new IsolatedGitHub()
      const repoId = "synthetic-owner/synthetic-repo#isolated-test"
      const config: V4RemoteConfig = {
        formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId,
        pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
        kdfParams: { iterations: 10, salt: "c2FsdA" },
      }
      const keys = await deriveV4Keyring({ passphrase: "medium-payload-test", repoId,
        salt: new TextEncoder().encode("salt"), iterations: 10 })
      const sender = createEmptyV4LocalIndex({ repoId, deviceId: "medium-source",
        mode: "encrypted", pathLayout: "opaque-stable-v1" })
      const receiver = createEmptyV4LocalIndex({ repoId, deviceId: "medium-target",
        mode: "encrypted", pathLayout: "opaque-stable-v1" })
      const sync = (vault: TestDisk100MBVault, index: typeof sender) =>
        new V4SyncSession({ github: remote, vault, index, config,
          keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 })
      assert.equal((await sync(source, sender).sync({ operation: "forcePush", allowThresholdOverride: false })).mode, "force-push")
      const records = Object.values(sender.shards).flatMap(shard => Object.values(shard.records))
      const record = records.find(item => item.path === "payload.bin" && !item.deleted)
      assert.ok(record)
      assert.equal(record.storage, "chunked")
      assert.equal(record.partPaths?.length, Math.ceil(logicalBytes / (8 * 1024 * 1024)))
      const before = remote.mutationCount
      assert.equal((await sync(source, sender).sync({ operation: "normal", allowThresholdOverride: false })).mode, "noop")
      assert.equal(remote.mutationCount, before)
      assert.equal((await sync(target, receiver).sync({ operation: "forcePull", allowThresholdOverride: false })).mode, "force-pull")
      assert.equal((await target.stat("payload.bin"))?.size, logicalBytes)
      assert.equal(await hashTestFile(target.payloadPath(), logicalBytes), sourceHash)
      // Within 32 MiB, the V4 local adapter may safely use bounded whole reads.
      if (logicalBytes > 32 * 1024 * 1024) {
        assert.equal(source.wholeReads, 0)
        assert.ok(source.boundedReads > 0)
      }
      assert.equal(target.wholeReads, 0)
      if (logicalBytes > 32 * 1024 * 1024) {
        assert.equal(target.stagedCommits, 1)
        assert.equal(target.wholeWrites, 0)
      } else {
        assert.equal(target.wholeWrites, 1)
        assert.equal(target.stagedCommits, 0)
      }
      console.log(JSON.stringify({ kind: "offline-v4-medium-encrypted", logicalBytes,
        parts: record.partPaths?.length, hashVerified: true }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("exact 100 MB physical files round-trip through encrypted V4 bounded push, no-op and staged Force Pull", {
  skip: process.env.V4_RUN_SOAK !== "1", timeout: 240_000,
}, async () => {
  const tempRoot = path.join(process.cwd(), ".tmp")
  await mkdir(tempRoot, { recursive: true })
  const root = await mkdtemp(path.join(tempRoot, "v4-disk-100mb-"))
  const source = new TestDisk100MBVault(path.join(root, "source"))
  const target = new TestDisk100MBVault(path.join(root, "target"))
  await mkdir(source.root)
  await mkdir(target.root)

  try {
    const initialHash = await generateTest100MBFile(source.payloadPath())
    const remote = new IsolatedGitHub()
    const repoId = "synthetic-owner/synthetic-repo#isolated-test"
    const config: V4RemoteConfig = {
      formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId,
      pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: 10, salt: "c2FsdA" },
    }
    const keyring = await deriveV4Keyring({ passphrase: "synthetic-100mb-test",
      repoId, salt: new TextEncoder().encode("salt"), iterations: 10 })
    const senderIndex = createEmptyV4LocalIndex({ repoId, deviceId: "sender",
      mode: "encrypted", pathLayout: "opaque-stable-v1" })
    const receiverIndex = createEmptyV4LocalIndex({ repoId, deviceId: "receiver",
      mode: "encrypted", pathLayout: "opaque-stable-v1" })
    const send = () => new V4SyncSession({ github: remote, vault: source, index: senderIndex,
      config, keyring, conflictPolicy: "copy", abortChangePercent: 0 })
    const receive = () => new V4SyncSession({ github: remote, vault: target, index: receiverIndex,
      config, keyring, conflictPolicy: "copy", abortChangePercent: 0 })

    const pushed = await send().sync({ operation: "forcePush", allowThresholdOverride: false })
    assert.equal(pushed.mode, "force-push")
    assert.ok(remote.ref?.sha)
    const mutations = remote.mutationCount
    const noOp = await send().sync({ operation: "normal", allowThresholdOverride: false })
    assert.equal(noOp.mode, "noop")
    assert.equal(remote.mutationCount, mutations, "No-op sync must not create a Git object")
    target.failAppendAt = 2
    await assert.rejects(
      () => receive().sync({ operation: "forcePull", allowThresholdOverride: false }),
      /Synthetic bounded stage append interruption/u,
    )
    assert.equal(await target.stat(target.payloadName), null, "Interrupted download must not leave a partial target")
    assert.equal(remote.mutationCount, mutations, "Interrupted pull must not modify remote state")
    const pulled = await receive().sync({ operation: "forcePull", allowThresholdOverride: false })
    assert.equal(pulled.mode, "force-pull")
    assert.equal((await target.stat(target.payloadName))?.size, TEST_100MB_BYTES)
    assert.equal(await hashFile100MB(target.payloadPath()), initialHash)
    assert.equal(source.wholeReads, 0)
    assert.equal(target.wholeReads, 0)
    assert.ok(source.boundedReads > 1)
    assert.ok(target.stagedWrites > 1, "100 MB pull must use bounded stage appends")
    assert.equal(target.stagedCommits, 1)
    assert.equal([...remote.files].some(([name]) => name.includes("payload.bin")), false,
      "Encrypted remote storage must not leak logical filename")

    console.log(JSON.stringify({
      kind: "offline-real-v4-encrypted-file-roundtrip", logicalBytes: TEST_100MB_BYTES,
      sha256: initialHash, remoteMutations: remote.mutationCount,
      sourceBoundedReads: source.boundedReads, targetBoundedReads: target.boundedReads,
      stagedCommits: target.stagedCommits, githubNetworkUsed: false,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
