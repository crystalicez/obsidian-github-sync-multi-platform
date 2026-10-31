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
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { armV4ReencryptionSyncFence, V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import { inspectV4FencedFullRemoteShadowAfterRestart, type V4FencedFullRemoteShadowInput } from "../../src/lib/v4/reencryption-fenced-full-shadow-verification"
import type { V4FencedThreeBranchRevalidationInput } from "../../src/lib/v4/reencryption-fenced-three-branch-revalidation"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import type { V4ThreeBranchPublicationReport } from "../../src/lib/v4/reencryption-three-branch-publish"
import { inspectV4ReencryptionCrossSurfaceProof } from "../../src/lib/v4/reencryption-cross-surface-proof"
import { inspectV4FencedPrecommitReadinessAfterRestart } from "../../src/lib/v4/reencryption-fenced-precommit-readiness"
import { inspectV4FencedCrashWindowPairAfterRestart } from "../../src/lib/v4/reencryption-fenced-crash-window-pair-inspection"
import { inspectV4FencedLocalCrashTriageAfterRestart } from "../../src/lib/v4/reencryption-fenced-local-crash-triage"
import { deriveV4FencedCommitPairSnapshotTestContract, inspectV4FencedCommitPairSnapshotTestVectors } from "../../src/lib/v4/reencryption-fenced-commit-pair-snapshot-provenance"
import { sealV4ReencryptionCommitPairTestVectors, type V4ReencryptionCommitPairTestContract } from "../../src/lib/v4/reencryption-commit-pair-test-vectors"
import { stageV4FencedBestEffortPreparedSelector } from "../../src/lib/v4/reencryption-fenced-prepared-selector"
import type { V4BestEffortPreparedSelectorStageInput } from "../../src/lib/v4/reencryption-prepared-selector-stage"
import { inspectV4ReencryptionLiveBackupCrossSurface } from "../../src/lib/v4/reencryption-live-backup-cross-surface"
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

async function makeBase(deviceId = "d83") {
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
    deviceId, updatedAt: 4, shardHashes,
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
const d178BasePromise = makeBase("device_d178")

async function fixture(deviceId = "d83") {
  const b = await (deviceId === "device_d178" ? d178BasePromise : basePromise)
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
async function d137Scenario(activeIndexRoot = "private/index", expectedDeviceId = "d83") {
  const activeShadow = activeIndexRoot + "-rekey-" + d137Run
  const f = await fixture(expectedDeviceId)
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  let writes = 0
  const adapter: V4LocalIndexAdapter = {
    async read(path) { const raw = files.get(path); if (raw === undefined) throw Error("missing"); return raw },
    async write(path, value) { writes++; files.set(path, value) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
  }
  const index = createEmptyV4LocalIndex({ repoId: destination, deviceId: expectedDeviceId, mode: "encrypted" })
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
  await saveV4LocalIndex(adapter, activeShadow, index)
  const { expectedRecords: _ignored, ...remote } = args(f)
  const lease = async () => {}
  const durable = async () => {}
  const input = () => ({
    adapter, activeIndexRoot, runId: d137Run,
    expectedDeviceId, remote, assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
  })
  return { f, adapter, files, dirs, input, getWrites: () => writes }
}

const d178Backup = "owner/repo#backup/d178"
const d178Bytes = String(14 + 8 * 1024 * 1024 + 13)

async function d178Scenario() {
  const s = await d137Scenario(V4_RUNTIME_INDEX_ROOT, "device_d178")
  let held = false
  let fullRefChecks = 0
  let walChecks = 0
  let snapshotReads = 0
  const lease = async () => { assert.equal(held, true) }
  const holder = async <T>(callback: () => Promise<T>): Promise<T> => {
    assert.equal(held, false)
    held = true
    try { return await callback() } finally { held = false }
  }
  const identity: V4ReencryptionProposedCommitIdentity = {
    runId: d137Run, walGeneration: 8, indexRoot: V4_RUNTIME_INDEX_ROOT,
    deviceId: "device_d178",
    sourceRepoId: original, backupRepoId: d178Backup, destinationRepoId: destination,
    sourceCommitSha: pinned, sourceTreeSha: sourceTree,
    destinationCommitSha: rootSha, destinationTreeSha: treeSha,
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
  }
  const publication: V4ThreeBranchPublicationReport = {
    integrityScope: "three-branch-verified-backup-and-destination-remote-only",
    sourceRepoId: original, backupRepoId: d178Backup, destinationRepoId: destination,
    originalSourceCommitSha: pinned, destinationCommitSha: rootSha,
    verifiedFileCount: 3, verifiedPlaintextBytes: d178Bytes,
    backupContentsReadbackVerified: true, backupScratchRoundTripVerified: true,
    destinationContentsReadbackVerified: true, oldBranchSyncRemainsIndependent: true,
    powerLossDurabilityIndependentlyAudited: false, initiatingDeviceCutoverAuthorized: false,
  }
  let snapshot: V4ReencryptionJournalSnapshot = {
    generation: 8, receipts: s.f.receipts.map(r => ({ ...r })), pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: d178Backup, commitSha: pinned, treeSha: sourceTree },
      { role: "destination", repoId: destination, commitSha: rootSha, treeSha,
        manifestSha256: identity.manifestSha256 },
    ],
    preparedCandidateReceipt: {
      commitSha: rootSha, treeSha, manifestSha256: identity.manifestSha256,
    },
    candidatePreparationSha256: "f".repeat(64), stageHandoffStarted: true,
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const journal = {
    sourceCommitSha: pinned, destinationRepoId: destination,
    async assertHealthySnapshot(gen: number) {
      assert.equal(held, true)
      assert.equal(gen, 8)
      snapshotReads++
      return structuredClone(snapshot)
    },
  }
  const wal = {
    async assertExclusiveStageLease() { assert.equal(held, true) },
    async assertBestEffortCheckpoint() {
      assert.equal(held, true)
      walChecks++
      return "best-effort-readback-only" as const
    },
  }
  const gh = Object.assign(s.f.github, {
    branchName: "rekey/d83",
    async getRepositoryDefaultBranch() { assert.equal(held, true); return "main" },
    async getGitRefOrNull() {
      assert.equal(held, true)
      fullRefChecks++
      return s.f.github.getGitRef()
    },
  })
  type Reader = V4FencedThreeBranchRevalidationInput["readers"]["source"]
  const branchReader = (repoId: string): Reader => {
    const branch = repoId.split("#")[1]!
    return {
      branchName: branch,
      async getRepositoryIdentity() { assert.equal(held, true); return { id: 88, fullName: "owner/repo" } },
      async getRepositoryDefaultBranch() { assert.equal(held, true); return "main" },
      async getGitRefOrNull() {
        assert.equal(held, true)
        return { ref: "refs/heads/" + branch, type: "commit" as const, sha: pinned }
      },
      async getGitCommit() {
        assert.equal(held, true)
        return { sha: pinned, treeSha: sourceTree,
          parentShas: ["1".repeat(40)], message: "source" }
      },
    } as Reader
  }
  const readers: V4FencedThreeBranchRevalidationInput["readers"] = {
    source: branchReader(original), backup: branchReader(d178Backup),
    destination: gh as unknown as Reader,
  }
  const branches: V4FencedThreeBranchRevalidationInput = {
    identity, publication, physicalRepositoryId: 88,
    adapter: s.adapter, journal, wal, readers,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk",
    assertExclusiveInitiatorLease: lease,
    withExclusiveInitiatorLease: holder,
  }
  const shadow = {
    ...s.input(),
    assertExclusiveInitiatorLease: lease,
  }
  const input: V4FencedFullRemoteShadowInput = { branches, shadow }
  await holder(async () => armV4ReencryptionSyncFence({
    adapter: s.adapter, runId: identity.runId,
    sourceRepoId: original, destinationRepoId: destination,
    assertExclusiveInitiatorLease: lease,
  }))
  const inspect = () => inspectV4FencedFullRemoteShadowAfterRestart(input)
  return {
    s, input, inspect, identity, journal, wal, publication, gh, snapshot: () => snapshot,
    setSnapshot: (next: V4ReencryptionJournalSnapshot) => { snapshot = next },
    get walChecks() { return walChecks },
    get snapshotReads() { return snapshotReads },
    get fullRefChecks() { return fullRefChecks },
  }
}

test("D178 real complete encrypted Git content verifies against Shadow with Fence and WAL but never permits Cutover", async () => {
  const f = await d178Scenario()
  const files = new Map(f.s.files)
  const writes = f.s.getWrites()
  const result = await f.inspect()
  assert.deepEqual(result, {
    integrityScope: "read-only-fenced-full-destination-content-and-shadow",
    observation: "complete-destination-matches-shadow-uncommitted",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    completeRemoteContentReverified: true,
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(f.s.files, files)
  assert.equal(f.s.getWrites(), writes)
  assert.ok(f.s.f.reads >= 4)
  assert.ok(f.fullRefChecks >= 4)
  assert.ok(f.snapshotReads >= 4)
  assert.ok(f.walChecks >= 6)
  assert.equal(f.s.files.has(V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + d137Run + "/selector.json"), false)
  assert.equal(f.s.dirs.has(V4_REENCRYPTION_SYNC_FENCE_ROOT), true)
})

test("D178 tampered content, Shadow, historical byte count and missing WAL upload receipt fail closed", async () => {
  const cases = ["ciphertext", "shadow", "bytes", "receipt", "fence", "passphrase"] as const
  for (const cause of cases) {
    const f = await d178Scenario()
    if (cause === "ciphertext") {
      const sha = f.s.f.receipts[0]!.sha
      f.s.f.blobs.set(sha, new Uint8Array([1, 2, 3]))
    } else if (cause === "shadow") {
      const root = V4_RUNTIME_INDEX_ROOT + "-rekey-" + d137Run
      const index = await loadV4LocalIndex(f.s.adapter, root)
      index.epoch += 1
      await saveV4LocalIndex(f.s.adapter, root, index)
    } else if (cause === "bytes") {
      (f.input.branches as { publication: V4ThreeBranchPublicationReport }).publication =
        { ...f.publication, verifiedPlaintextBytes: "1" }
    } else if (cause === "receipt") {
      f.setSnapshot({ ...f.snapshot(), receipts: f.snapshot().receipts.slice(1) })
    } else if (cause === "fence") {
      f.s.files.set(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{torn")
    } else {
      (f.input.shadow.remote as { destinationPassphrase: string }).destinationPassphrase = "wrong-passphrase"
    }
    const before = f.s.getWrites()
    assert.equal((await f.inspect()).observation, "manual-recovery-required", cause)
    assert.equal(f.s.getWrites(), before, cause)
  }
})

test("D178 a Destination ref moved during full ciphertext scan denies full-content proof", async () => {
  const f = await d178Scenario()
  const originalGetBlob = f.gh.getBlob
  let moved = false
  f.gh.getBlob = async (sha: string) => {
    const bytes = await originalGetBlob(sha)
    if (!moved) {
      moved = true
      f.s.f.changeRef("9".repeat(40))
    }
    return bytes
  }
  const before = f.s.getWrites()
  assert.equal((await f.inspect()).observation, "manual-recovery-required")
  assert.equal(moved, true)
  assert.equal(f.s.getWrites(), before)
})

test("D178 equivalent WAL ciphertext receipts in a different order still authenticate", async () => {
  const f = await d178Scenario()
  const original = f.input.shadow.remote.expectedReceipts
  ;(f.input.shadow.remote as { expectedReceipts: typeof original }).expectedReceipts = [...original].reverse()
  assert.equal((await f.inspect()).observation, "complete-destination-matches-shadow-uncommitted")
})

test("D178 changing Source reader or publication evidence during Git blob scan denies observation", async () => {
  for (const cause of ["source-reader", "publication"] as const) {
    const f = await d178Scenario()
    const getBlob = f.gh.getBlob
    let modified = false
    f.gh.getBlob = async (sha: string) => {
      const bytes = await getBlob(sha)
      if (!modified) {
        modified = true
        if (cause === "source-reader") {
          f.input.branches.readers.source.getGitCommit = async () => ({
            sha: pinned, treeSha: sourceTree, parentShas: ["1".repeat(40)], message: "swapped",
          })
        } else {
          (f.input.branches.publication as { verifiedPlaintextBytes: string }).verifiedPlaintextBytes = "1"
        }
      }
      return bytes
    }
    const writes = f.s.getWrites()
    assert.equal((await f.inspect()).observation, "manual-recovery-required", cause)
    assert.equal(modified, true)
    assert.equal(f.s.getWrites(), writes)
  }
})

test("D175 verified remote Destination binds to a Shadow beside the unchanged runtime Source root", async () => {
  const s = await d137Scenario(V4_RUNTIME_INDEX_ROOT)
  const before = new Map(s.files)
  const writes = s.getWrites()
  const report = await verifyV4ReencryptionShadowAgainstDestination(s.input())
  assert.equal(report.observation, "shadow-matches-verified-destination-uncommitted")
  assert.equal(report.verifiedFileCount, 3)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.deepEqual(s.files, before)
  assert.equal(s.getWrites(), writes)
  assert.equal(s.files.has(d137Shadow + "/header.json"), false)
})

test("D137 verified immutable remote plaintext and all committed records bind to Shadow without a write", async () => {
  const s = await d137Scenario()
  const before = new Map(s.files)
  const writes = s.getWrites()
  const report = await verifyV4ReencryptionShadowAgainstDestination(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-verified-git-content-to-local-shadow",
    observation: "shadow-matches-verified-destination-uncommitted",
    destinationRepoId: destination, destinationCommitSha: rootSha, verifiedFileCount: 3,
    verifiedPlaintextBytes: String(14 + 8 * 1024 * 1024 + 13),
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

async function d138Scenario(activeIndexRoot = "private/index", expectedDeviceId = "d83") {
  const s = await d137Scenario(activeIndexRoot, expectedDeviceId)
  const shadow = s.input()
  const sourceIndex = createEmptyV4LocalIndex({ repoId: original, deviceId: expectedDeviceId, mode: "encrypted" })
  sourceIndex.remoteCommitSha = pinned
  await saveV4LocalIndex(s.adapter, shadow.activeIndexRoot, sourceIndex)

  const prepared: V4PreparedOrphanCommit = {
    integrityScope: "unreferenced-encrypted-orphan-commit",
    destinationRepoId: destination, pinnedSourceCommitSha: pinned,
    physicalRepositoryId: 88, sourceTreeSha: sourceTree, treeSha,
    commitSha: rootSha, verifiedFileCount: 3,
    stagedCiphertextObjectCount: shadow.remote.expectedReceipts.length,
    encryptedMetadataObjectCount: 2 + Object.keys(s.f.head.shardHashes).length,
    deviceId: expectedDeviceId, journalId: "d138_journal", createdAt: 123,
    sourceAndBackupPreserved: true, rootHasZeroParents: true,
    backupProvenanceVerified: false, installedRestoreVerified: false,
    refPublished: false, cutoverAuthorized: false,
  }
  const savedShadow = await loadV4LocalIndex(s.adapter, activeIndexRoot + "-rekey-" + d137Run)
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
    sourcePassphraseSecretId: "old-d138", destinationPassphraseSecretId: "new-d138", deviceId: expectedDeviceId,
  }
  const settings = {
    githubOwner: "owner", githubRepo: "repo", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "old-d138", vault: expectedDeviceId,
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
    deviceId: expectedDeviceId, walGeneration: d138Generation,
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

async function d179Scenario() {
  const s = await d138Scenario(V4_RUNTIME_INDEX_ROOT, "device_d178")
  s.setWal({ ...s.getWal(), receipts: s.shadow.remote.expectedReceipts.map(r => ({ ...r })) })
  const exclusive = s.input().withExclusiveInitiatorLease
  const lease = async () => { assert.equal(s.holderCounts().held, true) }
  const wal = {
    async assertExclusiveStageLease() { await lease() },
    async assertBestEffortCheckpoint() {
      await lease()
      return "best-effort-readback-only" as const
    },
  }
  const id: V4ReencryptionProposedCommitIdentity = {
    runId: d137Run, walGeneration: d138Generation, indexRoot: V4_RUNTIME_INDEX_ROOT,
    deviceId: "device_d178", sourceRepoId: original, backupRepoId: d138Backup,
    destinationRepoId: destination, sourceCommitSha: pinned, sourceTreeSha: sourceTree,
    destinationCommitSha: rootSha, destinationTreeSha: treeSha,
    manifestSha256: s.getWal().preparedCandidateReceipt!.manifestSha256,
    sourcePassphraseSecretId: "old-d138", destinationPassphraseSecretId: "new-d138",
  }
  const client = Object.assign(s.f.github, {
    branchName: "rekey/d83",
    async getRepositoryDefaultBranch() { await lease(); return "main" },
    async getGitRefOrNull() { await lease(); return s.f.github.getGitRef() },
  })
  type Reader = V4FencedThreeBranchRevalidationInput["readers"]["source"]
  const reader = (repoId: string): Reader => {
    const branch = repoId.split("#")[1]!
    return {
      branchName: branch,
      async getRepositoryIdentity() { await lease(); return { id: 88, fullName: "owner/repo" } },
      async getRepositoryDefaultBranch() { await lease(); return "main" },
      async getGitRefOrNull() {
        await lease()
        return { ref: "refs/heads/" + branch, type: "commit" as const, sha: pinned }
      },
      async getGitCommit() {
        await lease()
        return { sha: pinned, treeSha: sourceTree,
          parentShas: ["1".repeat(40)], message: "source" }
      },
    } as Reader
  }
  const publication: V4ThreeBranchPublicationReport = {
    integrityScope: "three-branch-verified-backup-and-destination-remote-only",
    sourceRepoId: original, backupRepoId: d138Backup, destinationRepoId: destination,
    originalSourceCommitSha: pinned, destinationCommitSha: rootSha,
    verifiedFileCount: 3, verifiedPlaintextBytes: d178Bytes,
    backupContentsReadbackVerified: true, backupScratchRoundTripVerified: true,
    destinationContentsReadbackVerified: true, oldBranchSyncRemainsIndependent: true,
    powerLossDurabilityIndependentlyAudited: false, initiatingDeviceCutoverAuthorized: false,
  }
  const readers = {
    source: reader(original), backup: reader(d138Backup),
    destination: client as unknown as Reader,
  }
  const branches: V4FencedThreeBranchRevalidationInput = {
    identity: id, publication, readers, physicalRepositoryId: 88,
    adapter: s.adapter, wal, journal: s.journal,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk",
    assertExclusiveInitiatorLease: lease, withExclusiveInitiatorLease: exclusive,
  }
  const shadow = { ...s.shadow, assertExclusiveInitiatorLease: lease }
  const restart = {
    ...s.restart, assertExclusiveInitiatorLease: lease, wal,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
  }
  const prepared: V4BestEffortPreparedSelectorStageInput = {
    restart, identity: { ...id }, journalKey: new Uint8Array(32).fill(0x79),
    withExclusiveInitiatorLease: exclusive,
  }
  await exclusive(async () => armV4ReencryptionSyncFence({
    adapter: s.adapter, runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
    assertExclusiveInitiatorLease: lease,
  }))
  const staged = await stageV4FencedBestEffortPreparedSelector(prepared)
  assert.equal(staged.status, "authenticated-prepared-selector-uncommitted")
  const input = { full: { branches, shadow }, prepared, candidate: s.prepared }
  return { s, id, input, publication, prepared, staged,
    inspect: () => inspectV4FencedPrecommitReadinessAfterRestart(input) }
}

const d183TransactionId = "ac".repeat(16)
const d183Input = (f: Awaited<ReturnType<typeof d179Scenario>>) => ({
  readiness: f.input, transactionId: d183TransactionId,
})
async function d183PreparedPair(f: Awaited<ReturnType<typeof d179Scenario>>) {
  const report = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.equal(report.observation, "snapshot-contract-derived-uncommitted")
  assert.ok(report.contract)
  const contract = report.contract!
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, f.prepared.journalKey)
  return { contract, pair }
}

test("D183 derives real D179 Source/Shadow/Prepared/WAL/Settings hashes under one held lease without writes", async () => {
  const f = await d179Scenario()
  const firstFiles = new Map(f.s.files)
  const before = f.s.getWrites()
  const calls = f.s.holderCounts().calls
  const result = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.equal(result.observation, "snapshot-contract-derived-uncommitted")
  assert.equal(result.evidence, "best-effort-wal-readback-not-power-loss-durable")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.ok(result.contract)
  assert.equal(Object.isFrozen(result.contract), true)
  assert.equal(Object.isFrozen(result.contract!.identity), true)
  const actual = result.contract!
  const hash = (text: string) => sha256Hex(utf8ToBytes(text))
  const source = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
  const shadow = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId)
  assert.equal(actual.transactionId, d183TransactionId)
  assert.deepEqual(actual.identity, f.id)
  assert.equal(actual.sourceIndexSha256, await hash(JSON.stringify(source)))
  assert.equal(actual.destinationShadowSha256, await hash(JSON.stringify(shadow)))
  assert.equal(actual.preparedEvidenceSha256, await hash(f.s.files.get(f.staged.evidencePath)!))
  assert.equal(actual.walSnapshotSha256, await hash(JSON.stringify(f.s.getWal())))
  assert.equal(actual.sourceSettingsSha256, await hash(JSON.stringify(f.input.prepared.restart.settings)))
  assert.equal(actual.destinationSettingsSha256, await hash(JSON.stringify({
    ...f.input.prepared.restart.settings,
    githubBranch: destination.split("#")[1],
    encryptionPassphraseSecretId: f.id.destinationPassphraseSecretId,
  })))
  assert.deepEqual(f.s.files, firstFiles)
  assert.equal(f.s.getWrites(), before)
  assert.deepEqual(f.s.holderCounts(), { calls: calls + 1, held: false })
  assert.ok(f.s.f.reads >= 8)
})

test("D183 re-derives all snapshot hashes and authenticates pair only as uncommitted", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  const writes = f.s.getWrites()
  const previousCalls = f.s.holderCounts().calls
  const report = await inspectV4FencedCommitPairSnapshotTestVectors(d183Input(f), contract, pair)
  assert.equal(report.observation, "snapshot-bound-pair-authenticated-uncommitted")
  assert.deepEqual(report.contract, contract)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.rollbackAuthorized, false)
  assert.equal(report.remoteWritesAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.deepEqual(f.s.holderCounts(), { calls: previousCalls + 1, held: false })
  assert.equal(f.s.files.has(V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"), false)
  assert.doesNotMatch(JSON.stringify(report), /old-d138-secret|new-d83-secret/)
})

test("D183 caller digest claims, transaction IDs, mismatched AES pair and historical WAL fail closed", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  const edits: Array<{ kind: string; contract: V4ReencryptionCommitPairTestContract }> = [
    { kind: "source", contract: { ...contract, sourceIndexSha256: "1".repeat(64) } },
    { kind: "shadow", contract: { ...contract, destinationShadowSha256: "1".repeat(64) } },
    { kind: "wal", contract: { ...contract, walSnapshotSha256: "1".repeat(64) } },
    { kind: "prepared", contract: { ...contract, preparedEvidenceSha256: "1".repeat(64) } },
    { kind: "settings", contract: { ...contract, sourceSettingsSha256: "1".repeat(64) } },
    { kind: "target", contract: { ...contract, destinationSettingsSha256: "1".repeat(64) } },
    { kind: "transaction", contract: { ...contract, transactionId: "ed".repeat(16) } },
  ]
  for (const c of edits) {
    const writes = f.s.getWrites()
    const report = await inspectV4FencedCommitPairSnapshotTestVectors(d183Input(f), c.contract, pair)
    assert.equal(report.observation, "manual-recovery-required", c.kind)
    assert.equal(report.contract, null, c.kind)
    assert.equal(report.localCutoverAuthorized, false, c.kind)
    assert.equal(f.s.getWrites(), writes, c.kind)
  }
  const other = await sealV4ReencryptionCommitPairTestVectors(contract, f.prepared.journalKey)
  assert.equal((await inspectV4FencedCommitPairSnapshotTestVectors(d183Input(f), contract, {
    receiptTestVector: other.receiptTestVector, selectorTestVector: pair.selectorTestVector,
  })).observation, "manual-recovery-required")
})

test("D183 stale WAL, torn Prepared, changed Source and wrong new Secret never certify snapshot provenance", async () => {
  for (const cause of ["wal", "prepared", "source", "secret", "fence", "residue"] as const) {
    const f = await d179Scenario()
    if (cause === "wal") f.s.setWal({ ...f.s.getWal(), generation: 99 })
    else if (cause === "prepared") f.s.files.set(f.staged.evidencePath, "{torn")
    else if (cause === "source") f.input.prepared.restart.settings.githubBranch = "different"
    else if (cause === "secret") f.s.secrets.set("new-d138", "wrong-secret")
    else if (cause === "fence") f.s.files.set(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{torn")
    else f.s.files.set(V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/marker.json", "unexpected")
    const writes = f.s.getWrites()
    const result = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.contract, null, cause)
    assert.equal(result.resumeSyncAuthorized, false)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D183 mutation during real Git Blob read denies provenance even when original contract authenticates", async () => {
  for (const cause of ["source-index", "secret", "destination-ref"] as const) {
    const f = await d179Scenario()
    const { contract, pair } = await d183PreparedPair(f)
    const getBlob = f.s.f.github.getBlob
    let changed = false
    f.s.f.github.getBlob = async sha => {
      const bytes = await getBlob(sha)
      if (!changed) {
        changed = true
        if (cause === "source-index") {
          const source = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
          source.epoch++
          await saveV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT, source)
        } else if (cause === "secret") f.s.secrets.set("new-d138", "different-key-mid-git")
        else f.s.f.changeRef("9".repeat(40))
      }
      return bytes
    }
    const writes = f.s.getWrites()
    const result = await inspectV4FencedCommitPairSnapshotTestVectors(d183Input(f), contract, pair)
    assert.equal(changed, true, cause)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.contract, null, cause)
    assert.equal(result.localCutoverAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes + (cause === "source-index" ? 1 : 0), cause)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D183 holder must execute provenance reader once, not skip or forge a success result", async () => {
  const f = await d179Scenario()
  const original = f.input.full.branches.withExclusiveInitiatorLease
  const input = d183Input(f)
  const branches = f.input.full.branches
  const prepared = f.input.prepared
  const forged = async <T>(_body: () => Promise<T>): Promise<T> => ({
    integrityScope: "read-only-fenced-d179-verified-commit-pair-snapshot-contract",
    observation: "snapshot-contract-derived-uncommitted",
  } as T)
  branches.withExclusiveInitiatorLease = forged
  prepared.withExclusiveInitiatorLease = forged
  assert.equal((await deriveV4FencedCommitPairSnapshotTestContract(input)).observation,
    "manual-recovery-required")
  branches.withExclusiveInitiatorLease = original
  prepared.withExclusiveInitiatorLease = original
})

test("D183 post-holder Git reader or publication mutation refuses apparently valid snapshot proof", async () => {
  for (const cause of ["reader", "publication"] as const) {
    const f = await d179Scenario()
    const original = f.input.full.branches.withExclusiveInitiatorLease
    const guarded = async <T>(action: () => Promise<T>): Promise<T> =>
      original(async () => {
        const result = await action()
        if (cause === "reader") {
          f.input.full.branches.readers.source.getGitCommit = async () => ({
            sha: pinned, treeSha: sourceTree,
            parentShas: ["1".repeat(40)], message: "post-holder-swap",
          })
        } else f.publication.verifiedPlaintextBytes = "0"
        return result
      })
    f.input.full.branches.withExclusiveInitiatorLease = guarded
    f.input.prepared.withExclusiveInitiatorLease = guarded
    const writes = f.s.getWrites()
    const report = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.contract, null, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D183 transaction ID altered during an awaited Git Blob read cannot bind a different attempt", async () => {
  const f = await d179Scenario()
  const input = d183Input(f)
  const originalBlob = f.s.f.github.getBlob
  let changed = false
  f.s.f.github.getBlob = async sha => {
    const bytes = await originalBlob(sha)
    if (!changed) {
      changed = true
      input.transactionId = "ed".repeat(16)
    }
    return bytes
  }
  const writes = f.s.getWrites()
  const report = await deriveV4FencedCommitPairSnapshotTestContract(input)
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.contract, null)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(f.s.holderCounts().held, false)
})

test("D184 historical D183 full-Git-proven pair on local disk remains diagnostic-only after restart", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  const proposed = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  const selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  await f.s.adapter.mkdir(proposed)
  await f.s.adapter.write(proposed + "/marker.json", pair.receiptTestVector)
  await f.s.adapter.write(selector, pair.selectorTestVector)
  const sourceSettings = { ...f.input.prepared.restart.settings }
  const firstFiles = new Map(f.s.files)
  const writes = f.s.getWrites()
  const gitReads = f.s.f.reads
  const calls = f.s.holderCounts().calls
  const report = await inspectV4FencedCrashWindowPairAfterRestart({
    prepared: f.prepared, contract, sourceSettings,
  })
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.reason, "linked-test-pair-not-authoritative")
  assert.equal(report.pairEvidence, "cryptographically-linked-uncommitted")
  assert.equal(report.settingsSelection, "source")
  assert.equal(report.activeIndexSelection, "source")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(f.s.files, firstFiles)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(f.s.f.reads, gitReads, "D184 historical witness is not live Git proof")
  assert.deepEqual(f.s.holderCounts(), { calls: calls + 1, held: false })
  const legacy = await inspectV4FencedLocalCrashTriageAfterRestart(f.prepared)
  assert.equal(legacy.observation, "manual-recovery-required")
  assert.equal(legacy.reason, "unrecognized-selector-or-commit-artifact")
})

test("D179 encrypted Source/Intent/Secrets, D176 prepared Selector, D178 full Git content share one lease", async () => {
  const f = await d179Scenario()
  const before = new Map(f.s.files)
  const writes = f.s.getWrites()
  const count = f.s.holderCounts().calls
  const report = await f.inspect()
  assert.deepEqual(report, {
    integrityScope: "read-only-fenced-source-wal-intent-secrets-full-git-and-prepared-selector",
    observation: "all-prepared-surfaces-coherent-uncommitted",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    completeDestinationContentReverified: true,
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(f.s.files, before)
  assert.equal(f.s.getWrites(), writes)
  assert.deepEqual(f.s.holderCounts(), { calls: count + 1, held: false })
  assert.ok(f.s.f.reads >= 8)
  assert.equal(f.s.secrets.get("old-d138"), "old-d138-secret")
  assert.equal(f.s.restart.settings.githubBranch, "main")
  assert.equal(f.s.files.has(V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + d137Run + "/selector.json"), false)
})

test("D179 altered Intent, Source settings, Secrets, prepared evidence and WAL always block Cutover", async () => {
  for (const cause of ["intent", "source", "secret", "prepared", "wal", "candidate", "fence"] as const) {
    const f = await d179Scenario()
    if (cause === "intent") {
      const path = V4_RUNTIME_INDEX_ROOT + "-rekey-intent-" + d137Run + "/intent.json"
      f.s.files.set(path, "{tampered")
    }
    if (cause === "source") f.s.restart.settings.githubBranch = "unrelated"
    if (cause === "secret") f.s.secrets.set("new-d138", "wrong-new-key")
    if (cause === "prepared") f.s.files.set(f.staged.evidencePath, "not-authenticated")
    if (cause === "wal") f.s.setWal({ ...f.s.getWal(), generation: d138Generation + 1 })
    if (cause === "candidate") {
      (f.input as { candidate: V4PreparedOrphanCommit }).candidate =
        { ...f.s.prepared, treeSha: "8".repeat(40) }
    }
    if (cause === "fence") {
      f.s.files.set(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{missing")
    }
    const writes = f.s.getWrites()
    assert.equal((await f.inspect()).observation, "manual-recovery-required", cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D179 Source Secret changes during authenticated Git read and cannot certify prepared evidence", async () => {
  const f = await d179Scenario()
  const getBlob = f.s.f.github.getBlob
  let changed = false
  f.s.f.github.getBlob = async sha => {
    const bytes = await getBlob(sha)
    if (!changed) {
      changed = true
      f.s.secrets.set("new-d138", "secret-changed-during-fetch")
    }
    return bytes
  }
  const before = f.s.getWrites()
  assert.equal((await f.inspect()).observation, "manual-recovery-required")
  assert.equal(changed, true)
  assert.equal(f.s.getWrites(), before)
  assert.equal(f.s.holderCounts().held, false)
})

test("D179 Source Index modified during remote scan invalidates all local proof without Cutover", async () => {
  const f = await d179Scenario()
  const getBlob = f.s.f.github.getBlob
  let changed = false
  f.s.f.github.getBlob = async sha => {
    const bytes = await getBlob(sha)
    if (!changed) {
      changed = true
      const index = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
      index.epoch++
      await saveV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT, index)
    }
    return bytes
  }
  const before = f.s.getWrites()
  const report = await f.inspect()
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(f.s.getWrites(), before + 1)
  assert.equal(f.s.holderCounts().held, false)
})

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

// D143 reuses the REAL AES-GCM + Git object fixture from D83/D137/D138.
// Only the Backup branch client is additional and is always GET-only.
async function d143Scenario() {
  const s = await d138Scenario()
  let refSha = pinned
  let tree = sourceTree
  let repositoryId = 88
  let defaultBranch = "main"
  let reads = 0
  let onRead: (() => void) | undefined
  const backupReader = {
    branchName: "backup/run_d138",
    async getRepositoryIdentity() {
      reads++
      onRead?.()
      return { id: repositoryId, fullName: "owner/repo" }
    },
    async getRepositoryDefaultBranch() {
      reads++
      return defaultBranch
    },
    async getGitRefOrNull() {
      reads++
      return { ref: "refs/heads/backup/run_d138", type: "commit", sha: refSha }
    },
    async getGitCommit(sha: string) {
      reads++
      return { sha, treeSha: tree, parentShas: ["7".repeat(40)] }
    },
  }
  return {
    ...s, backupReader,
    input: () => ({ ...s.input(), backupReader }),
    moveBackup(sha: string) { refSha = sha },
    changeTree(sha: string) { tree = sha },
    changeRepository(id: number) { repositoryId = id },
    changeDefault(branch: string) { defaultBranch = branch },
    onRepositoryRead(callback: () => void) { onRead = callback },
    backupReads() { return reads },
  }
}

test("D143 one held lease reobserves the live frozen Backup before/after authenticated Destination, never cutover", async () => {
  const s = await d143Scenario()
  const baseline = new Map(s.files)
  const writes = s.getWrites()
  const result = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
  assert.deepEqual(result, {
    integrityScope: "read-only-live-backup-and-full-destination-cross-surface",
    observation: "all-three-ref-evidence-coherent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(s.backupReads(), 8)
  assert.deepEqual(s.holderCounts(), { calls: 1, held: false })
  assert.deepEqual(s.files, baseline)
  assert.equal(s.getWrites(), writes)
  assert.doesNotMatch(JSON.stringify(result), /old-d138-secret|new-d83-secret|秘密|Unicode/)
})

test("D143 Backup ref movement while Destination is verified forces manual review", async () => {
  const s = await d143Scenario()
  const originalBlob = s.f.github.getBlob
  let moved = false
  s.f.github.getBlob = async sha => {
    if (!moved) { moved = true; s.moveBackup("9".repeat(40)) }
    return originalBlob(sha)
  }
  const result = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
  assert.equal(moved, true)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.holderCounts(), { calls: 1, held: false })
})

test("D143 missing/moved Backup, mismatched source tree or physical repository cannot look coherent", async () => {
  for (const kind of ["moved", "tree", "repository", "default", "missing"] as const) {
    const s = await d143Scenario()
    if (kind === "moved") s.moveBackup("9".repeat(40))
    if (kind === "tree") s.changeTree("8".repeat(40))
    if (kind === "repository") s.changeRepository(999)
    if (kind === "default") s.changeDefault("backup/run_d138")
    if (kind === "missing") s.backupReader.getGitRefOrNull = async () => null
    const result = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
    assert.equal(result.observation, "manual-recovery-required")
    assert.equal(result.localCutoverAuthorized, false)
    assert.equal(s.f.reads, 0, "Backup failure must stop before remote ciphertext validation")
  }
})

test("D143 a replaced Backup reader method during D138 WAL read cannot forge a full proof", async () => {
  const s = await d143Scenario()
  const originalWal = s.restart.journal.assertHealthySnapshot
  let replaced = false
  s.restart.journal.assertHealthySnapshot = async generation => {
    if (!replaced) {
      replaced = true
      const oldRef = s.backupReader.getGitRefOrNull
      s.backupReader.getGitRefOrNull = async () => oldRef()
    }
    return originalWal(generation)
  }
  const report = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
  assert.equal(replaced, true)
  assert.equal(report.observation, "manual-recovery-required")
})

test("D143 a Destination GET reader swapped during first Backup lookup cannot masquerade as D138 proof", async () => {
  const s = await d143Scenario()
  let changed = false
  s.onRepositoryRead(() => {
    if (changed) return
    changed = true
    const previous = s.f.github.getGitRef
    s.f.github.getGitRef = async () => previous()
  })
  const report = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.resumeSyncAuthorized, false)
})

test("D143 method replacement inside first live Backup GET is detected", async () => {
  const s = await d143Scenario()
  let mutated = false
  s.onRepositoryRead(() => {
    if (mutated) return
    mutated = true
    const oldCommit = s.backupReader.getGitCommit
    s.backupReader.getGitCommit = async sha => oldCommit(sha)
  })
  const report = await inspectV4ReencryptionLiveBackupCrossSurface(s.input())
  assert.equal(mutated, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(s.f.reads, 0)
})

test("D143 mismatched configured Backup branch rejects input before any remote reads", async () => {
  const s = await d143Scenario()
  s.backupReader.branchName = "rekey/d83"
  await assert.rejects(
    () => inspectV4ReencryptionLiveBackupCrossSurface(s.input()), /exact same-repository frozen Backup/i,
  )
  assert.equal(s.backupReads(), 0)
})

test("D143 loss of the exclusive lease during the final live Backup GET cannot report coherent state", async () => {
  const s = await d143Scenario()
  let calls = 0
  let lost = false
  s.onRepositoryRead(() => { if (++calls === 2) lost = true })
  const assertLease = async () => {
    if (lost) throw new Error("lease lost while final Backup GET was in flight")
  }
  s.restart.assertExclusiveInitiatorLease = assertLease
  s.shadow.assertExclusiveInitiatorLease = assertLease
  await assert.rejects(
    () => inspectV4ReencryptionLiveBackupCrossSurface(s.input()),
    /lease lost while final Backup GET was in flight/,
  )
  assert.equal(calls, 2)
  assert.deepEqual(s.holderCounts(), { calls: 1, held: false })
})

test("D143 transport errors propagate; uncooperative holder cannot forge success", async () => {
  const fail = await d143Scenario()
  fail.backupReader.getGitCommit = async () => { throw new Error("Backup GET network failure") }
  await assert.rejects(
    () => inspectV4ReencryptionLiveBackupCrossSurface(fail.input()), /Backup GET network failure/,
  )
  assert.deepEqual(fail.holderCounts(), { calls: 1, held: false })
  const missing = await d143Scenario()
  const result = await inspectV4ReencryptionLiveBackupCrossSurface({
    ...missing.input(),
    withExclusiveInitiatorLease: async () => ({
      integrityScope: "read-only-live-backup-and-full-destination-cross-surface" as const,
      observation: "all-three-ref-evidence-coherent-uncommitted" as const,
      localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
      rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
      oldPassphraseCleanupAuthorized: false as const,
    }) as never,
  })
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(missing.backupReads(), 0)
})
