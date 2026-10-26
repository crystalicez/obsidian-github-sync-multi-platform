import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import { verifyV4ReencryptionDestinationExactCommit } from "../../src/lib/v4/reencryption-destination-exact-commit"
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import { type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"

const enc = utf8ToBytes
const original = "owner/repo#main"
const destination = "owner/repo#rekey/d83"
const pinned = "a".repeat(40)
const rootSha = "d".repeat(40)
const sourceTree = "f".repeat(40)
const treeSha = "c".repeat(40)
const config = (id: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId: id,
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256",
  kdfParams: { iterations: 600_000, salt: toBase64Url(enc(salt)) },
})
const srcConfig = config(original, "old-d83-salt")
const dstConfig = config(destination, "new-d83-salt")
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: original, destinationRepoId: destination, sourceCommitSha: pinned,
  sourcePhysicalRepositoryId: 88, destinationPhysicalRepositoryId: 88,
  expectedPhysicalRepositoryId: 88, defaultBranch: "main",
})

async function makeBase() {
  const keyring = await deriveV4Keyring({
    repoId: destination, passphrase: "new-d83-secret",
    salt: enc("new-d83-salt"), iterations: 600_000,
  })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring })
  const notes = [
    { path: "Unicode/秘密 🌐.md", content: enc("important note") },
    { path: "Archive/empty.bin", content: new Uint8Array() },
    { path: "Assets/long.bin", content: new Uint8Array(8 * 1024 * 1024 + 13).fill(0x4c) },
  ]
  const records: V4IndexFileRecord[] = []
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!
    const prepared = await codec.prepare(note.path, note.content, "v1", i + 1, "d83-dest-id-" + i)
    records.push({ ...prepared.record, path: note.path })
    files.push(...prepared.files)
  }
  const shardHashes: Record<string, string> = {}
  for (const bucket of new Set(records.map(record => record.pathId.slice(0, 2)))) {
    shardHashes[bucket] = await sha256Hex(enc(JSON.stringify(
      records.filter(r => r.pathId.startsWith(bucket)).sort((a,b) => a.pathId.localeCompare(b.pathId)),
    )))
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "synthetic",
    deviceId: "d83", updatedAt: 4, shardHashes,
  }
  const metadata = await buildV4RemoteMetadata({ config: dstConfig, head, records, keyring })
  files.push(...metadata)
  const entries = files.map(file => ({
    path: file.path, sha: computeV4GitBlobSha1(file.bytes),
    mode: "100644", type: "blob" as const,
  }))
  const blobValues = new Map(files.map(file => [computeV4GitBlobSha1(file.bytes), file.bytes]))
  const receipts = files.filter(file => !metadata.includes(file)).map(file => ({
    path: file.path, sha: computeV4GitBlobSha1(file.bytes), byteLength: file.bytes.byteLength,
  }))
  return { records, entries, blobValues, receipts }
}
const basePromise = makeBase()

async function fixture() {
  const b = await basePromise
  const entries = b.entries.map(e => ({ ...e }))
  const blobs = new Map(b.blobValues)
  let reads = 0
  let refs = 0
  let repoChecks = 0
  let pinnedRef = rootSha
  const github = {
    async getRepositoryIdentity() { repoChecks++; return { id: 88, fullName: "owner/repo" } },
    async getGitRef() { refs++; return { ref: "refs/heads/rekey/d83", type: "commit" as const, sha: pinnedRef } },
    async getGitCommit(_sha: string) {
      return { sha: rootSha, treeSha, parentShas: [] as string[], message: "d83 synthetic" }
    },
    async getTreeAt(_sha: string, _recursive: boolean) {
      return { sha: treeSha, tree: entries, truncated: false, url: "" }
    },
    async getBlob(sha: string) {
      reads++
      const blob = blobs.get(sha)
      if (!blob) throw new Error("HTTP 404")
      return blob.slice()
    },
  }
  return {
    entries, blobs, github, records: b.records, receipts: b.receipts,
    get reads() { return reads }, get refs() { return refs }, get repoChecks() { return repoChecks },
    changeRef(next: string) { pinnedRef = next },
  }
}
function args(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    github: f.github, plan, destinationCommitSha: rootSha,
    sourceTreeSha: sourceTree, sourceConfig: srcConfig, expectedDestinationConfig: dstConfig,
    expectedRecords: f.records, expectedReceipts: f.receipts,
    destinationPassphrase: "new-d83-secret",
  }
}

