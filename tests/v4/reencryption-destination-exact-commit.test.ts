import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import { verifyV4ReencryptionDestinationExactCommit } from "../../src/lib/v4/reencryption-destination-exact-commit"
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4IndexFileRecord, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { verifyV4ReencryptionShadowAgainstDestination } from "../../src/lib/v4/reencryption-shadow-remote-binding"
import { inspectV4ReencryptionCrossSurfaceProof } from "../../src/lib/v4/reencryption-cross-surface-proof"
import { computeV4ReencryptionCandidateManifestDigest } from "../../src/lib/v4/reencryption-candidate-manifest-digest"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import type { V4PreparedOrphanCommit } from "../../src/lib/v4/reencryption-orphan-publication"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
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
  return { records, entries, blobValues, receipts, head }
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
    entries, blobs, github, records: b.records, receipts: b.receipts.map(receipt => ({ ...receipt })), head: b.head,
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

const d137Run = "run_d137_shadow"
const d137Shadow = "private/index-rekey-" + d137Run
async function d137Scenario() {
  const f = await fixture()
  const files = new Map<string, string>()
  let writes = 0
  const adapter: V4LocalIndexAdapter = {
    async read(path) { const raw = files.get(path); if (raw === undefined) throw Error("missing"); return raw },
    async write(path, value) { writes++; files.set(path, value) },
    async exists(path) { return files.has(path) },
    async mkdir() {},
  }
  const index = createEmptyV4LocalIndex({ repoId: destination, deviceId: "d83", mode: "encrypted" })
  index.remoteCommitSha = rootSha
  index.epoch = f.head.epoch
  index.generation = f.head.generation
  for (const record of f.records) {
    const bucket = record.pathId.slice(0, 2)
    if (!index.shards[bucket]) {
      index.shards[bucket] = { bucket, hash: f.head.shardHashes[bucket]!, records: {} }
      index.shardHashes[bucket] = f.head.shardHashes[bucket]!
    }
    index.shards[bucket]!.records[record.pathId] = {
      ...record, ...(record.partPaths ? { partPaths: [...record.partPaths] } : {}),
    }
  }
  await saveV4LocalIndex(adapter, d137Shadow, index)
  const { expectedRecords: _ignored, ...remote } = args(f)
  const lease = async () => {}
  const durable = async () => {}
  const input = () => ({
    adapter, activeIndexRoot: "private/index", runId: d137Run,
    expectedDeviceId: "d83", remote, assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
  })
  return { f, adapter, files, input, getWrites: () => writes }
}

test("D137 verified immutable remote plaintext and all committed records bind to Shadow without a write", async () => {
  const s = await d137Scenario()
  const before = new Map(s.files)
  const writes = s.getWrites()
  const report = await verifyV4ReencryptionShadowAgainstDestination(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-verified-git-content-to-local-shadow",
    observation: "shadow-matches-verified-destination-uncommitted",
    destinationRepoId: destination, destinationCommitSha: rootSha, verifiedFileCount: 3,
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.ok(s.f.reads > 4)
  assert.ok(s.f.refs >= 2)
  assert.deepEqual(s.files, before)
  assert.equal(s.getWrites(), writes)
  assert.doesNotMatch(JSON.stringify(report), /Unicode|秘密|new-d83-secret/)
})

test("D137 rejects forged Shadow records even after its local content digest was recomputed", async () => {
  const s = await d137Scenario()
  const local = await loadV4LocalIndex(s.adapter, d137Shadow)
  const record = Object.values(Object.values(local.shards)[0]!.records)[0]!
  record.path = "forged/notes.md"
  await saveV4LocalIndex(s.adapter, d137Shadow, local)
  await assert.rejects(() => verifyV4ReencryptionShadowAgainstDestination(s.input()),
    /record|manifest|committed|SHA|index/i)
})

test("D137 rejects a self-consistent Shadow header that does not match authenticated encrypted HEAD", async () => {
  const s = await d137Scenario()
  const local = await loadV4LocalIndex(s.adapter, d137Shadow)
  local.epoch += 1
  await saveV4LocalIndex(s.adapter, d137Shadow, local)
  await assert.rejects(() => verifyV4ReencryptionShadowAgainstDestination(s.input()), /Shadow header|Git HEAD/i)
})

test("D137 rejects moved Git ref and Shadow changed during authenticated Git fetch", async () => {
  const moved = await d137Scenario()
  moved.f.changeRef("9".repeat(40))
  await assert.rejects(() => verifyV4ReencryptionShadowAgainstDestination(moved.input()), /branch changed/i)
  const changed = await d137Scenario()
  const original = changed.f.github.getBlob
  let modified = false
  changed.f.github.getBlob = async sha => {
    if (!modified) {
      modified = true
      const local = await loadV4LocalIndex(changed.adapter, d137Shadow)
      local.generation++
      await saveV4LocalIndex(changed.adapter, d137Shadow, local)
    }
    return original(sha)
  }
  await assert.rejects(
    () => verifyV4ReencryptionShadowAgainstDestination(changed.input()), /Shadow changed|changed during/i,
  )
  assert.equal(modified, true)
})

test("D137 a GitHub client method swapped mid-read cannot produce a successful binding", async () => {
  const s = await d137Scenario()
  const original = s.f.github.getBlob
  let mutated = false
  s.f.github.getBlob = async sha => {
    if (!mutated) {
      mutated = true
      s.f.github.getGitRef = async () => ({
        ref: "refs/heads/rekey/d83", type: "commit" as const, sha: rootSha,
      })
    }
    return original(sha)
  }
  await assert.rejects(
    () => verifyV4ReencryptionShadowAgainstDestination(s.input()), /inputs changed|report does not bind/i,
  )
  assert.equal(mutated, true)
})

test("D137 changed scope before remote read and missing Shadow refuse verification", async () => {
  const s = await d137Scenario()
  const input = s.input()
  const mutable = { ...input }
  mutable.assertExclusiveInitiatorLease = async () => { mutable.remote.sourceTreeSha = "9".repeat(40) }
  await assert.rejects(
    () => verifyV4ReencryptionShadowAgainstDestination(mutable), /inputs changed/i,
  )
  const missing = await d137Scenario()
  missing.files.clear()
  await assert.rejects(
    () => verifyV4ReencryptionShadowAgainstDestination(missing.input()), /Shadow is incomplete/i,
  )
  assert.equal(missing.f.reads, 0)
})

const d138Backup = "owner/repo#backup/run_d138"
const d138Generation = 21

async function d138Scenario() {
  const s = await d137Scenario()
  const shadow = s.input()
  const sourceIndex = createEmptyV4LocalIndex({ repoId: original, deviceId: "d83", mode: "encrypted" })
  sourceIndex.remoteCommitSha = pinned
  await saveV4LocalIndex(s.adapter, shadow.activeIndexRoot, sourceIndex)

  const prepared: V4PreparedOrphanCommit = {
    integrityScope: "unreferenced-encrypted-orphan-commit",
    destinationRepoId: destination, pinnedSourceCommitSha: pinned,
    physicalRepositoryId: 88, sourceTreeSha: sourceTree, treeSha,
    commitSha: rootSha, verifiedFileCount: 3,
    stagedCiphertextObjectCount: shadow.remote.expectedReceipts.length,
    encryptedMetadataObjectCount: 2 + Object.keys(s.f.head.shardHashes).length,
    deviceId: "d83", journalId: "d138_journal", createdAt: 123,
    sourceAndBackupPreserved: true, rootHasZeroParents: true,
    backupProvenanceVerified: false, installedRestoreVerified: false,
    refPublished: false, cutoverAuthorized: false,
  }
  const savedShadow = await loadV4LocalIndex(s.adapter, d137Shadow)
  const digest = computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha: sourceTree, destinationConfig: shadow.remote.expectedDestinationConfig,
    expectedReceipts: shadow.remote.expectedReceipts,
    expectedRecords: Object.values(savedShadow.shards).flatMap(shard => Object.values(shard.records)),
  })
  let wal: V4ReencryptionJournalSnapshot = {
    generation: d138Generation, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: d138Backup, commitSha: pinned, treeSha: sourceTree },
      { role: "destination", repoId: destination, commitSha: rootSha, treeSha,
        manifestSha256: digest },
    ],
    stageHandoffStarted: true, candidatePreparationSha256: "f".repeat(64),
    preparedCandidateReceipt: { commitSha: rootSha, treeSha, manifestSha256: digest },
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const journal = {
    sourceCommitSha: pinned, destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      assert.equal(generation, d138Generation)
      return wal
    },
  }
  const secrets = new Map([["old-d138", "old-d138-secret"], ["new-d138", "new-d83-secret"]])
  const expected = {
    sourceRepoId: original, destinationRepoId: destination, destinationCommitSha: rootSha,
    sourcePassphraseSecretId: "old-d138", destinationPassphraseSecretId: "new-d138", deviceId: "d83",
  }
  const settings = {
    githubOwner: "owner", githubRepo: "repo", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "old-d138", vault: "d83",
  }
  const restart = {
    runId: d137Run, indexRoot: shadow.activeIndexRoot, expected, settings,
    sourceCommitSha: pinned, backupRepoId: d138Backup, expectedWalGeneration: d138Generation,
    indexAdapter: s.adapter, journal,
    getSecret: (id: string) => secrets.get(id) ?? null,
    assertExclusiveInitiatorLease: shadow.assertExclusiveInitiatorLease,
    assertCrashDurable: shadow.assertCrashDurable,
  }
  await prepareV4ReencryptionLocalCutoverIntent({
    adapter: s.adapter, activeIndexRoot: restart.indexRoot, runId: d137Run,
    sourceRepoId: original, backupRepoId: d138Backup, destinationRepoId: destination,
    sourceCommitSha: pinned, destinationCommitSha: rootSha,
    sourcePassphraseSecretId: "old-d138", destinationPassphraseSecretId: "new-d138",
    deviceId: "d83", walGeneration: d138Generation,
    assertExclusiveInitiatorLease: shadow.assertExclusiveInitiatorLease,
    assertCrashDurable: shadow.assertCrashDurable,
  })
  let held = false
  let holderCalls = 0
  const withExclusiveInitiatorLease = async <T>(action: () => Promise<T>): Promise<T> => {
    if (held) throw new Error("duplicate exclusive holder")
    held = true
    holderCalls++
    try { return await action() } finally { held = false }
  }
  const input = () => ({ restart, shadow, preparedCandidate: prepared, withExclusiveInitiatorLease })
  return {
    ...s, restart, shadow, prepared, secrets, journal, input,
    setWal: (value: V4ReencryptionJournalSnapshot) => { wal = value },
    getWal: () => wal,
    holderCounts: () => ({ calls: holderCalls, held }),
  }
}