test("D83 independently verifies full pinned orphan tree, encrypted head, shards and all file ciphertext", async () => {
  const f = await fixture()
  const result = await verifyV4ReencryptionDestinationExactCommit(args(f))
  assert.deepEqual(result, {
    integrityScope: "exact-orphan-commit-all-live-content",
    destinationCommitSha: rootSha,
    destinationRepoId: destination,
    verifiedFileCount: 3,
    verifiedRemoteObjectCount: 4,
    totalVerifiedPlaintextBytes: String(14 + 8 * 1024 * 1024 + 13),
    backupVerified: false,
    secondDeviceRestored: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
  assert.ok(Object.isFrozen(result))
  assert.ok(f.refs >= 2)
  assert.ok(f.repoChecks >= 2)
  assert.ok(f.reads >= 4)
  assert.ok(!JSON.stringify(result).includes("秘密"))
})

test("D83 rejects a missing, extra, or forged Git tree blob before trusting full-vault proof", async () => {
  for (const kind of ["missing", "extra", "changed-sha", "symlink", "truncated"] as const) {
    const f = await fixture()
    const objectPath = f.receipts[0]!.path
    const node = f.entries.find(entry => entry.path === objectPath)!
    if (kind === "missing") f.entries.splice(f.entries.indexOf(node), 1)
    if (kind === "extra") f.entries.push({path: "surprise.txt", mode: "100644", type: "blob", sha: "b".repeat(40)})
    if (kind === "changed-sha") node.sha = "b".repeat(40)
    if (kind === "symlink") node.mode = "120000"
    if (kind === "truncated") f.github.getTreeAt = async () => ({
      sha: treeSha, tree: f.entries, truncated: true, url: "",
    })
    await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(f)),
      /tree|blob|object|truncated|missing|receipt/i, kind)
  }
})

test("D83 rejects altered committed ciphertext and wrong expected plaintext inventory", async () => {
  const f = await fixture()
  const entry = f.entries.find(e => e.path === f.receipts[0]!.path)!
  const current = f.blobs.get(entry.sha)!
  const corrupted = current.slice()
  corrupted[corrupted.length - 1] ^= 1
  f.blobs.set(entry.sha, corrupted)
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(f)),
    /Git blob identity|integrity|ciphertext/i)
  const good = await fixture()
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(good), expectedRecords: [{ ...good.records[0]!, plaintextSha256: "f".repeat(64) }, ...good.records.slice(1)],
  }), /record|manifest|hash|SHA/i)
})

test("D83 rejects missing, duplicated and altered receipt SHA without accepting partial set", async () => {
  const f = await fixture()
  const expectedReceipts = f.receipts.slice(1)
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(f), expectedReceipts,
  }), /receipt|cover/i)
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(f), expectedReceipts: [...f.receipts, f.receipts[0]!],
  }), /receipt|duplicate/i)
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(f), expectedReceipts: [{ ...f.receipts[0]!, sha: "f".repeat(40) }, ...f.receipts.slice(1)],
  }), /receipt|SHA|object/i)
})

test("D83 rejects non-orphan commits, wrong branch SHA, reused source tree and changed branch mid-read", async () => {
  const f = await fixture()
  f.github.getGitCommit = async (_sha) => ({ sha: rootSha, treeSha, parentShas: [pinned], message: "" })
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(f)), /zero parents|orphan|parent/i)
  const forged = await fixture()
  forged.github.getGitCommit = async (_sha) => ({
    sha: "b".repeat(40), treeSha, parentShas: [], message: "",
  })
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(forged)), /commit identity/i)
  const wrong = await fixture()
  wrong.changeRef("e".repeat(40))
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(wrong)), /branch changed/i)
  const same = await fixture()
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(same), sourceTreeSha: treeSha,
  }), /source tree|reuse/i)
  const moving = await fixture()
  moving.github.getGitRef = async () => ({
    ref: "refs/heads/rekey/d83", type: "commit" as const,
    sha: ++testRefChecks === 1 ? rootSha : "e".repeat(40),
  })
  let testRefChecks = 0
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(moving)), /branch changed/i)
})

test("D83 wrong key, changed repo identity, malformed or cancelled audit fail closed", async () => {
  const f = await fixture()
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(f), destinationPassphrase: "wrong-secret",
  }), /decrypt|integrity|hash|metadata|passphrase/i)
  const swapped = await fixture()
  let times = 0
  swapped.github.getRepositoryIdentity = async () => ({
    id: ++times === 1 ? 88 : 99, fullName: "owner/repo",
  })
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit(args(swapped)), /repository identity/i)
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    ...args(f), signal: controller.signal,
  }), /cancelled|abort/i)
})