test("D138 uses one held lease to reconcile authenticated WAL, exact Intent, Source, Shadow, manifest and full Git content", async () => {
  const s = await d138Scenario()
  const initial = new Map(s.files)
  const writes = s.getWrites()
  const report = await inspectV4ReencryptionCrossSurfaceProof(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-wal-intent-local-shadow-and-verified-git",
    observation: "all-surfaces-coherent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.holderCounts(), { calls: 1, held: false })
  assert.deepEqual(s.files, initial)
  assert.equal(s.getWrites(), writes)
  assert.doesNotMatch(JSON.stringify(report), /d138-secret|new-d83-secret|秘密|Unicode/)
})

test("D138 rejects WAL manifest that authenticates different ciphertext receipts without trusting a valid Git proof", async () => {
  const s = await d138Scenario()
  s.shadow.remote.expectedReceipts[0]!.byteLength++
  const report = await inspectV4ReencryptionCrossSurfaceProof(s.input())
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(s.f.reads, 0)
})

test("D138 detects GitHub GET reader replacement before D137 starts, while WAL is inspected", async () => {
  const s = await d138Scenario()
  const originalRead = s.restart.journal.assertHealthySnapshot
  let swapped = false
  s.restart.journal.assertHealthySnapshot = async generation => {
    if (!swapped) {
      swapped = true
      const read = s.f.github.getGitRef
      s.f.github.getGitRef = async () => read()
    }
    return originalRead(generation)
  }
  const report = await inspectV4ReencryptionCrossSurfaceProof(s.input())
  assert.equal(swapped, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(s.f.reads, 0)
})

test("D138 refuses a changed WAL generation or ref receipt after its full remote verification starts", async () => {
  const s = await d138Scenario()
  const blob = s.f.github.getBlob
  let altered = false
  s.f.github.getBlob = async sha => {
    if (!altered) {
      altered = true
      const current = s.getWal()
      s.setWal({ ...current, verifiedRefObservations: [
        current.verifiedRefObservations[0]!,
        { ...current.verifiedRefObservations[1]!, treeSha: "9".repeat(40) },
      ] })
    }
    return blob(sha)
  }
  const report = await inspectV4ReencryptionCrossSurfaceProof(s.input())
  assert.equal(altered, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.deepEqual(s.holderCounts(), { calls: 1, held: false })
})

test("D138 refuses changed Source Index or Intent even if encrypted Git remote remains valid", async () => {
  const s = await d138Scenario()
  const blob = s.f.github.getBlob
  let changed = false
  s.f.github.getBlob = async sha => {
    if (!changed) {
      changed = true
      const source = await loadV4LocalIndex(s.adapter, "private/index")
      source.generation++
      await saveV4LocalIndex(s.adapter, "private/index", source)
    }
    return blob(sha)
  }
  const report = await inspectV4ReencryptionCrossSurfaceProof(s.input())
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
})

test("D138 detects wrong SecretStorage new value before decrypting remote and rejects changing identity", async () => {
  const s = await d138Scenario()
  s.secrets.set("new-d138", "another-password")
  assert.equal((await inspectV4ReencryptionCrossSurfaceProof(s.input())).observation, "manual-recovery-required")
  assert.equal(s.f.reads, 0)
  const other = await d138Scenario()
  other.prepared.commitSha = "1".repeat(40)
  await assert.rejects(
    () => inspectV4ReencryptionCrossSurfaceProof(other.input()), /one pinned candidate/i,
  )
})

test("D138 rejects a torn local Intent and an independently attested Backup tree mismatch", async () => {
  const torn = await d138Scenario()
  torn.files.set("private/index-rekey-intent-" + d137Run + "/intent.json", "{truncated")
  assert.equal((await inspectV4ReencryptionCrossSurfaceProof(torn.input())).observation,
    "manual-recovery-required")
  assert.equal(torn.f.reads, 0)

  const badBackup = await d138Scenario()
  const wal = badBackup.getWal()
  badBackup.setWal({
    ...wal, verifiedRefObservations: [
      { ...wal.verifiedRefObservations[0]!, treeSha: "9".repeat(40) },
      wal.verifiedRefObservations[1]!,
    ],
  })
  assert.equal((await inspectV4ReencryptionCrossSurfaceProof(badBackup.input())).observation,
    "manual-recovery-required")
  assert.equal(badBackup.f.reads, 0)
})

test("D138 leaves the holder on remote transport error and denies a holder that never inspects", async () => {
  const transport = await d138Scenario()
  transport.f.github.getBlob = async () => { throw new Error("synthetic GitHub GET failure") }
  await assert.rejects(() => inspectV4ReencryptionCrossSurfaceProof(transport.input()),
    /synthetic GitHub GET failure/)
  assert.deepEqual(transport.holderCounts(), { calls: 1, held: false })

  const empty = await d138Scenario()
  const input = empty.input()
  const report = await inspectV4ReencryptionCrossSurfaceProof({
    ...input, withExclusiveInitiatorLease: async () => ({
      integrityScope: "read-only-wal-intent-local-shadow-and-verified-git" as const,
      observation: "all-surfaces-coherent-uncommitted" as const,
      localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
      rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
      oldPassphraseCleanupAuthorized: false as const,
    }) as never,
  })
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(empty.f.reads, 0)
})

test("D138 propagates lease or WAL storage failure without granting cutover and releases lease after error", async () => {
  const s = await d138Scenario()
  const input = s.input()
  await assert.rejects(
    () => inspectV4ReencryptionCrossSurfaceProof({
      ...input,
      restart: { ...input.restart, assertExclusiveInitiatorLease: async () => { throw Error("lease lost") } },
    }), /one pinned candidate/i,
  )
  const failed = await d138Scenario()
  failed.restart.journal.assertHealthySnapshot = async () => { throw Error("WAL corrupted") }
  await assert.rejects(() => inspectV4ReencryptionCrossSurfaceProof(failed.input()), /WAL corrupted/)
  assert.deepEqual(failed.holderCounts(), { calls: 1, held: false })
})
