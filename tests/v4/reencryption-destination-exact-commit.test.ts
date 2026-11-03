import assert from "node:assert/strict"
import test from "node:test"
import { Platform } from "obsidian"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { sha256Hex, toBase64, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto"
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
import { stageV4FencedCommitPairTestArtifacts } from "../../src/lib/v4/reencryption-fenced-persisted-test-pair"
import { inspectV4FencedPersistedTestPairAfterRestart } from "../../src/lib/v4/reencryption-fenced-persisted-test-pair-restart"
import { inspectV4FencedLivePersistedTestPairAndBackupAfterRestart } from "../../src/lib/v4/reencryption-fenced-live-persisted-test-pair-recovery"
import { classifyV4ReencryptionManualRecovery } from "../../src/lib/v4/reencryption-manual-recovery-triage"
import { stageV4ReencryptionCutoverCandidate } from "../../src/lib/v4/reencryption-cutover-candidate-stage"
import { stageV4FencedLiveReencryptionCandidate, stageV4FencedLiveReencryptionIntent } from "../../src/lib/v4/reencryption-fenced-live-candidate-stage"
import { inspectV4ReencryptionPendingCutoverIntentAfterRestart } from "../../src/lib/v4/reencryption-cutover-intent-restart"
import { inspectV4FencedPendingCutoverSurfacesAfterRestart } from "../../src/lib/v4/reencryption-fenced-intent-surface-restart"
import { inspectV4FencedPendingCommitPreflightAfterRestart } from "../../src/lib/v4/reencryption-fenced-pending-commit-preflight"
import { stageV4FencedCutoverActivationDecision, inspectV4FencedCutoverActivationDecisionAfterRestart } from "../../src/lib/v4/reencryption-activation-decision-stage"
import { inspectV4CutoverActivationDecision } from "../../src/lib/v4/reencryption-activation-decision-crypto"
import { stageV4FencedActivationSettingsSwitchPlan, inspectV4FencedActivationSettingsSwitchPlanAfterRestart } from "../../src/lib/v4/reencryption-activation-switch-plan-stage"
import { inspectV4ActivationSettingsSwitchPlan } from "../../src/lib/v4/reencryption-activation-switch-plan-crypto"
import { writeV4FencedActiveSelectorFirstPhase, inspectV4FencedActiveSelectorAfterRestart } from "../../src/lib/v4/reencryption-active-selector-commit-stage"
import { inspectV4ActiveSelectorCommitPair } from "../../src/lib/v4/reencryption-active-selector-commit-crypto"
import { persistV4FencedDestinationSettings, inspectV4FencedDestinationSettingsAfterRestart } from "../../src/lib/v4/reencryption-persisted-settings-cutover"
import { inspectV4ReencryptionColdStartIndexRoute, authenticateV4RuntimeIndexRouteIntent, V4_REENCRYPTION_RUNTIME_ROUTE_PATH, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT } from "../../src/lib/v4/reencryption-runtime-index-route"
import { assertV4ReencryptionSyncFenceClear, V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import { inspectV4ReencryptionColdStartJournalKey } from "../../src/lib/v4/reencryption-cold-start-journal-key"
import { inspectV4ColdStartDestination } from "../../src/lib/v4/reencryption-cold-start-destination"
import { inspectV4ColdStartWalDestination } from "../../src/lib/v4/reencryption-cold-start-wal-destination"
import { inspectV4ColdStartCompleteRecovery } from "../../src/lib/v4/reencryption-cold-start-complete-recovery"
import { inspectV4DesktopPluginCompleteRecovery, inspectV4MobilePluginCompleteRecovery } from "../../src/lib/v4/reencryption-plugin-complete-recovery"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { openV4ExistingDesktopWalForRecovery } from "../../src/lib/v4/reencryption-desktop-wal-recovery"
import type { V4ReencryptionCutoverSnapshotContract } from "../../src/lib/v4/reencryption-cutover-snapshot-contract"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { GitHubClient } from "../../src/lib/github-api"
import { inspectV4ReencryptionPendingCutoverIntent } from "../../src/lib/v4/reencryption-cutover-intent-crypto"
import { inspectV4ReencryptionCutoverCandidateAfterRestart } from "../../src/lib/v4/reencryption-cutover-candidate-restart"
import { decodeV4ReencryptionCutoverCandidateManifest } from "../../src/lib/v4/reencryption-cutover-candidate-manifest"
import { inspectV4ReencryptionCutoverCandidatePair } from "../../src/lib/v4/reencryption-cutover-candidate-crypto"
import { encodeV4ReencryptionPersistedTestContract, decodeV4ReencryptionPersistedTestContract } from "../../src/lib/v4/reencryption-persisted-test-contract"
import { inspectV4FencedLivePostCrashAfterRestart, inspectV4FencedLivePostCrashAndBackupAfterRestart } from "../../src/lib/v4/reencryption-fenced-live-post-crash-verification"
import type { V4FencedFrozenBackupContentInput } from "../../src/lib/v4/reencryption-fenced-backup-content"
import { proposeV4SameRepositoryReencryptionBackupBranch } from "../../src/lib/v4/reencryption-owner-decisions"
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


async function d238Scenario() {
  const s = await d137Scenario(V4_RUNTIME_INDEX_ROOT, "device_d178")
  const sourceIndex = createEmptyV4LocalIndex({
    repoId: original, deviceId: "device_d178", mode: "encrypted",
  })
  sourceIndex.remoteCommitSha = pinned
  await saveV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT, sourceIndex)
  const source = await loadV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT)
  const shadow = await loadV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + d137Run)
  const contract: V4ReencryptionCutoverSnapshotContract = {
    transactionId: "a".repeat(32),
    identity: {
      runId: d137Run, walGeneration: 10, indexRoot: V4_RUNTIME_INDEX_ROOT,
      deviceId: "device_d178", sourceRepoId: original,
      backupRepoId: "owner/repo#rekey/backup-d238",
      destinationRepoId: destination,
      sourceCommitSha: pinned, sourceTreeSha: sourceTree,
      destinationCommitSha: rootSha, destinationTreeSha: treeSha,
      manifestSha256: "e".repeat(64), sourcePassphraseSecretId: "old-d238",
      destinationPassphraseSecretId: "new-d238",
    },
    sourceIndexSha256: await sha256Hex(enc(JSON.stringify(source))),
    destinationShadowSha256: await sha256Hex(enc(JSON.stringify(shadow))),
    walSnapshotSha256: "1".repeat(64), preparedEvidenceSha256: "2".repeat(64),
    sourceSettingsSha256: "3".repeat(64), destinationSettingsSha256: "4".repeat(64),
  }
  const secrets = new Map([["old-d238", "old-pass"], ["new-d238", "new-d83-secret"]])
  const git = Object.assign(s.f.github, {
    branchName: "rekey/d83",
    async getRepositoryDefaultBranch() { return "main" },
  })
  const { remote } = s.input()
  let ownerValid = true
  const input = {
    adapter: s.adapter, contract, destinationGit: git, remote,
    expectedPhysicalRepositoryId: 88,
    getSecret: (id: string) => secrets.get(id) ?? null,
    assertLiveOwner() { if (!ownerValid) throw Error("D238 owner lost") },
  }
  return { ...s, git, input, secrets, invalidateOwner() { ownerValid = false } }
}

test("D238 fresh owner revalidates complete Destination Git twice against exact Source/Shadow snapshot", async () => {
  const s = await d238Scenario()
  const writes = s.getWrites()
  const files = new Map(s.files)
  const report = await inspectV4ColdStartDestination(s.input)
  assert.equal(report.observation, "complete-destination-still-fenced")
  assert.equal(report.completeDestinationContentsReverified, true)
  assert.equal(report.sourceAndShadowSnapshotMatched, true)
  assert.equal(report.verifiedFileCount, 3)
  assert.equal(report.coldStartWalReverified, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.remoteWritesAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.files, files)
  assert.equal(s.getWrites(), writes)
  assert.ok(s.f.reads > 12, "both full scans must decrypt content from Git")
})

test("D238 a new read-only adapter reconstructs Source and Shadow from real Windows files", async () => {
  const s = await d238Scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const directory = await mkdtemp(path.join(process.cwd(), ".tmp", "d238-cold-destination-"))
  try {
    for (const [relativePath, content] of s.files) {
      const absolute = path.join(directory, relativePath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, "utf8")
    }
    const reader: Pick<V4LocalIndexAdapter, "read" | "exists"> = {
      async read(relativePath: string) {
        return readFile(path.join(directory, relativePath), "utf8")
      },
      async exists(relativePath: string) {
        try {
          await readFile(path.join(directory, relativePath))
          return true
        } catch { return false }
      },
    }
    const writes = s.getWrites()
    const report = await inspectV4ColdStartDestination({
      ...s.input, adapter: reader,
    })
    assert.equal(report.observation, "complete-destination-still-fenced")
    assert.equal(report.resumeSyncAuthorized, false)
    for (const [relativePath, content] of s.files) {
      assert.equal(await readFile(path.join(directory, relativePath), "utf8"), content)
    }
    assert.equal(s.getWrites(), writes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("D238 refuses wrong native secret and source/shadow snapshot digests without Git mutation", async () => {
  for (const cause of ["secret", "source", "shadow", "branch", "tree", "physical", "default", "pinned-physical"] as const) {
    const s = await d238Scenario()
    if (cause === "secret") s.secrets.set("new-d238", "different")
    if (cause === "source") s.input.contract.sourceIndexSha256 = "0".repeat(64)
    if (cause === "shadow") s.input.contract.destinationShadowSha256 = "0".repeat(64)
    if (cause === "branch") s.git.branchName = "rekey/foreign"
    if (cause === "tree") {
      const getCommit = s.git.getGitCommit
      s.git.getGitCommit = async sha => ({ ...(await getCommit(sha)), treeSha: "9".repeat(40) })
    }
    if (cause === "physical") {
      s.git.getRepositoryIdentity = async () => ({ id: 99, fullName: "owner/repo" })
    }
    if (cause === "default") s.git.getRepositoryDefaultBranch = async () => "rekey/d83"
    if (cause === "pinned-physical") s.input.expectedPhysicalRepositoryId = 99
    const writes = s.getWrites()
    const result = await inspectV4ColdStartDestination(s.input)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.completeDestinationContentsReverified, false, cause)
    assert.equal(s.getWrites(), writes, cause)
  }
})

test("D238 notices a changed default branch or cancellation signal during full Git reads", async () => {
  const changedDefault = await d238Scenario()
  let defaultReads = 0
  changedDefault.git.getRepositoryDefaultBranch = async () =>
    ++defaultReads === 1 ? "main" : "alternate"
  assert.equal((await inspectV4ColdStartDestination(changedDefault.input)).observation,
    "manual-recovery-required")
  assert.ok(defaultReads > 1)

  const changedSignal = await d238Scenario()
  const originalBlob = changedSignal.git.getBlob
  let replaced = false
  changedSignal.git.getBlob = async sha => {
    const bytes = await originalBlob(sha)
    if (!replaced) {
      replaced = true
      Object.assign(changedSignal.input.remote, { signal: new AbortController().signal })
    }
    return bytes
  }
  const writes = changedSignal.getWrites()
  assert.equal((await inspectV4ColdStartDestination(changedSignal.input)).observation,
    "manual-recovery-required")
  assert.equal(replaced, true)
  assert.equal(changedSignal.getWrites(), writes)
})

test("D238 current ref, SecretStorage and owner changes during full Git read fail closed", async () => {
  for (const cause of ["ref", "secret", "owner"] as const) {
    const s = await d238Scenario()
    const originalBlob = s.git.getBlob
    let changed = false
    s.git.getBlob = async sha => {
      const result = await originalBlob(sha)
      if (!changed) {
        changed = true
        if (cause === "ref") s.f.changeRef("9".repeat(40))
        if (cause === "secret") s.secrets.set("new-d238", "other-secret")
        if (cause === "owner") s.invalidateOwner()
      }
      return result
    }
    const writes = s.getWrites()
    const result = await inspectV4ColdStartDestination(s.input)
    assert.equal(changed, true, cause)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(s.getWrites(), writes, cause)
  }
})

async function d239Scenario() {
  const s = await d238Scenario()
  const walFiles = new Map<string, string>()
  let walWrites = 0
  const walAdapter: V4LocalIndexAdapter = {
    async read(file) {
      const value = walFiles.get(file)
      if (value === undefined) throw Error("missing encrypted WAL slot")
      return value
    },
    async exists(file) { return walFiles.has(file) },
    async write(file, value) { walWrites++; walFiles.set(file, value) },
    async mkdir() {},
  }
  const root = "reencryption/d239-wal"
  const journalKey = new Uint8Array(32).fill(0x38)
  const id = s.input.contract.identity
  const journal = createV4ReencryptionRecoveryJournal({
    adapter: walAdapter, root, runId: id.runId,
    sourceCommitSha: id.sourceCommitSha, destinationRepoId: id.destinationRepoId,
    journalKey,
  })
  const backup = {
    role: "backup" as const, repoId: id.backupRepoId,
    commitSha: id.sourceCommitSha, treeSha: id.sourceTreeSha,
  }
  const destinationRef = {
    role: "destination" as const, repoId: id.destinationRepoId,
    commitSha: id.destinationCommitSha, treeSha: id.destinationTreeSha,
    manifestSha256: id.manifestSha256,
  }
  let state = await journal.begin()
  state = await journal.recordRefIntent(backup, state.generation)
  state = await journal.markRefReadbackObserved(backup, state.generation)
  state = await journal.recordStagingHandoff(backup, state.generation)
  for (const receipt of s.input.remote.expectedReceipts) {
    state = await journal.recordUploadIntent(receipt, state.generation)
    state = await journal.appendReceipt(receipt, state.generation)
  }
  state = await journal.recordCandidatePreparationIntent("f".repeat(64), state.generation)
  state = await journal.recordPreparedCandidateReceipt({
    commitSha: id.destinationCommitSha, treeSha: id.destinationTreeSha,
    manifestSha256: id.manifestSha256,
  }, state.generation)
  state = await journal.recordRefIntent(destinationRef, state.generation)
  state = await journal.markRefReadbackObserved(destinationRef, state.generation)
  s.input.contract.identity.walGeneration = state.generation
  s.input.contract.walSnapshotSha256 = await sha256Hex(enc(JSON.stringify(state)))
  await armV4ReencryptionSyncFence({
    adapter: s.adapter, runId: id.runId,
    sourceRepoId: id.sourceRepoId, destinationRepoId: id.destinationRepoId,
    assertExclusiveInitiatorLease: async () => {},
  })
  let held = false
  let checkpoints = 0
  const { contract: _discard, ...destinationInput } = s.input
  const input = {
    contract: s.input.contract,
    wal: {
      adapter: walAdapter, root, originalJournalKey: Uint8Array.from(journalKey),
      assertLiveOwner: s.input.assertLiveOwner,
    },
    destination: destinationInput,
    withExclusiveRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
      assert.equal(held, false)
      held = true
      try { return await body() }
      finally { held = false }
    },
    assertExclusiveRecoveryLease: async () => { assert.equal(held, true) },
    assertBestEffortWalCheckpoint: async (): Promise<"best-effort-readback-only"> => {
      assert.equal(held, true)
      checkpoints++
      return "best-effort-readback-only"
    },
  }
  return { ...s, input, walFiles, getWalWrites: () => walWrites,
    getCheckpoints: () => checkpoints, isHeld: () => held }
}

test("D239 binds real encrypted WAL upload receipts to a double full new-key Git/Shadow scan under one fence", async () => {
  const s = await d239Scenario()
  const localFiles = new Map(s.files)
  const walFiles = new Map(s.walFiles)
  const beforeLocalWrites = s.getWrites()
  const beforeWalWrites = s.getWalWrites()
  const result = await inspectV4ColdStartWalDestination(s.input)
  assert.equal(result.observation, "authenticated-wal-and-destination-still-fenced")
  assert.equal(result.walReceiptsBoundToDestination, true)
  assert.equal(result.completeDestinationContentsReverified, true)
  assert.equal(result.verifiedFileCount, 3)
  assert.equal(result.completeOldBackupReverified, false)
  assert.equal(result.powerLossDurabilityProven, false)
  assert.equal(result.commitDecisionAuthorized, false)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.remoteWritesAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.ok(s.getCheckpoints() >= 4)
  assert.equal(s.isHeld(), false)
  assert.equal(s.getWrites(), beforeLocalWrites)
  assert.equal(s.getWalWrites(), beforeWalWrites)
  assert.deepEqual(s.files, localFiles)
  assert.deepEqual(s.walFiles, walFiles)
})

test("D239 fresh Windows disk WAL and Index readers preserve ciphertext across lease release/reopen", async () => {
  const s = await d239Scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const directory = await mkdtemp(path.join(process.cwd(), ".tmp", "d239-joint-"))
  const walDir = path.join(directory, "wal")
  const indexDir = path.join(directory, "index")
  await mkdir(walDir)
  await mkdir(indexDir)
  let first: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let reopened: Awaited<ReturnType<typeof openV4ExistingDesktopWalForRecovery>> | undefined
  try {
    for (const [relativePath, content] of s.files) {
      const file = path.join(indexDir, relativePath)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content, "utf8")
    }
    const indexAdapter: Pick<V4LocalIndexAdapter, "read" | "exists"> = {
      async read(file) { return readFile(path.join(indexDir, file), "utf8") },
      async exists(file) {
        try { await stat(path.join(indexDir, file)); return true }
        catch { return false }
      },
    }
    first = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: walDir, journalRoot: s.input.wal.root,
    })
    for (const [file, content] of s.walFiles) await first.adapter.write(file, content)
    assert.equal(await first.assertBestEffortCheckpoint(), "best-effort-readback-only")
    await first.release()
    first = undefined
    reopened = await openV4ExistingDesktopWalForRecovery({
      rootAbsolute: walDir, journalRoot: s.input.wal.root,
    })
    const storage = reopened
    const observed = await inspectV4ColdStartWalDestination({
      ...s.input,
      wal: {
        ...s.input.wal,
        adapter: { read: file => storage.adapter.read(file), exists: file => storage.adapter.exists(file) },
      },
      destination: { ...s.input.destination, adapter: indexAdapter },
      withExclusiveRecoveryLease: async <T>(body: () => Promise<T>) => {
        await storage.assertExclusiveStageLease()
        return body()
      },
      assertExclusiveRecoveryLease: () => storage.assertExclusiveStageLease(),
      assertBestEffortWalCheckpoint: () => storage.assertBestEffortCheckpoint(),
    })
    assert.equal(observed.observation, "authenticated-wal-and-destination-still-fenced")
    assert.equal(observed.resumeSyncAuthorized, false)
    for (const [file, content] of s.walFiles) {
      assert.equal(await storage.adapter.read(file), content)
    }
    for (const [file, content] of s.files) {
      assert.equal(await readFile(path.join(indexDir, file), "utf8"), content)
    }
  } finally {
    await reopened?.release()
    await first?.release()
    await rm(directory, { recursive: true, force: true })
  }
})

test("D239 refuses receipt SHA/size/extra/duplicate drift before Destination Git scans", async () => {
  for (const cause of ["sha", "size", "extra", "duplicate"] as const) {
    const s = await d239Scenario()
    const original = s.input.destination.remote.expectedReceipts
    const records = original.map(receipt => ({ ...receipt }))
    if (cause === "sha") records[0]!.sha = "9".repeat(40)
    if (cause === "size") records[0]!.byteLength++
    if (cause === "extra" || cause === "duplicate") records.push({ ...records[0]! })
    if (cause === "extra") records[records.length - 1]!.path += ".extra"
    Object.assign(s.input.destination.remote, { expectedReceipts: records })
    const gitReads = s.f.reads
    const report = await inspectV4ColdStartWalDestination(s.input)
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.walReceiptsBoundToDestination, false, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(s.f.reads, gitReads, cause)
    assert.equal(s.isHeld(), false)
  }
})

test("D239 independently authenticated WAL receipts may be in a different order", async () => {
  const s = await d239Scenario()
  const original = s.input.destination.remote.expectedReceipts
  Object.assign(s.input.destination.remote, { expectedReceipts: [...original].reverse() })
  const report = await inspectV4ColdStartWalDestination(s.input)
  assert.equal(report.observation, "authenticated-wal-and-destination-still-fenced")
  assert.equal(report.walReceiptsBoundToDestination, true)
})

test("D239 mutable receipt input during Git scan never authenticates a joined result", async () => {
  const s = await d239Scenario()
  const originalBlob = s.git.getBlob
  let changed = false
  s.git.getBlob = async sha => {
    const bytes = await originalBlob(sha)
    if (!changed) {
      changed = true
      const receipt = s.input.destination.remote.expectedReceipts[0]!
      Object.assign(receipt, { sha: "9".repeat(40) })
    }
    return bytes
  }
  const writes = s.getWrites()
  const report = await inspectV4ColdStartWalDestination(s.input)
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(s.getWrites(), writes)
  assert.equal(s.isHeld(), false)
})

test("D239 refuses WAL slot or Sync Fence changes during current Git content readback", async () => {
  for (const cause of ["wal", "fence", "owner"] as const) {
    const s = await d239Scenario()
    const originalRead = s.git.getBlob
    let changed = false
    s.git.getBlob = async sha => {
      const blob = await originalRead(sha)
      if (!changed) {
        changed = true
        if (cause === "wal") s.walFiles.set("reencryption/d239-wal/slot-1.json", "{torn")
        if (cause === "fence") s.files.set(
          V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{torn",
        )
        if (cause === "owner") s.invalidateOwner()
      }
      return blob
    }
    const report = await inspectV4ColdStartWalDestination(s.input)
    assert.equal(changed, true, cause)
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.localCutoverAuthorized, false)
    assert.equal(s.isHeld(), false)
  }
})

test("D239 rejects Git ref and SecretStorage drift after WAL revalidation", async () => {
  for (const cause of ["ref", "secret"] as const) {
    const s = await d239Scenario()
    const originalCheckpoint = s.input.assertBestEffortWalCheckpoint
    let calls = 0
    s.input.assertBestEffortWalCheckpoint = async () => {
      const result = await originalCheckpoint()
      if (++calls === 4) {
        if (cause === "ref") s.f.changeRef("9".repeat(40))
        else s.secrets.set("new-d238", "changed-at-final-wal-checkpoint")
      }
      return result
    }
    const result = await inspectV4ColdStartWalDestination(s.input)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.walReceiptsBoundToDestination, false, cause)
    assert.equal(result.localCutoverAuthorized, false, cause)
    assert.equal(s.isHeld(), false)
    assert.ok(calls >= 4)
  }
})

test("D239 refuses unavailable best-effort checkpoint, missing fence and reentrant lease", async () => {
  const uncheckpointed = await d239Scenario()
  uncheckpointed.input.assertBestEffortWalCheckpoint = async () => {
    throw Error("Cannot checkpoint WAL")
  }
  assert.equal((await inspectV4ColdStartWalDestination(uncheckpointed.input)).observation,
    "manual-recovery-required")
  const unfenced = await d239Scenario()
  unfenced.files.delete(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json")
  assert.equal((await inspectV4ColdStartWalDestination(unfenced.input)).observation,
    "manual-recovery-required")
  const twice = await d239Scenario()
  const holder = twice.input.withExclusiveRecoveryLease
  twice.input.withExclusiveRecoveryLease = async <T>(body: () => Promise<T>) =>
    holder(async () => { const first = await body(); await body(); return first })
  const report = await inspectV4ColdStartWalDestination(twice.input)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(twice.isHeld(), false)
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

async function d179Scenario(journalKey?: Uint8Array) {
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
    restart, identity: { ...id }, journalKey: journalKey ?? new Uint8Array(32).fill(0x79),
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

test("D220 restored input bootstraps saved nonsecret contract without a caller-supplied D183 witness", async () => {
  const f = await d179Scenario()
  const staged = await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const contractPath = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
  const raw = f.s.files.get(contractPath)!
  const contract = decodeV4ReencryptionPersistedTestContract(raw)
  assert.equal(contract.transactionId, d183TransactionId)
  assert.equal(contract.identity.destinationCommitSha, f.id.destinationCommitSha)
  assert.equal(encodeV4ReencryptionPersistedTestContract(contract), raw)
  assert.doesNotMatch(raw, /old-d138-secret|new-d83-secret/)
  const beforeFiles = new Map(f.s.files)
  const beforeWrites = f.s.getWrites()
  const initialHolders = f.s.holderCounts().calls
  // This input is recreated from the separately retained storage surfaces.
  // The historical D183 contract and in-memory pair are NOT supplied.
  const recreated = {
    ...f.prepared,
    journalKey: Uint8Array.from(f.prepared.journalKey),
    identity: { ...f.id },
    restart: { ...f.prepared.restart, settings: { ...f.prepared.restart.settings } },
  }
  const report = await inspectV4FencedPersistedTestPairAfterRestart(recreated)
  assert.deepEqual(report, {
    integrityScope: "read-only-restarted-untrusted-contract-and-linked-test-pair",
    observation: "manual-recovery-required",
    historicalTestPairCryptographicallyLinked: true,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(f.s.holderCounts().calls, initialHolders + 1, "one nonreentrant external holder")
  assert.equal(f.s.holderCounts().held, false)
  assert.deepEqual(f.s.files, beforeFiles)
  assert.equal(f.s.getWrites(), beforeWrites)
  assert.ok(f.s.files.has(staged.receiptPath))
  assert.ok(f.s.files.has(staged.selectorPath))
})

test("D220 invalid or foreign saved bootstrap manifest cannot authenticate test Selector", async () => {
  const cases = ["missing", "torn", "foreign-identity", "extra-field",
    "canonical-wrong-transaction", "oversized", "wrong-receipt", "missing-selector"] as const
  for (const cause of cases) {
    const f = await d179Scenario()
    await stageV4FencedCommitPairTestArtifacts(d183Input(f))
    const path = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
    const selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
    const receipt = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/marker.json"
    const saved = f.s.files.get(path)!
    if (cause === "missing") f.s.files.delete(path)
    else if (cause === "torn") f.s.files.set(path, "{")
    else if (cause === "foreign-identity") f.s.files.set(path, saved.replace(f.id.runId, "different-run-220"))
    else if (cause === "extra-field") f.s.files.set(path, saved.replace(',"phase":', ',"untrusted":true,"phase":'))
    else if (cause === "canonical-wrong-transaction") {
      const parsed = JSON.parse(saved) as { schemaVersion: 1; phase: string; contract: V4ReencryptionCommitPairTestContract }
      const tampered = { ...parsed.contract, transactionId: "1".repeat(32) }
      f.s.files.set(path, encodeV4ReencryptionPersistedTestContract(tampered))
    } else if (cause === "oversized") f.s.files.set(path, saved + " ".repeat(10_000))
    else if (cause === "wrong-receipt") f.s.files.set(receipt, "AAAA" + f.s.files.get(receipt)!.slice(4))
    else f.s.files.delete(selector)
    const files = new Map(f.s.files)
    const writes = f.s.getWrites()
    const result = await inspectV4FencedPersistedTestPairAfterRestart(f.prepared)
    assert.equal(result.historicalTestPairCryptographicallyLinked, false, cause)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.localCutoverAuthorized, false, cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.deepEqual(f.s.files, files, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D220 mutation after initial contract read, expired fence or altered WAL always requires Manual Recovery", async () => {
  for (const cause of ["manifest-between-reads", "wal", "fence", "secret", "missing-holder"] as const) {
    const f = await d179Scenario()
    await stageV4FencedCommitPairTestArtifacts(d183Input(f))
    const manifest = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
    if (cause === "manifest-between-reads") {
      const original = f.s.adapter.read
      let reads = 0
      f.s.adapter.read = async path => {
        const value = await original(path)
        if (path === manifest && ++reads === 2) {
          f.s.files.set(manifest, value.slice(0, -1))
        }
        return value
      }
    } else if (cause === "wal") f.s.setWal({ ...f.s.getWal(), generation: 777 })
    else if (cause === "fence") f.s.files.set(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{bad")
    else if (cause === "secret") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    else f.prepared.withExclusiveInitiatorLease = async <T>(_body: () => Promise<T>) => ({
      historicalTestPairCryptographicallyLinked: true,
      observation: "manual-recovery-required",
    } as T)
    const writes = f.s.getWrites()
    const result = await inspectV4FencedPersistedTestPairAfterRestart(f.prepared)
    assert.equal(result.historicalTestPairCryptographicallyLinked, false, cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(result.oldPassphraseCleanupAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D220 interrupt after persisting contract leaves bootstrap-only residue and never Receipt/Selector", async () => {
  const f = await d179Scenario()
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  const contractPath = root + "/contract.json"
  const receiptPath = root + "/marker.json"
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  const original = f.s.adapter.write
  f.s.adapter.write = async (path, value) => {
    await original(path, value)
    if (path === contractPath) throw Error("simulated-crash-after-contract")
  }
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /simulated-crash-after-contract/)
  assert.equal(f.s.files.has(contractPath), true)
  assert.equal(f.s.files.has(receiptPath), false)
  assert.equal(f.s.files.has(selectorPath), false)
  const report = await inspectV4FencedPersistedTestPairAfterRestart(f.prepared)
  assert.equal(report.historicalTestPairCryptographicallyLinked, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(f.s.holderCounts().held, false)
  f.s.adapter.write = original
  const writes = f.s.getWrites()
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /stale|partial|Manual Recovery/i)
  assert.equal(f.s.getWrites(), writes)
})

test("D219 one lease writes and re-reads a linked D182 Receipt then Selector without switching Source", async () => {
  const f = await d179Scenario()
  const beforeFiles = new Map(f.s.files)
  const beforeSource = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
  const beforeShadow = await loadV4LocalIndex(
    f.s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId,
  )
  const beforeSettings = JSON.stringify(f.prepared.restart.settings)
  const beforeSecrets = new Map(f.s.secrets)
  const beforeWal = JSON.stringify(f.s.getWal())
  const initialCalls = f.s.holderCounts().calls
  const report = await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const receiptRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  assert.deepEqual(report, {
    status: "linked-persistent-test-artifacts-uncommitted",
    receiptPath: receiptRoot + "/marker.json",
    selectorPath,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(f.s.holderCounts().calls, initialCalls + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.files.has(report.receiptPath))
  assert.ok(f.s.files.has(receiptRoot + "/contract.json"), "restart-readable nonsecret contract must be persisted")
  assert.doesNotMatch(f.s.files.get(receiptRoot + "/contract.json")!, /old-d138-secret|new-d83-secret/)
  assert.ok(f.s.files.has(report.selectorPath))
  assert.deepEqual(await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT), beforeSource)
  assert.deepEqual(await loadV4LocalIndex(
    f.s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId,
  ), beforeShadow)
  assert.equal(JSON.stringify(f.prepared.restart.settings), beforeSettings)
  assert.deepEqual(f.s.secrets, beforeSecrets)
  assert.equal(JSON.stringify(f.s.getWal()), beforeWal)
  for (const [path, bytes] of beforeFiles) assert.equal(f.s.files.get(path), bytes)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
  const { contract } = await d183PreparedPairFromBeforeStageForD219(f, beforeFiles)
  const inspected = await inspectV4FencedCrashWindowPairAfterRestart({
    prepared: f.prepared, contract,
    sourceSettings: { ...f.prepared.restart.settings },
  })
  assert.equal(inspected.artifactWindow, "pair-present")
  assert.equal(inspected.pairEvidence, "cryptographically-linked-uncommitted")
  assert.equal(inspected.reason, "linked-test-pair-not-authoritative")
  assert.equal(inspected.localCutoverAuthorized, false)
  assert.equal(inspected.resumeSyncAuthorized, false)
  const writes = f.s.getWrites()
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /stale|partial|existing|Manual Recovery/i)
  assert.equal(f.s.getWrites(), writes, "never silently overwrite completed test pair")
})

async function d183PreparedPairFromBeforeStageForD219(
  f: Awaited<ReturnType<typeof d179Scenario>>, beforeFiles: Map<string, string>,
) {
  // Recover the exact D183 contract from the original local readback without
  // mutating the now-staged local state or treating that witness as an authority.
  const source = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
  const shadow = await loadV4LocalIndex(
    f.s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId,
  )
  const walBytes = JSON.stringify(f.s.getWal())
  const settingsBytes = JSON.stringify(f.prepared.restart.settings)
  const targetBytes = JSON.stringify({
    ...f.prepared.restart.settings,
    githubBranch: f.id.destinationRepoId.split("#")[1],
    encryptionPassphraseSecretId: f.id.destinationPassphraseSecretId,
  })
  const digest = (value: string) => sha256Hex(enc(value))
  const contract: V4ReencryptionCommitPairTestContract = {
    transactionId: d183TransactionId, identity: f.id,
    sourceIndexSha256: await digest(JSON.stringify(source)),
    destinationShadowSha256: await digest(JSON.stringify(shadow)),
    preparedEvidenceSha256: await digest(beforeFiles.get(f.staged.evidencePath)!),
    walSnapshotSha256: await digest(walBytes),
    sourceSettingsSha256: await digest(settingsBytes),
    destinationSettingsSha256: await digest(targetBytes),
  }
  return { contract }
}

test("D219 interrupted mkdir/Receipt/Selector writes persist distinct Manual Recovery windows", async () => {
  for (const phase of ["directory", "receipt", "selector"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const initialSettings = JSON.stringify(f.prepared.restart.settings)
    const initialSecrets = new Map(f.s.secrets)
    const selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
    const receiptRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
    const receipt = receiptRoot + "/marker.json"
    const expected = phase === "directory" ? "receipt-directory-only"
      : phase === "receipt" ? "receipt-only" : "pair-present"
    const oldWrite = f.s.adapter.write
    const oldMkdir = f.s.adapter.mkdir
    if (phase === "directory") {
      f.s.adapter.mkdir = async path => {
        await oldMkdir(path)
        if (path === receiptRoot) throw Error("simulated-interruption-" + phase)
      }
    } else {
      f.s.adapter.write = async (path, content) => {
        await oldWrite(path, content)
        if (path === (phase === "receipt" ? receipt : selector)) {
          throw Error("simulated-interruption-" + phase)
        }
      }
    }
    await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
      /simulated-interruption/)
    assert.equal(f.s.holderCounts().held, false, phase)
    assert.equal(f.s.dirs.has(receiptRoot), true, phase)
    assert.equal(f.s.files.has(receiptRoot + "/contract.json"), phase !== "directory", phase)
    assert.equal(f.s.files.has(receipt), phase !== "directory", phase)
    assert.equal(f.s.files.has(selector), phase === "selector", phase)
    assert.equal(JSON.stringify(f.prepared.restart.settings), initialSettings)
    assert.deepEqual(f.s.secrets, initialSecrets)
    const crash = await inspectV4FencedCrashWindowPairAfterRestart({
      prepared: f.prepared, contract, sourceSettings: { ...f.prepared.restart.settings },
    })
    assert.equal(crash.artifactWindow, expected, phase)
    assert.equal(crash.observation, "manual-recovery-required", phase)
    assert.equal(crash.localCutoverAuthorized, false, phase)
    assert.equal(crash.resumeSyncAuthorized, false, phase)
    if (phase === "selector") {
      assert.equal(crash.pairEvidence, "cryptographically-linked-uncommitted")
      assert.equal(crash.reason, "linked-test-pair-not-authoritative")
    }
    f.s.adapter.write = oldWrite
    f.s.adapter.mkdir = oldMkdir
    const writes = f.s.getWrites()
    await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
      /stale|partial|existing|Manual Recovery/i, phase)
    assert.equal(f.s.getWrites(), writes, "no overwrite on retry " + phase)
  }
})

test("D219 lost WAL after the Receipt write cannot persist Selector or resume Sync", async () => {
  const f = await d179Scenario()
  const oldWrite = f.s.adapter.write
  const receiptRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  f.s.adapter.write = async (path, value) => {
    await oldWrite(path, value)
    if (path === receiptRoot + "/marker.json") {
      f.s.setWal({ ...f.s.getWal(), generation: 99 })
    }
  }
  const selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /WAL|run|Manual Recovery/)
  assert.equal(f.s.files.has(receiptRoot + "/marker.json"), true)
  assert.equal(f.s.files.has(selector), false)
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
})

test("D219 a corrupt persisted Receipt cannot be upgraded to a linked Selector", async () => {
  const f = await d179Scenario()
  const receiptRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  const receiptPath = receiptRoot + "/marker.json"
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  const oldWrite = f.s.adapter.write
  f.s.adapter.write = async (path, value) => {
    await oldWrite(path, path === receiptPath ? value.slice(0, -4) + "AAAA" : value)
  }
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /Receipt|readback|mismatch|Manual Recovery/)
  assert.equal(f.s.files.has(receiptPath), true)
  assert.equal(f.s.files.has(selectorPath), false)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"), true)
})

test("D219 preexisting receipt residue is never overwritten, even before sealing", async () => {
  const f = await d179Scenario()
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  await f.s.adapter.mkdir(root)
  await f.s.adapter.write(root + "/marker.json", "foreign-evidence")
  const writes = f.s.getWrites()
  const files = new Map(f.s.files)
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /stale|foreign|partial|Manual Recovery/i)
  assert.equal(f.s.getWrites(), writes)
  assert.deepEqual(f.s.files, files)
  assert.equal(f.s.holderCounts().held, false)
})

test("D219 cancellation after Receipt readback preserves evidence and never writes Selector", async () => {
  const f = await d179Scenario()
  const controller = new AbortController()
  Object.assign(f.input.full.shadow.remote, { signal: controller.signal })
  const receiptPath = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/marker.json"
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  const oldWrite = f.s.adapter.write
  f.s.adapter.write = async (path, value) => {
    await oldWrite(path, value)
    if (path === receiptPath) controller.abort(new Error("test abort after Receipt"))
  }
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /cancel|abort|Manual Recovery/i)
  assert.equal(f.s.files.has(receiptPath), true)
  assert.equal(f.s.files.has(selectorPath), false)
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
})

test("D219 post-holder Git reader mutation refuses an apparently successful staged proof", async () => {
  const f = await d179Scenario()
  const originalHolder = f.prepared.withExclusiveInitiatorLease
  const gh = f.s.f.github
  const outer = async <T>(body: () => Promise<T>): Promise<T> =>
    originalHolder(async () => {
      const completed = await body()
      gh.getGitRef = async () => ({
        ref: "refs/heads/rekey/d83", sha: "9".repeat(40), type: "commit",
      })
      return completed
    })
  f.prepared.withExclusiveInitiatorLease = outer
  f.input.full.branches.withExclusiveInitiatorLease = outer
  const receiptPath = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/marker.json"
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  await assert.rejects(() => stageV4FencedCommitPairTestArtifacts(d183Input(f)),
    /holder|trusted|changed/)
  assert.equal(f.s.files.has(receiptPath), true)
  assert.equal(f.s.files.has(selectorPath), true)
  assert.equal(f.s.holderCounts().held, false)
})

const d185Input = (
  f: Awaited<ReturnType<typeof d179Scenario>>,
  contract: V4ReencryptionCommitPairTestContract,
) => ({
  local: {
    prepared: f.prepared, contract,
    sourceSettings: { ...f.prepared.restart.settings },
  },
  remote: f.input.full,
})
async function d185PlacePairedEvidence(
  f: Awaited<ReturnType<typeof d179Scenario>>,
  pair: Awaited<ReturnType<typeof sealV4ReencryptionCommitPairTestVectors>>,
) {
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
  await f.s.adapter.mkdir(root)
  await f.s.adapter.write(root + "/marker.json", pair.receiptTestVector)
  await f.s.adapter.write(
    V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json",
    pair.selectorTestVector,
  )
}

async function d217CurrentFrozenBackup(f: Awaited<ReturnType<typeof d179Scenario>>) {
  const oldPassphrase = f.s.secrets.get(f.id.sourcePassphraseSecretId)
  assert.ok(oldPassphrase)
  const oldConfig = config(original, "d217-original-salt")
  const keyring = await deriveV4Keyring({
    repoId: original, passphrase: oldPassphrase, salt: enc("d217-original-salt"),
    iterations: oldConfig.kdfParams!.iterations,
  })
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring })
  const originalFile = await codec.prepare("Original/秘密 backup.md", enc("recovery original"), "v1", 8, "d217-original-file")
  const record = { ...originalFile.record, path: "Original/秘密 backup.md" }
  const bucket = record.pathId.slice(0, 2)
  const oldHead: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "d217", deviceId: f.id.deviceId, updatedAt: 8,
    shardHashes: { [bucket]: await sha256Hex(enc(JSON.stringify([record]))) },
  }
  const files = [...await buildV4RemoteMetadata({
    config: oldConfig, head: oldHead, records: [record], keyring,
  }), ...originalFile.files]

  // Synthesize immutable Git trees, but run the REAL D94 AES-GCM decoder,
  // Git blob identity checks and complete plaintext SHA verifier.
  const blobs = new Map(files.map(file => [computeV4GitBlobSha1(file.bytes), file.bytes.slice()]))
  type GitEntry = { path: string; mode: "100644" | "040000"; type: "blob" | "tree"; sha: string; url: string }
  const trees = new Map<string, GitEntry[]>()
  const dirs = new Map<string, string>([["", sourceTree]])
  let nextTree = 1000
  for (const file of files) {
    const parts = file.path.split("/")
    let dir = ""
    for (const part of parts.slice(0, -1)) {
      const path = dir ? dir + "/" + part : part
      if (!dirs.has(path)) {
        const sha = (++nextTree).toString(16).padStart(40, "0")
        const parentSha = dirs.get(dir)!
        trees.set(parentSha, [...trees.get(parentSha) ?? [],
          { path: part, sha, type: "tree", mode: "040000", url: "" }])
        dirs.set(path, sha)
      }
      dir = path
    }
    const parentSha = dirs.get(dir)!
    trees.set(parentSha, [...trees.get(parentSha) ?? [],
      { path: parts[parts.length - 1]!, type: "blob", mode: "100644",
        sha: computeV4GitBlobSha1(file.bytes), url: "" }])
  }
  let blobReads = 0
  let refReads = 0
  let observedBackupSha = pinned
  let corruptAfterFirstPass = false
  let breakRefAfterFirstPass = false
  const github = {
    branchName: f.id.backupRepoId.split("#")[1]!,
    async getRepositoryIdentity() { return { id: 88, fullName: "owner/repo" } },
    async getRepositoryDefaultBranch() { return "main" },
    async getGitRef() {
      refReads++
      return {
        ref: "refs/heads/" + f.id.backupRepoId.split("#")[1]!,
        type: "commit" as const,
        sha: breakRefAfterFirstPass && refReads > 2 ? "9".repeat(40) : observedBackupSha,
      }
    },
    async getGitCommit(sha: string) {
      if (sha !== pinned) throw Error("changed immutable Backup commit")
      return { sha, treeSha: sourceTree, parentShas: ["1".repeat(40)], message: "frozen backup" }
    },
    async getTreeAt(sha: string, recursive?: boolean) {
      assert.equal(recursive, false)
      const tree = trees.get(sha)
      if (!tree) throw Error("missing original source tree")
      return { sha, url: "", truncated: false, tree }
    },
    async getBlob(sha: string) {
      blobReads++
      const original = blobs.get(sha)
      if (!original) throw Error("missing original object")
      const copy = original.slice()
      if (corruptAfterFirstPass && blobReads > blobs.size) copy[0] ^= 1
      return copy
    },
  }
  const proposal = proposeV4SameRepositoryReencryptionBackupBranch({
    sourceRepoId: f.id.sourceRepoId, backupRepoId: f.id.backupRepoId,
    destinationRepoId: f.id.destinationRepoId, pinnedSourceCommitSha: f.id.sourceCommitSha,
    sourcePhysicalRepositoryId: 88, backupPhysicalRepositoryId: 88,
    destinationPhysicalRepositoryId: 88, expectedPhysicalRepositoryId: 88,
    defaultBranch: "main",
  })
  const backup: V4FencedFrozenBackupContentInput = {
    identity: f.id, adapter: f.s.adapter,
    wal: f.input.full.branches.wal, journal: f.input.full.branches.journal,
    assertExclusiveInitiatorLease: f.prepared.restart.assertExclusiveInitiatorLease,
    withExclusiveInitiatorLease: f.prepared.withExclusiveInitiatorLease,
    backup: { github, plan: proposal, passphrase: oldPassphrase,
      expectedSourceTreeSha: f.id.sourceTreeSha },
  }
  return {
    backup, github,
    get blobReads() { return blobReads }, get refReads() { return refReads },
    corruptAfterFirstPass() { corruptAfterFirstPass = true },
    moveRefAfterFirstPass() { breakRefAfterFirstPass = true },
    setRef(sha: string) { observedBackupSha = sha },
  }
}

async function d235Scenario() {
  const ring = await deriveV4Keyring({
    repoId: original, passphrase: "old-d138-secret",
    salt: enc("d217-original-salt"), iterations: 600_000,
  })
  const oldJournalKey = Uint8Array.from(ring.journalKey)
  for (const part of [ring.masterKey, ring.pathKey, ring.contentKey,
    ring.indexKey, ring.journalKey]) part.fill(0)
  const s = await d233Scenario(oldJournalKey)
  await persistV4FencedDestinationSettings(s.cutover)
  let live = true
  const input = {
    adapter: s.f.s.adapter,
    readPersistedPluginData: async () => JSON.parse(s.saved) as unknown,
    getSecret: (id: string) => s.f.s.secrets.get(id) ?? null,
    backupGit: s.b.github,
    assertLiveOwner: () => { if (!live) throw Error("Obsidian session no longer owns vault.") },
  }
  return { ...s, input, oldJournalKey,
    invalidateOwner() { live = false } }
}

test("D235 rederives the original journal key from immutable encrypted Backup config and HEAD after native Settings restart", async () => {
  const s = await d235Scenario()
  const oldFiles = new Map(s.f.s.files)
  const oldSecrets = new Map(s.f.s.secrets)
  const writes = s.f.s.getWrites()
  const proven = await inspectV4ReencryptionColdStartJournalKey(s.input)
  assert.equal(proven.observation, "authenticated-local-route-still-fenced")
  assert.equal(proven.originalKeyAuthenticated, true)
  assert.equal(proven.pinnedBackupConfigAndEncryptedHeadVerified, true)
  assert.equal(proven.completeBackupContentsReverified, true)
  assert.equal(proven.completeDestinationContentsReverified, false)
  assert.equal(proven.coldStartWalReverified, false)
  assert.equal(proven.resumeSyncAuthorized, false)
  assert.equal(proven.commitDecisionAuthorized, false)
  assert.equal(proven.oldPassphraseCleanupAuthorized, false)
  assert.equal(proven.diagnosticIndexRoot, V4_RUNTIME_INDEX_ROOT + "-rekey-" + s.f.id.runId)
  assert.equal(s.f.s.getWrites(), writes, "cold-start key recovery never writes")
  assert.deepEqual(s.f.s.files, oldFiles)
  assert.deepEqual(s.f.s.secrets, oldSecrets)
  await assert.rejects(assertV4ReencryptionSyncFenceClear(s.f.s.adapter))
})

test("D249 installed read-only recovery refuses mutable Settings branch drift during Git inspection", async () => {
  const s = await d235Scenario()
  const persisted = JSON.parse(s.saved) as { settings: Record<string, unknown> }
  const settings = {
    ...persisted.settings, githubToken: "offline-d249-test-token",
  } as { githubBranch: string; githubOwner: string; githubRepo: string; githubToken: string }
  const prefix = ".obsidian/plugins/test-d249/"
  const disk = s.f.s.adapter
  const nativeAdapter = {
    read: (name: string) => disk.read(name.replace(prefix, "")),
    write: (name: string, value: string) => disk.write(name.replace(prefix, ""), value),
    exists: (name: string) => disk.exists(name.replace(prefix, "")),
    mkdir: (name: string) => disk.mkdir(name.replace(prefix, "")),
  }
  const plugin = {
    settings, manifest: { id: "test-d249" },
    isSyncInProgress: false,
    app: {
      vault: { configDir: ".obsidian", adapter: nativeAdapter },
      secretStorage: { getSecret: (id: string) => s.f.s.secrets.get(id) ?? null },
    },
    loadData: async () => JSON.parse(s.saved) as unknown,
  }
  const methods = [
    "getRepositoryIdentity", "getRepositoryDefaultBranch", "getGitRef",
    "getGitCommit", "getTreeAt", "getBlob",
  ] as const
  type Stub = (...args: never[]) => Promise<unknown>
  const prototype = GitHubClient.prototype as unknown as Record<string, Stub>
  const backupGit = s.b.github as unknown as Record<string, Stub>
  const originals = methods.map(name => prototype[name]!)
  const before = new Map(s.f.s.files)
  const savedBranch = settings.githubBranch
  let drift = true
  const runtime = new V4PluginRuntime(plugin as never)
  try {
    for (const name of methods) {
      prototype[name] = (...args: never[]) => {
        if (name === "getRepositoryIdentity" && drift) {
          settings.githubBranch = "unexpected-in-place-change"
        }
        return backupGit[name]!(...args)
      }
    }
    const result = await runtime.verifyFencedReencryptionOriginalKey()
    assert.equal(result?.observation, "manual-recovery-required")
    assert.equal(result?.originalKeyAuthenticated, false)
    settings.githubBranch = savedBranch
    drift = false
    const stable = await runtime.verifyFencedReencryptionOriginalKey()
    assert.equal(stable?.observation, "authenticated-local-route-still-fenced")
    assert.equal(stable?.completeBackupContentsReverified, true)
    assert.equal(stable?.resumeSyncAuthorized, false)
    assert.deepEqual(s.f.s.files, before, "no local WAL or Index is altered")
  } finally {
    methods.forEach((name, index) => { prototype[name] = originals[index]! })
    runtime.dispose()
  }
})

async function d247WalSlot(
  state: V4ReencryptionJournalSnapshot,
  contract: V4ReencryptionCutoverSnapshotContract,
  journalKey: Uint8Array,
): Promise<string> {
  const identity = contract.identity
  const plaintext = enc(JSON.stringify({
    status: "staging-only",
    receipts: state.receipts,
    pendingIntents: state.pendingIntents,
    refIntents: state.pendingRefIntents,
    refReceipts: state.verifiedRefObservations,
    stageHandoffStarted: state.stageHandoffStarted,
    candidatePreparationSha256: state.candidatePreparationSha256,
    preparedCandidateReceipt: state.preparedCandidateReceipt,
  }))
  const ciphertext = toBase64(await encryptV4Payload(journalKey, plaintext, {
    kind: "journal",
    aad: `v4-rekey-wal:${identity.destinationRepoId}:${identity.sourceCommitSha}:${identity.runId}:${state.generation}`,
  }))
  plaintext.fill(0)
  const slot = {
    schemaVersion: 1, generation: state.generation,
    runId: identity.runId, sourceCommitSha: identity.sourceCommitSha,
    destinationRepoId: identity.destinationRepoId, ciphertext,
  }
  return JSON.stringify({ ...slot, digest: await sha256Hex(enc(JSON.stringify(slot))) })
}

async function d247Scenario() {
  const old = await d235Scenario()
  const destinationSource = await d238Scenario()
  const id = old.f.id
  const originalContractText = await old.input.adapter.read(
    V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + id.runId + "/contract.json",
  )
  const contract = decodeV4ReencryptionCutoverCandidateManifest(originalContractText)
  const latest = old.f.s.getWal()
  const destRef = latest.verifiedRefObservations.find(ref => ref.role === "destination")!
  assert.ok(destRef)
  assert.equal(latest.generation, contract.identity.walGeneration)
  const predecessor: V4ReencryptionJournalSnapshot = {
    ...latest,
    generation: latest.generation - 1,
    pendingRefIntents: [destRef],
    verifiedRefObservations: latest.verifiedRefObservations.filter(ref => ref.role !== "destination"),
  }
  const root = "reencryption/d247-recovered"
  const walFiles = new Map<string, string>([
    [root + "/slot-" + (predecessor.generation % 2) + ".json",
      await d247WalSlot(predecessor, contract, old.oldJournalKey)],
    [root + "/slot-" + (latest.generation % 2) + ".json",
      await d247WalSlot(latest, contract, old.oldJournalKey)],
  ])
  const walAdapter: Pick<V4LocalIndexAdapter, "read" | "exists"> = {
    async read(file) {
      const text = walFiles.get(file)
      if (!text) throw Error("missing encrypted WAL slot")
      return text
    },
    async exists(file) { return walFiles.has(file) },
  }
  const source = old.input
  const destination = {
    ...destinationSource.input, adapter: source.adapter,
    getSecret: source.getSecret, assertLiveOwner: source.assertLiveOwner,
  }
  const current = {
    contract,
    wal: {
      adapter: walAdapter, root, originalJournalKey: Uint8Array.from(old.oldJournalKey),
      assertLiveOwner: source.assertLiveOwner,
    },
    destination: {
      adapter: source.adapter,
      destinationGit: destination.destinationGit,
      remote: destination.remote,
      expectedPhysicalRepositoryId: destination.expectedPhysicalRepositoryId,
      getSecret: source.getSecret,
      assertLiveOwner: source.assertLiveOwner,
    },
  }
  let held = false
  let leaseLive = true
  let holderCalls = 0
  const input = {
    backup: source, current,
    withExclusiveRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
      assert.equal(held, false, "recovery lease must not be reentered")
      held = true
      holderCalls++
      try { return await body() }
      finally { held = false }
    },
    assertExclusiveRecoveryLease: async () => {
      assert.equal(held, true)
      if (!leaseLive) throw Error("D247 exclusive recovery lease revoked")
    },
    assertBestEffortWalCheckpoint: async (): Promise<"best-effort-readback-only"> => {
      assert.equal(held, true)
      return "best-effort-readback-only"
    },
  }
  return { old, destinationSource, walFiles, contract, input,
    isHeld: () => held, getHolderCalls: () => holderCalls,
    revokeLease() { leaseLive = false },
  }
}

test("D253 binds old-key authenticated WAL receipt bytes to pinned Destination commit without granting recovery", async () => {
  const s = await d247Scenario()
  const git = s.input.current.destination.destinationGit
  const walEvidence = {
    root: s.input.current.wal.root,
    adapter: s.input.current.wal.adapter,
    destinationGit: git,
  }
  assert.ok(s.input.current.destination.remote.expectedReceipts.length > 0)
  const beforeWal = new Map(s.walFiles)
  const beforeFiles = new Map(s.old.f.s.files)
  const beforeSecrets = new Map(s.old.f.s.secrets)
  const beforeWrites = s.old.f.s.getWrites()
  const good = await inspectV4ReencryptionColdStartJournalKey({ ...s.old.input, walEvidence })
  assert.equal(good.observation, "authenticated-local-route-still-fenced")
  assert.equal(good.coldStartWalReverified, true)
  assert.equal(good.destinationCiphertextReceiptsReverified, true)
  assert.equal(good.completeDestinationContentsReverified, false)
  assert.equal(good.resumeSyncAuthorized, false)
  assert.equal(good.localCutoverAuthorized, false)
  assert.equal(good.remoteWritesAuthorized, false)
  assert.deepEqual(s.walFiles, beforeWal)
  assert.deepEqual(s.old.f.s.files, beforeFiles)
  assert.deepEqual(s.old.f.s.secrets, beforeSecrets)
  assert.equal(s.old.f.s.getWrites(), beforeWrites)
  const getBlob = git.getBlob
  git.getBlob = async (sha: string) => {
    const bytes = await getBlob(sha)
    const altered = Uint8Array.from(bytes)
    if (altered.length) altered[0] ^= 0xff
    return altered
  }
  try {
    const corrupt = await inspectV4ReencryptionColdStartJournalKey({ ...s.old.input, walEvidence })
    assert.equal(corrupt.observation, "manual-recovery-required")
    assert.equal(corrupt.destinationCiphertextReceiptsReverified, false)
    assert.equal(corrupt.resumeSyncAuthorized, false)
    assert.deepEqual(s.walFiles, beforeWal)
    assert.deepEqual(s.old.f.s.files, beforeFiles)
  } finally {
    git.getBlob = getBlob
  }
})

test("D253 refuses WAL mutation during Destination ciphertext scan and changed ref on second observation", async () => {
  const s = await d247Scenario()
  const git = s.input.current.destination.destinationGit
  const root = s.input.current.wal.root
  const walEvidence = { root, adapter: s.input.current.wal.adapter, destinationGit: git }
  const originalBlob = git.getBlob
  const originalRef = git.getGitRef
  const slot = root + "/slot-" + (s.contract.identity.walGeneration % 2) + ".json"
  const slotText = s.walFiles.get(slot)!
  let changed = false
  const beforeFiles = new Map(s.old.f.s.files)
  try {
    git.getBlob = async sha => {
      const bytes = await originalBlob(sha)
      if (!changed) {
        changed = true
        s.walFiles.set(slot, "{interrupted-during-git-read")
      }
      return bytes
    }
    const raced = await inspectV4ReencryptionColdStartJournalKey({ ...s.old.input, walEvidence })
    assert.equal(changed, true)
    assert.equal(raced.observation, "manual-recovery-required")
    assert.equal(raced.destinationCiphertextReceiptsReverified, false)
    assert.equal(raced.localCutoverAuthorized, false)
    assert.equal(s.walFiles.get(slot), "{interrupted-during-git-read")
    s.walFiles.set(slot, slotText)
    git.getBlob = originalBlob
    let refReads = 0
    git.getGitRef = async () => {
      const ref = await originalRef()
      refReads++
      return refReads > 1 ? { ...ref, sha: "9".repeat(40) } : ref
    }
    const moved = await inspectV4ReencryptionColdStartJournalKey({ ...s.old.input, walEvidence })
    assert.ok(refReads >= 2)
    assert.equal(moved.observation, "manual-recovery-required")
    assert.equal(moved.destinationCiphertextReceiptsReverified, false)
    assert.equal(moved.resumeSyncAuthorized, false)
    assert.deepEqual(s.old.f.s.files, beforeFiles)
  } finally {
    git.getBlob = originalBlob
    git.getGitRef = originalRef
    s.walFiles.set(slot, slotText)
  }
})

test("D252 original-key full Backup proof authenticates saved encrypted WAL, refuses torn slot without any writes", async () => {
  const s = await d247Scenario()
  const walEvidence = { root: s.input.current.wal.root, adapter: s.input.current.wal.adapter }
  const before = new Map(s.walFiles)
  const filesBefore = new Map(s.old.f.s.files)
  const secretsBefore = new Map(s.old.f.s.secrets)
  const writesBefore = s.old.f.s.getWrites()
  const positive = await inspectV4ReencryptionColdStartJournalKey({
    ...s.old.input, walEvidence,
  })
  assert.equal(positive.observation, "authenticated-local-route-still-fenced")
  assert.equal(positive.completeBackupContentsReverified, true)
  assert.equal(positive.coldStartWalReverified, true)
  assert.equal(positive.completeDestinationContentsReverified, false)
  assert.equal(positive.resumeSyncAuthorized, false)
  assert.equal(positive.localCutoverAuthorized, false)
  assert.deepEqual(s.walFiles, before)
  const slot = walEvidence.root + "/slot-" + (s.contract.identity.walGeneration % 2) + ".json"
  s.walFiles.set(slot, s.walFiles.get(slot)!.slice(0, 38))
  const torn = new Map(s.walFiles)
  const refused = await inspectV4ReencryptionColdStartJournalKey({
    ...s.old.input, walEvidence,
  })
  assert.equal(refused.observation, "manual-recovery-required")
  assert.equal(refused.coldStartWalReverified, false)
  assert.equal(refused.resumeSyncAuthorized, false)
  assert.deepEqual(s.walFiles, torn)
  assert.deepEqual(s.old.f.s.files, filesBefore)
  assert.deepEqual(s.old.f.s.secrets, secretsBefore)
  assert.equal(s.old.f.s.getWrites(), writesBefore)
})

test("D251 installed read-only Git ref inspection pins live Settings across awaited GitHub reads", async () => {
  const s = await d247Scenario()
  const savedSettings = (JSON.parse(s.old.saved) as { settings: Record<string, unknown> }).settings
  const settings = { ...savedSettings, githubToken: "offline-d251-token" } as {
    githubBranch: string; githubToken: string
  }
  const disk = s.old.f.s.adapter
  const prefix = ".obsidian/plugins/test-d251/"
  const nativeAdapter = {
    read: (name: string) => disk.read(name.replace(prefix, "")),
    write: (name: string, value: string) => disk.write(name.replace(prefix, ""), value),
    exists: (name: string) => disk.exists(name.replace(prefix, "")),
    mkdir: (name: string) => disk.mkdir(name.replace(prefix, "")),
  }
  const plugin = {
    settings, manifest: { id: "test-d251" },
    isSyncInProgress: false,
    app: {
      vault: { configDir: ".obsidian", adapter: nativeAdapter },
      secretStorage: { getSecret: (id: string) => s.old.f.s.secrets.get(id) ?? null },
    },
    loadData: async () => JSON.parse(s.old.saved) as unknown,
  }
  const id = s.contract.identity
  const backupBranch = id.backupRepoId.split("#")[1]
  const backupGit = s.input.backup.backupGit
  const destinationGit = s.input.current.destination.destinationGit
  const methods = ["getRepositoryIdentity", "getRepositoryDefaultBranch",
    "getGitRef", "getGitCommit"] as const
  type Stub = (this: GitHubClient, ...args: never[]) => Promise<unknown>
  const prototype = GitHubClient.prototype as unknown as Record<string, Stub>
  const originals = methods.map(name => prototype[name]!)
  const sourceBranch = settings.githubBranch
  let drift = false
  const before = new Map(s.old.f.s.files)
  const runtime = new V4PluginRuntime(plugin as never)
  try {
    for (const name of methods) {
      prototype[name] = function (this: GitHubClient, ...args: never[]) {
        if (name === "getRepositoryIdentity" && drift) {
          settings.githubBranch = "mutated-during-github-read"
        }
        const git = this.branchName === backupBranch ? backupGit : destinationGit
        return (git[name] as Stub).call(git as never, ...args)
      }
    }
    const good = await runtime.inspectFencedReencryptionCandidateGitRefs()
    assert.equal(good?.observation, "candidate-remote-refs-observed-untrusted")
    assert.equal(good?.destinationOrphanTopologyObserved, true)
    assert.equal(good?.fullDestinationContentsReverified, false)
    assert.equal(good?.resumeSyncAuthorized, false)
    drift = true
    const changed = await runtime.inspectFencedReencryptionCandidateGitRefs()
    assert.equal(changed, null, "Settings changes while Git is pending must fail closed")
    settings.githubBranch = sourceBranch
    assert.deepEqual(s.old.f.s.files, before, "Git ref readback must not alter local Index")
  } finally {
    methods.forEach((name, i) => { prototype[name] = originals[i]! })
    runtime.dispose()
  }
})

test("D247 joins real old frozen Backup key, encrypted WAL and full Destination under one recovery lease", async () => {
  const s = await d247Scenario()
  const beforeLocal = new Map(s.old.f.s.files)
  const beforeWal = new Map(s.walFiles)
  const beforeSecrets = new Map(s.old.f.s.secrets)
  const writesBefore = s.old.f.s.getWrites()
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(report.observation, "authenticated-complete-recovery-evidence-still-fenced")
  assert.equal(report.originalKeyAuthenticated, true)
  assert.equal(report.completeOldBackupReverified, true)
  assert.equal(report.walReceiptsBoundToDestination, true)
  assert.equal(report.completeDestinationContentsReverified, true)
  assert.equal(report.verifiedFileCount, 3)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.commitDecisionAuthorized, false)
  assert.equal(report.remoteWritesAuthorized, false)
  assert.equal(report.powerLossDurabilityProven, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.equal(s.getHolderCalls(), 1, "one outer lease across Backup, WAL and Destination")
  assert.equal(s.isHeld(), false)
  assert.equal(s.old.f.s.getWrites(), writesBefore)
  assert.deepEqual(s.old.f.s.files, beforeLocal)
  assert.deepEqual(s.walFiles, beforeWal)
  assert.deepEqual(s.old.f.s.secrets, beforeSecrets)
})

test("D247 uses a freshly reopened, OS-locked Windows WAL and physical read-only Index under one lease", async () => {
  const s = await d247Scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const temporary = await mkdtemp(path.join(process.cwd(), ".tmp", "d247-physical-"))
  const walRoot = path.join(temporary, "wal")
  const indexRoot = path.join(temporary, "index")
  await mkdir(walRoot)
  await mkdir(indexRoot)
  let writer: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let reader: Awaited<ReturnType<typeof openV4ExistingDesktopWalForRecovery>> | undefined
  try {
    for (const [name, value] of s.old.f.s.files) {
      const absolute = path.join(indexRoot, name)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, value)
    }
    const index: Pick<V4LocalIndexAdapter, "read" | "exists"> = {
      read(name) { return readFile(path.join(indexRoot, name), "utf8") },
      async exists(name) {
        try { await stat(path.join(indexRoot, name)); return true }
        catch { return false }
      },
    }
    writer = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: walRoot, journalRoot: s.input.current.wal.root,
    })
    for (const [name, ciphertext] of s.walFiles) {
      await writer.adapter.write(name, ciphertext)
    }
    assert.equal(await writer.assertBestEffortCheckpoint(), "best-effort-readback-only")
    await writer.release()
    writer = undefined
    reader = await openV4ExistingDesktopWalForRecovery({
      rootAbsolute: walRoot, journalRoot: s.input.current.wal.root,
    })
    s.input.backup = { ...s.input.backup, adapter: index }
    s.input.current.destination.adapter = index
    s.input.current.wal.adapter = {
      read: name => reader!.adapter.read(name),
      exists: name => reader!.adapter.exists(name),
    }
    s.input.withExclusiveRecoveryLease = async <T>(body: () => Promise<T>) => {
      await reader!.assertExclusiveStageLease()
      return body()
    }
    s.input.assertExclusiveRecoveryLease = () => reader!.assertExclusiveStageLease()
    s.input.assertBestEffortWalCheckpoint = () => reader!.assertBestEffortCheckpoint()
    const result = await inspectV4ColdStartCompleteRecovery(s.input)
    assert.equal(result.observation, "authenticated-complete-recovery-evidence-still-fenced")
    assert.equal(result.resumeSyncAuthorized, false)
    assert.equal(result.powerLossDurabilityProven, false)
    for (const [name, text] of s.walFiles) {
      assert.equal(await reader.adapter.read(name), text)
    }
    for (const [name, text] of s.old.f.s.files) {
      assert.equal(await readFile(path.join(indexRoot, name), "utf8"), text)
    }
  } finally {
    await reader?.release()
    await writer?.release()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("D247 requires one owner, physical Index and SecretStorage and never invokes a lease for foreign inputs", async () => {
  const s = await d247Scenario()
  const originalOwner = s.input.current.wal.assertLiveOwner
  const originalAdapter = s.input.current.destination.adapter
  const originalSecret = s.input.current.destination.getSecret
  for (const reason of ["wal owner", "index adapter", "secret"] as const) {
    if (reason === "wal owner") s.input.current.wal.assertLiveOwner = () => {}
    if (reason === "index adapter") s.input.current.destination.adapter = {
      ...originalAdapter,
    }
    if (reason === "secret") s.input.current.destination.getSecret = id => originalSecret(id)
    const report = await inspectV4ColdStartCompleteRecovery(s.input)
    assert.equal(report.observation, "manual-recovery-required", reason)
    assert.equal(report.localCutoverAuthorized, false, reason)
    assert.equal(s.getHolderCalls(), 0, reason)
    s.input.current.wal.assertLiveOwner = originalOwner
    s.input.current.destination.adapter = originalAdapter
    s.input.current.destination.getSecret = originalSecret
  }
})

test("D247 rejects an independently recovered wrong key without touching either encrypted WAL slot", async () => {
  const s = await d247Scenario()
  const bytes = new Map(s.walFiles)
  const local = new Map(s.old.f.s.files)
  s.input.current.wal.originalJournalKey[0] ^= 1
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.originalKeyAuthenticated, false)
  assert.equal(report.completeDestinationContentsReverified, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.deepEqual(s.walFiles, bytes)
  assert.deepEqual(s.old.f.s.files, local)
  assert.equal(s.getHolderCalls(), 1)
  assert.equal(s.isHeld(), false)
})

test("D247 rechecks frozen Backup after Destination scan and refuses changed old ref", async () => {
  const s = await d247Scenario()
  const newGit = s.input.current.destination.destinationGit
  const readBlob = newGit.getBlob
  let changed = false
  newGit.getBlob = async sha => {
    const bytes = await readBlob(sha)
    if (!changed) {
      changed = true
      s.old.b.setRef("9".repeat(40))
    }
    return bytes
  }
  const wal = new Map(s.walFiles)
  const writes = s.old.f.s.getWrites()
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(changed, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(s.isHeld(), false)
  assert.equal(s.getHolderCalls(), 1)
  assert.deepEqual(s.walFiles, wal)
  assert.equal(s.old.f.s.getWrites(), writes)
})

test("D247 rejects old Backup client method replacement during new-key Git scan", async () => {
  const s = await d247Scenario()
  const git = s.input.current.destination.destinationGit
  const readBlob = git.getBlob
  let altered = false
  git.getBlob = async sha => {
    const data = await readBlob(sha)
    if (!altered) {
      altered = true
      const backupBlob = s.old.input.backupGit.getBlob
      s.old.input.backupGit.getBlob = async blobSha => backupBlob(blobSha)
    }
    return data
  }
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(altered, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(s.getHolderCalls(), 1)
  assert.equal(s.isHeld(), false)
})

test("D247 revoked exclusive recovery lease during Destination ciphertext scan fails closed", async () => {
  const s = await d247Scenario()
  const git = s.input.current.destination.destinationGit
  const readBlob = git.getBlob
  let revoked = false
  git.getBlob = async sha => {
    const value = await readBlob(sha)
    if (!revoked) {
      revoked = true
      s.revokeLease()
    }
    return value
  }
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(revoked, true)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.walReceiptsBoundToDestination, false)
  assert.equal(report.remoteWritesAuthorized, false)
  assert.equal(s.isHeld(), false)
})

test("D247 refuses a torn encrypted WAL and leaves both original-key Backup and physical slots untouched", async () => {
  const s = await d247Scenario()
  const slot = s.input.current.wal.root + "/slot-" + (s.contract.identity.walGeneration % 2) + ".json"
  s.walFiles.set(slot, s.walFiles.get(slot)!.slice(0, 40))
  const walBefore = new Map(s.walFiles)
  const filesBefore = new Map(s.old.f.s.files)
  const report = await inspectV4ColdStartCompleteRecovery(s.input)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.completeOldBackupReverified, false)
  assert.equal(report.completeDestinationContentsReverified, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(s.isHeld(), false)
  assert.deepEqual(s.walFiles, walBefore)
  assert.deepEqual(s.old.f.s.files, filesBefore)
})

test("D248/D250/D252 verifies Desktop WAL lock, installed physical readback and old-key authentication", async () => {
  const s = await d247Scenario()
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const temporary = await mkdtemp(path.join(process.cwd(), ".tmp", "d248-owner-"))
  const vault = path.join(temporary, "vault")
  const configDir = ".obsidian"
  const pluginId = "github-sync-d248"
  const runId = s.contract.identity.runId
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const pluginRoot = path.join(vault, ...layout.pluginStorageRoot.split("/"))
  await mkdir(pluginRoot, { recursive: true })
  const physicalWal = path.join(pluginRoot, ...layout.journalRoot.split("/"))
  let seeded: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    seeded = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: pluginRoot, journalRoot: layout.journalRoot,
      requireNewJournalRoot: true,
    })
    for (const [name, ciphertext] of s.walFiles) {
      await seeded.adapter.write(layout.journalRoot + "/" + path.posix.basename(name), ciphertext)
    }
    const owner = {
      adapter: {
        getFullPath(location: string) {
          return location ? path.join(vault, ...location.split("/")) : vault
        },
      },
      configDir, pluginId, runId,
      assertLiveOwner: s.input.backup.assertLiveOwner,
    }
    const evidence = {
      owner, backup: s.input.backup, contract: s.contract,
      destination: s.input.current.destination,
      originalJournalKey: Uint8Array.from(s.input.current.wal.originalJournalKey),
    }
    const before = await Promise.all([readFile(path.join(physicalWal, "slot-0.json")),
      readFile(path.join(physicalWal, "slot-1.json"))])
    const competing = await inspectV4DesktopPluginCompleteRecovery(evidence)
    assert.equal(competing.observation, "manual-recovery-required")
    assert.equal(competing.resumeSyncAuthorized, false)
    // D250: exercise the actual installed Runtime against the same disposable
    // physical WAL. This is structural evidence ONLY, not key authentication.
    const local = s.old.f.s.adapter
    const prefix = configDir + "/plugins/" + pluginId + "/"
    const settings = (JSON.parse(s.old.saved) as { settings: Record<string, unknown> }).settings
    const installedAdapter = {
      ...owner.adapter,
      read: (name: string) => local.read(name.replace(prefix, "")),
      write: (name: string, value: string) => local.write(name.replace(prefix, ""), value),
      exists: (name: string) => local.exists(name.replace(prefix, "")),
      mkdir: (name: string) => local.mkdir(name.replace(prefix, "")),
    }
    const runtime = new V4PluginRuntime({
      settings, manifest: { id: pluginId }, loadData: async () => JSON.parse(s.old.saved),
      isSyncInProgress: false,
      app: {
        vault: { configDir, adapter: installedAdapter },
        secretStorage: { getSecret: (id: string) => s.old.f.s.secrets.get(id) ?? null },
      },
    } as never)
    try {
      settings["githubToken"] = "offline-d252-test-token"
      const blockedCrypto = await runtime.verifyFencedReencryptionAuthenticatedWal()
      assert.equal(blockedCrypto, null, "competing WAL writer blocks D252 original-key authentication")
      const blocked = await runtime.inspectFencedReencryptionExistingWalStructure()
      assert.equal(blocked.observation, "manual-recovery-required",
        "a competing writer must refuse even a structural WAL report")
      assert.equal(blocked.walAuthenticated, false)
      await seeded.release()
      seeded = undefined
      const structure = await runtime.inspectFencedReencryptionExistingWalStructure()
      assert.equal(structure.observation, "existing-wal-structure-observed-untrusted")
      assert.equal(structure.walAuthenticated, false)
      assert.equal(structure.completeRecoveryProven, false)
      assert.equal(structure.powerLossDurabilityProven, false)
      assert.equal(structure.installedObsidianAcceptanceProven, false)
      assert.equal(structure.resumeSyncAuthorized, false)
      assert.equal(structure.localCutoverAuthorized, false)
      const originalRead = installedAdapter.read
      const sourceBranch = settings["githubBranch"]
      installedAdapter.read = async (name: string) => {
        const value = await originalRead(name)
        settings["githubBranch"] = "changed-during-read"
        return value
      }
      const changed = await runtime.inspectFencedReencryptionExistingWalStructure()
      assert.equal(changed.observation, "manual-recovery-required")
      installedAdapter.read = originalRead
      settings["githubBranch"] = sourceBranch

      const methods = [
        "getRepositoryIdentity", "getRepositoryDefaultBranch", "getGitRef",
        "getGitCommit", "getTreeAt", "getBlob",
      ] as const
      type Stub = (this: GitHubClient, ...args: never[]) => Promise<unknown>
      const prototype = GitHubClient.prototype as unknown as Record<string, Stub>
      const originalMethods = methods.map(name => prototype[name]!)
      const backupGit = s.old.input.backupGit as unknown as Record<string, Stub>
      const destinationGit = s.input.current.destination.destinationGit as unknown as Record<string, Stub>
      const backupBranch = s.contract.identity.backupRepoId.split("#")[1]
      let drift = false
      try {
        for (const name of methods) {
          prototype[name] = function (this: GitHubClient, ...args: never[]) {
            if (name === "getRepositoryIdentity" && drift) {
              settings["githubBranch"] = "changed-after-opening-wal"
            }
            const selected = this.branchName === backupBranch ? backupGit : destinationGit
            return selected[name]!.call(selected as never, ...args)
          }
        }
        const authenticated = await runtime.verifyFencedReencryptionAuthenticatedWal()
        assert.equal(authenticated?.observation, "authenticated-local-route-still-fenced")
        assert.equal(authenticated?.originalKeyAuthenticated, true)
        assert.equal(authenticated?.completeBackupContentsReverified, true)
        assert.equal(authenticated?.coldStartWalReverified, true)
        assert.equal(authenticated?.destinationCiphertextReceiptsReverified, true)
        assert.equal(authenticated?.completeDestinationContentsReverified, false)
        assert.equal(authenticated?.resumeSyncAuthorized, false)
        assert.equal(authenticated?.localCutoverAuthorized, false)
        drift = true
        const changedOwner = await runtime.verifyFencedReencryptionAuthenticatedWal()
        assert.ok(changedOwner === null || changedOwner.observation === "manual-recovery-required")
        settings["githubBranch"] = sourceBranch
        drift = false
      } finally {
        methods.forEach((name, i) => { prototype[name] = originalMethods[i]! })
      }
    } finally {
      runtime.dispose()
    }
    // D250 released the competing writer without changing either WAL slot.
    const result = await inspectV4DesktopPluginCompleteRecovery(evidence)
    assert.equal(result.observation, "authenticated-complete-recovery-evidence-still-fenced")
    assert.equal(result.completeOldBackupReverified, true)
    assert.equal(result.walReceiptsBoundToDestination, true)
    assert.equal(result.isolation, "desktop-os-cooperative-wal-lock")
    assert.equal(result.mobileOsLockProven, false)
    assert.equal(result.installedObsidianAcceptanceProven, false)
    assert.equal(result.localCutoverAuthorized, false)
    assert.equal(result.resumeSyncAuthorized, false)
    const after = await Promise.all([readFile(path.join(physicalWal, "slot-0.json")),
      readFile(path.join(physicalWal, "slot-1.json"))])
    assert.deepEqual(after, before)
    assert.deepEqual((await (await import("node:fs/promises")).readdir(physicalWal)).sort(),
      ["slot-0.json", "slot-1.json"])
    const wrong = await inspectV4DesktopPluginCompleteRecovery({
      ...evidence, owner: { ...owner, runId: "not-the-saved-run" },
    })
    assert.equal(wrong.observation, "manual-recovery-required")
    assert.equal(wrong.resumeSyncAuthorized, false)
  } finally {
    await seeded?.release()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("D248/D250/D252 Mobile existing WAL and installed old-key authentication remain non-authorizing", async () => {
  const s = await d247Scenario()
  const runId = s.contract.identity.runId
  const configDir = ".obsidian"
  const pluginId = "github-sync-d248-mobile"
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const directories = new Set<string>([
    configDir, configDir + "/plugins", layout.pluginStorageRoot,
    layout.pluginStorageRoot + "/reencryption-wal", layout.vaultLogicalWalRoot,
  ])
  const files = new Map<string, string>()
  for (const [name, ciphertext] of s.walFiles) {
    files.set(layout.vaultLogicalWalRoot + "/" + name.slice(name.lastIndexOf("/") + 1),
      ciphertext)
  }
  let readCount = 0
  const adapter = {
    async stat(name: string) {
      if (directories.has(name)) return { type: "folder" as const, size: 0, mtime: 5 }
      const value = files.get(name)
      return value === undefined ? null : {
        type: "file" as const, size: enc(value).length, mtime: 5,
      }
    },
    async list(name: string) {
      if (!directories.has(name)) throw Error("missing Mobile folder")
      const prefix = name + "/"
      return {
        files: [...files.keys()].filter(key => key.startsWith(prefix)
          && !key.slice(prefix.length).includes("/")),
        folders: [...directories].filter(key => key.startsWith(prefix)
          && !key.slice(prefix.length).includes("/")),
      }
    },
    async read(name: string) {
      readCount++
      const value = files.get(name)
      if (value !== undefined) return value
      const prefix = configDir + "/plugins/" + pluginId + "/"
      if (name.startsWith(prefix)) return s.old.f.s.adapter.read(name.slice(prefix.length))
      throw Error("missing Mobile ciphertext or local recovery Index")
    },
    async exists(name: string) {
      if (files.has(name)) return true
      const prefix = configDir + "/plugins/" + pluginId + "/"
      return name.startsWith(prefix)
        ? s.old.f.s.adapter.exists(name.slice(prefix.length)) : false
    },
    async write() { throw Error("D250 installed physical WAL preflight must not write") },
    async mkdir() { throw Error("D250 installed physical WAL preflight must not mkdir") },
  }
  let held = false
  let leaseCount = 0
  const owner = { adapter, configDir, pluginId, runId,
    assertLiveOwner: s.input.backup.assertLiveOwner }
  const evidence = {
    owner, backup: s.input.backup, contract: s.contract,
    destination: s.input.current.destination,
    originalJournalKey: Uint8Array.from(s.input.current.wal.originalJournalKey),
    withExclusiveCooperativeRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
      if (held) throw Error("reentrant Mobile recovery lease")
      held = true
      leaseCount++
      try { return await body() }
      finally { held = false }
    },
    assertCooperativeRecoveryLease: async () => {
      if (!held) throw Error("Mobile recovery lease lost")
    },
  }
  const before = new Map(files)
  const result = await inspectV4MobilePluginCompleteRecovery(evidence)
  assert.equal(result.observation, "authenticated-complete-recovery-evidence-still-fenced")
  assert.equal(result.isolation, "mobile-cooperative-best-effort-only")
  assert.equal(result.mobileOsLockProven, false)
  assert.equal(result.installedObsidianAcceptanceProven, false)
  assert.equal(result.powerLossDurabilityProven, false)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(held, false)
  assert.equal(leaseCount, 1)
  assert.ok(readCount > 8)
  assert.deepEqual(files, before)
  const platformWasDesktop = Platform.isDesktopApp
  let runtime: V4PluginRuntime | undefined
  try {
    Platform.isDesktopApp = false
    const settings = (JSON.parse(s.old.saved) as { settings: Record<string, unknown> }).settings
    runtime = new V4PluginRuntime({
      settings, manifest: { id: pluginId }, loadData: async () => JSON.parse(s.old.saved),
      isSyncInProgress: false,
      app: {
        vault: { configDir, adapter },
        secretStorage: { getSecret: (id: string) => s.old.f.s.secrets.get(id) ?? null },
      },
    } as never)
    const structure = await runtime.inspectFencedReencryptionExistingWalStructure()
    assert.equal(structure.observation, "existing-wal-structure-observed-untrusted")
    assert.equal(structure.walAuthenticated, false)
    assert.equal(structure.completeRecoveryProven, false)
    assert.equal(structure.powerLossDurabilityProven, false)
    assert.equal(structure.installedObsidianAcceptanceProven, false)
    assert.equal(structure.localCutoverAuthorized, false)
    assert.equal(structure.resumeSyncAuthorized, false)
    settings["githubToken"] = "offline-d252-mobile-test-token"
    const methods = [
      "getRepositoryIdentity", "getRepositoryDefaultBranch", "getGitRef",
      "getGitCommit", "getTreeAt", "getBlob",
    ] as const
    type Stub = (this: GitHubClient, ...args: never[]) => Promise<unknown>
    const prototype = GitHubClient.prototype as unknown as Record<string, Stub>
    const originals = methods.map(name => prototype[name]!)
    const backupGit = s.old.input.backupGit as unknown as Record<string, Stub>
    const destinationGit = s.input.current.destination.destinationGit as unknown as Record<string, Stub>
    const backupBranch = s.contract.identity.backupRepoId.split("#")[1]
    try {
      for (const name of methods) {
        prototype[name] = function (this: GitHubClient, ...args: never[]) {
          const selected = this.branchName === backupBranch ? backupGit : destinationGit
          return selected[name]!.call(selected as never, ...args)
        }
      }
      const authenticated = await runtime.verifyFencedReencryptionAuthenticatedWal()
      assert.equal(authenticated?.observation, "authenticated-local-route-still-fenced")
      assert.equal(authenticated?.coldStartWalReverified, true)
      assert.equal(authenticated?.destinationCiphertextReceiptsReverified, true)
      assert.equal(authenticated?.completeBackupContentsReverified, true)
      assert.equal(authenticated?.completeDestinationContentsReverified, false)
      assert.equal(authenticated?.resumeSyncAuthorized, false)
    } finally {
      methods.forEach((name, i) => { prototype[name] = originals[i]! })
    }
    assert.deepEqual(files, before, "installed Mobile preflight cannot mutate WAL")
  } finally {
    runtime?.dispose()
    Platform.isDesktopApp = platformWasDesktop
  }
  const cooperativeLease = evidence.assertCooperativeRecoveryLease
  evidence.assertCooperativeRecoveryLease = async () => {
    throw Error("cooperative lease was revoked")
  }
  const revoked = await inspectV4MobilePluginCompleteRecovery(evidence)
  assert.equal(revoked.observation, "manual-recovery-required")
  assert.deepEqual(files, before)
  evidence.assertCooperativeRecoveryLease = cooperativeLease
  files.set(layout.vaultLogicalWalRoot + "/slot-0.json", "{torn")
  const failed = await inspectV4MobilePluginCompleteRecovery(evidence)
  assert.equal(failed.observation, "manual-recovery-required")
  assert.equal(failed.localCutoverAuthorized, false)
  assert.equal(files.get(layout.vaultLogicalWalRoot + "/slot-0.json"), "{torn")
})

test("D240 independently recovered Backup key and saved Cutover Contract bind to one exact D239 input", async () => {
  const s = await d235Scenario()
  const manifestPath = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-"
    + s.f.id.runId + "/contract.json"
  const encoded = await s.f.s.adapter.read(manifestPath)
  const contract = decodeV4ReencryptionCutoverCandidateManifest(encoded)
  const binding = { contract, originalJournalKey: Uint8Array.from(s.oldJournalKey) }
  const files = new Map(s.f.s.files)
  const secrets = new Map(s.f.s.secrets)
  const writes = s.f.s.getWrites()
  const result = await inspectV4ReencryptionColdStartJournalKey({
    ...s.input, expectedRecoveryBinding: binding,
  })
  assert.equal(result.observation, "authenticated-local-route-still-fenced")
  assert.equal(result.completeBackupContentsReverified, true)
  assert.equal(result.recoveredKeyAndContractBoundToCaller, true)
  assert.equal(result.completeDestinationContentsReverified, false)
  assert.equal(result.coldStartWalReverified, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(s.f.s.getWrites(), writes)
  assert.deepEqual(s.f.s.files, files)
  assert.deepEqual(s.f.s.secrets, secrets)
  assert.deepEqual(binding.originalJournalKey, s.oldJournalKey)
  const oldReport = await inspectV4ReencryptionColdStartJournalKey(s.input)
  assert.equal(oldReport.recoveredKeyAndContractBoundToCaller, false)
  assert.equal(oldReport.completeBackupContentsReverified, true)
})

test("D240 rejects foreign key and saved Contract binding without treating either as new proof", async () => {
  for (const cause of ["key", "transaction", "generation"] as const) {
    const s = await d235Scenario()
    const encoded = await s.f.s.adapter.read(V4_RUNTIME_INDEX_ROOT
      + "-rekey-cutover-candidate-" + s.f.id.runId + "/contract.json")
    const contract = decodeV4ReencryptionCutoverCandidateManifest(encoded)
    const key = Uint8Array.from(s.oldJournalKey)
    if (cause === "key") key[0] ^= 1
    if (cause === "transaction") Object.assign(contract, { transactionId: "1".repeat(32) })
    if (cause === "generation") Object.assign(contract.identity, {
      walGeneration: contract.identity.walGeneration + 1,
    })
    const writes = s.f.s.getWrites()
    const report = await inspectV4ReencryptionColdStartJournalKey({
      ...s.input, expectedRecoveryBinding: { contract, originalJournalKey: key },
    })
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.recoveredKeyAndContractBoundToCaller, false, cause)
    assert.equal(report.localCutoverAuthorized, false, cause)
    assert.equal(report.remoteWritesAuthorized, false, cause)
    assert.equal(s.f.s.getWrites(), writes, cause)
  }
})

test("D240 key, Contract and saved manifest mutation during Git read fail closed", async () => {
  for (const cause of ["key", "contract", "manifest"] as const) {
    const s = await d235Scenario()
    const manifestPath = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-"
      + s.f.id.runId + "/contract.json"
    const contract = decodeV4ReencryptionCutoverCandidateManifest(
      await s.f.s.adapter.read(manifestPath),
    )
    const binding = { contract, originalJournalKey: Uint8Array.from(s.oldJournalKey) }
    const readBlob = s.b.github.getBlob
    let altered = false
    s.b.github.getBlob = async sha => {
      const bytes = await readBlob(sha)
      if (!altered) {
        altered = true
        if (cause === "key") binding.originalJournalKey[0] ^= 1
        else if (cause === "contract") Object.assign(binding.contract, { transactionId: "1".repeat(32) })
        else s.f.s.files.set(manifestPath, "{torn")
      }
      return bytes
    }
    const writes = s.f.s.getWrites()
    const report = await inspectV4ReencryptionColdStartJournalKey({
      ...s.input, expectedRecoveryBinding: binding,
    })
    assert.equal(altered, true, cause)
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.recoveredKeyAndContractBoundToCaller, false, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(s.f.s.getWrites(), writes, cause)
  }
})

test("D236 cold-start verification rejects a corrupt Backup shard after the original key is authenticated", async () => {
  const s = await d235Scenario()
  const pristine = s.b.github.getBlob
  const headerShas = new Set<string>()
  let corrupted = false
  s.b.github.getBlob = async sha => {
    const bytes = await pristine(sha)
    if (headerShas.size < 2) headerShas.add(sha)
    if (!headerShas.has(sha) && !corrupted) {
      bytes[0] ^= 1
      corrupted = true
    }
    return bytes
  }
  const writes = s.f.s.getWrites()
  const result = await inspectV4ReencryptionColdStartJournalKey(s.input)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.completeBackupContentsReverified, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(s.f.s.getWrites(), writes)
  assert.equal(corrupted, true, "The full verifier must read an index or content object")
})

test("D236 a Git object failing on the second complete Backup scan is not certified", async () => {
  const s = await d235Scenario()
  const originalGetBlob = s.b.github.getBlob
  const headerShas = new Set<string>()
  const bodyReads = new Map<string, number>()
  let corruptedOnSecondScan = false
  s.b.github.getBlob = async sha => {
    const bytes = await originalGetBlob(sha)
    if (headerShas.size < 2) headerShas.add(sha)
    if (!headerShas.has(sha)) {
      const count = (bodyReads.get(sha) ?? 0) + 1
      bodyReads.set(sha, count)
      if (count === 2 && !corruptedOnSecondScan) {
        bytes[0] ^= 1
        corruptedOnSecondScan = true
      }
    }
    return bytes
  }
  const result = await inspectV4ReencryptionColdStartJournalKey(s.input)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.completeBackupContentsReverified, false)
  assert.equal(corruptedOnSecondScan, true)
})

test("D236 a changed backup ref or native Settings during full readback never authorizes recovery", async () => {
  const moved = await d235Scenario()
  const originalRef = moved.b.github.getGitRef
  let refs = 0
  moved.b.github.getGitRef = async () => {
    const result = await originalRef()
    return ++refs >= 3 ? { ...result, sha: "9".repeat(40) } : result
  }
  const refReport = await inspectV4ReencryptionColdStartJournalKey(moved.input)
  assert.equal(refReport.observation, "manual-recovery-required")
  assert.equal(refReport.completeBackupContentsReverified, false)

  const changed = await d235Scenario()
  const originalBlob = changed.b.github.getBlob
  const headerShas = new Set<string>()
  let changedDuringScan = false
  changed.b.github.getBlob = async sha => {
    const bytes = await originalBlob(sha)
    if (headerShas.size < 2) headerShas.add(sha)
    if (!headerShas.has(sha) && !changedDuringScan) {
      changedDuringScan = true
      const persisted = JSON.parse(changed.saved)
      persisted.settings.ignorePathRegex = "changed-during-backup-scan"
      changed.setPersisted(persisted)
    }
    return bytes
  }
  const settingsReport = await inspectV4ReencryptionColdStartJournalKey(changed.input)
  assert.equal(settingsReport.observation, "manual-recovery-required")
  assert.equal(settingsReport.completeBackupContentsReverified, false)
  assert.equal(settingsReport.remoteWritesAuthorized, false)
  assert.equal(changedDuringScan, true)
})

test("D235 wrong old SecretStorage passphrase, absent key and modified backup refs reject cold-start authentication", async () => {
  const s = await d235Scenario()
  const originalSecret = s.f.s.secrets.get(s.f.id.sourcePassphraseSecretId)!
  s.f.s.secrets.set(s.f.id.sourcePassphraseSecretId, "wrong-old-passphrase")
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.f.s.secrets.delete(s.f.id.sourcePassphraseSecretId)
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.f.s.secrets.set(s.f.id.sourcePassphraseSecretId, originalSecret)
  s.b.setRef("9".repeat(40))
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.b.setRef(pinned)
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "authenticated-local-route-still-fenced")
})

test("D235 altered immutable Git content, foreign physical repo, changed callbacks and Settings reject key authentication", async () => {
  const s = await d235Scenario()
  const getBlob = s.b.github.getBlob
  s.b.github.getBlob = async sha => {
    const bytes = await getBlob(sha)
    bytes[0] ^= 1
    return bytes
  }
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.b.github.getBlob = getBlob
  const getRef = s.b.github.getGitRef
  let checks = 0
  s.b.github.getGitRef = async () => {
    const observed = await getRef()
    checks++
    return checks > 1 ? { ...observed, sha: "9".repeat(40) } : observed
  }
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.b.github.getGitRef = getRef
  const getRepo = s.b.github.getRepositoryIdentity
  s.b.github.getRepositoryIdentity = async () => ({ id: 88, fullName: "other/repo" })
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  s.b.github.getRepositoryIdentity = getRepo
  const stored = JSON.parse(s.saved)
  stored.settings.ignorePathRegex = "changed-by-background-settings"
  s.setPersisted(stored)
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
  stored.settings.ignorePathRegex = "^Local/"
  s.setPersisted(stored)
  s.invalidateOwner()
  assert.equal((await inspectV4ReencryptionColdStartJournalKey(s.input)).observation, "manual-recovery-required")
})

async function d234ColdStart(s: Awaited<ReturnType<typeof d233Scenario>>, key?: Uint8Array) {
  const native = {
    adapter: s.f.s.adapter,
    readPersistedPluginData: async () => JSON.parse(s.saved),
    getSecret: (id: string) => s.f.s.secrets.get(id) ?? null,
    ...(key ? { journalKey: key } : {}),
  }
  return inspectV4ReencryptionColdStartIndexRoute(native)
}

test("D234 independent cold-start reads exact persisted Destination route and shadow but grants no Sync authority", async () => {
  const s = await d233Scenario()
  const savedFiles = new Map(s.f.s.files)
  const oldSecrets = new Map(s.f.s.secrets)
  const count = s.f.s.getWrites()
  await persistV4FencedDestinationSettings(s.cutover)
  const routeText = s.f.s.files.get(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
  assert.ok(routeText)
  assert.equal(s.f.s.files.size, savedFiles.size + 2)
  for (const [path, value] of savedFiles) assert.equal(s.f.s.files.get(path), value, path)
  assert.deepEqual(s.f.s.secrets, oldSecrets)
  const marker = await authenticateV4RuntimeIndexRouteIntent(
    routeText, s.f.prepared.journalKey,
  )
  assert.equal(marker.sourceRepoId, s.f.id.sourceRepoId)
  assert.equal(marker.destinationRepoId, s.f.id.destinationRepoId)
  assert.equal(marker.sourceIndexRoot, V4_RUNTIME_INDEX_ROOT)
  assert.equal(marker.shadowIndexRoot, V4_RUNTIME_INDEX_ROOT + "-rekey-" + s.f.id.runId)
  const unkeyed = await d234ColdStart(s)
  assert.equal(unkeyed.observation, "destination-shadow-diagnostic-only")
  assert.equal(unkeyed.diagnosticIndexRoot, marker.shadowIndexRoot)
  assert.equal(unkeyed.routingHintAuthenticated, false)
  assert.equal(unkeyed.resumeSyncAuthorized, false)
  assert.equal(unkeyed.localCutoverAuthorized, false)
  const keyed = await d234ColdStart(s, s.f.prepared.journalKey)
  assert.equal(keyed.observation, "destination-shadow-diagnostic-only")
  assert.equal(keyed.routingHintAuthenticated, true)
  assert.equal(keyed.remoteWritesAuthorized, false)
  assert.equal(s.f.s.getWrites(), count + 2)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.f.s.adapter))
})

test("D234 Runtime read-only Destination Shadow route uses native persistent plugin storage, never changes active Source", async () => {
  const s = await d233Scenario()
  await persistV4FencedDestinationSettings(s.cutover)
  const writes = s.f.s.getWrites()
  const prefix = ".obsidian/plugins/test-d234/"
  const disk = s.f.s.adapter
  const nativeAdapter = {
    read: (path: string) => disk.read(path.replace(prefix, "")),
    write: (path: string, text: string) => disk.write(path.replace(prefix, ""), text),
    mkdir: (path: string) => disk.mkdir(path.replace(prefix, "")),
    exists: (path: string) => disk.exists(path.replace(prefix, "")),
  }
  const runtime = new V4PluginRuntime({
    app: {
      vault: { configDir: ".obsidian", adapter: nativeAdapter },
      secretStorage: { getSecret: (id: string) => s.f.s.secrets.get(id) ?? null },
    },
    manifest: { id: "test-d234" },
    loadData: async () => JSON.parse(s.saved),
  } as never)
  try {
    const observed = await runtime.inspectFencedReencryptionIndexRoute()
    assert.equal(observed.observation, "destination-shadow-diagnostic-only")
    assert.equal(runtime.getReencryptionColdStartIndexRoute(), observed)
    const shadow = await runtime.readFencedReencryptionDestinationIndexForRecovery()
    assert.equal(shadow?.repoId, s.f.id.destinationRepoId)
    assert.equal(shadow?.remoteCommitSha, s.f.id.destinationCommitSha)
    assert.equal(s.f.s.getWrites(), writes, "the read-only Runtime recovery route never writes")
    await assert.rejects(() => runtime.assertReencryptionSettingsSaveAllowed(),
      /Re-encryption|pending/i)
  } finally {
    runtime.dispose()
  }
})

test("D234 a torn stable routing marker never performs native Settings write or allows retry", async () => {
  const s = await d233Scenario()
  const originalWrite = s.f.s.adapter.write
  s.f.s.adapter.write = async (path, value) => {
    if (path === V4_REENCRYPTION_RUNTIME_ROUTE_PATH) {
      s.f.s.files.set(path, value.slice(0, 14))
      throw Error("injected interrupted D234 routing marker write")
    }
    return originalWrite(path, value)
  }
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover), /injected interrupted/)
  assert.equal(s.saved, s.initial)
  assert.equal(s.writes, 0)
  assert.equal(s.f.s.files.has(V4_REENCRYPTION_RUNTIME_ROUTE_PATH), true)
  assert.equal((await d234ColdStart(s)).observation, "manual-recovery-required")
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.f.s.adapter))
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
    /prior Settings write Intent needs Manual Recovery/)
})

test("D234 stuck routing marker blocks Sync even if the primary fence is accidentally deleted", async () => {
  const s = await d233Scenario()
  await persistV4FencedDestinationSettings(s.cutover)
  const marker = s.f.s.files.get(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)!
  s.f.s.dirs.delete(V4_REENCRYPTION_SYNC_FENCE_ROOT)
  s.f.s.files.delete(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json")
  assert.equal((await d234ColdStart(s)).observation, "manual-recovery-required")
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.f.s.adapter),
    /Re-encryption|pending/i)
  // The stable root alone (without marker content) also refuses Sync.
  s.f.s.files.delete(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
  assert.equal(s.f.s.dirs.has(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT), true)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.f.s.adapter))
  s.f.s.files.set(V4_REENCRYPTION_RUNTIME_ROUTE_PATH, marker)
})

test("D234 cold-start exact Settings / Selector / Intent / Index / key tampering fails closed", async () => {
  const s = await d233Scenario()
  await persistV4FencedDestinationSettings(s.cutover)
  const routePath = V4_REENCRYPTION_RUNTIME_ROUTE_PATH
  const contractPath = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + s.f.id.runId + "/contract.json"
  const intentPath = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + s.f.id.runId + "/persisted-settings-write-intent.json"
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + s.f.id.runId + "/selector.json"
  const shadowPath = V4_RUNTIME_INDEX_ROOT + "-rekey-" + s.f.id.runId + "/index.json"
  const beforeWrites = s.f.s.getWrites()
  for (const path of [routePath, contractPath, intentPath, selectorPath, shadowPath]) {
    const original = s.f.s.files.get(path)!
    assert.ok(original, path)
    s.f.s.files.set(path, original.slice(0, 12))
    assert.equal((await d234ColdStart(s, s.f.prepared.journalKey)).observation,
      "manual-recovery-required", path)
    s.f.s.files.set(path, original)
  }
  const changed = JSON.parse(s.saved)
  changed.settings.ignorePathRegex = "changed-after-native-save"
  s.setPersisted(changed)
  assert.equal((await d234ColdStart(s)).observation, "manual-recovery-required")
  s.setPersisted(JSON.parse(JSON.stringify({ ...changed, settings: {
    ...changed.settings, ignorePathRegex: "^Local/",
  } })))
  s.f.s.secrets.delete(s.f.id.sourcePassphraseSecretId)
  assert.equal((await d234ColdStart(s)).observation, "manual-recovery-required")
  assert.equal(s.f.s.getWrites(), beforeWrites, "cold-start inspection never mutates disk")
})

async function d233Scenario(journalKey?: Uint8Array) {
  const { f, b, input } = await d232Scenario(journalKey)
  await writeV4FencedActiveSelectorFirstPhase(input)
  let persisted: unknown = {
    version: 13,
    settings: {
      ...f.prepared.restart.settings,
      githubTokenSecretId: "github-token-d233",
      syncEnabled: true, syncOnStartup: false, syncOnLocalChange: true,
      scheduledSyncEnabled: false, ignorePathRegex: "^Local/",
      conflictPolicy: "merge", scheduledSyncIntervalSeconds: 600,
      customFeaturePreference: { nested: ["keep", "as-is"] },
    },
    unrelatedObsidianData: { preserved: "untouched" },
  }
  const initial = JSON.stringify(persisted)
  let writes = 0
  const callbacks = {
    readPersistedPluginData: async (): Promise<unknown> => JSON.parse(JSON.stringify(persisted)),
    writePersistedPluginData: async (data: unknown) => {
      writes++
      persisted = JSON.parse(JSON.stringify(data))
    },
    assertLivePluginOwner: () => assert.equal(f.s.holderCounts().held, true),
  }
  const cutover = { ...input, ...callbacks }
  return {
    f, b, cutover, callbacks, initial,
    get saved() { return JSON.stringify(persisted) },
    get writes() { return writes },
    setPersisted(value: unknown) { persisted = value },
  }
}

test("D233 native plugin-data Settings commit preserves preferences and both passphrases under full post-Selector Git proof", async () => {
  const s = await d233Scenario()
  const beforeFiles = new Map(s.f.s.files)
  const beforeSecrets = new Map(s.f.s.secrets)
  const callsBefore = s.f.s.holderCounts().calls
  const report = await persistV4FencedDestinationSettings(s.cutover)
  assert.equal(report.status, "destination-settings-written-selector-commit-pending")
  assert.equal(report.commitDecisionAuthorized, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.equal(s.writes, 1)
  assert.equal(s.f.s.holderCounts().calls, callsBefore + 1)
  assert.equal(s.f.s.holderCounts().held, false)
  assert.deepEqual(s.f.s.secrets, beforeSecrets)
  assert.equal(s.f.s.files.size, beforeFiles.size + 2)
  for (const [path, text] of beforeFiles) assert.equal(s.f.s.files.get(path), text, path)
  const original = JSON.parse(s.initial)
  const actual = JSON.parse(s.saved)
  assert.deepEqual(actual.unrelatedObsidianData, original.unrelatedObsidianData)
  assert.deepEqual(actual.settings.customFeaturePreference, original.settings.customFeaturePreference)
  assert.deepEqual({ ...actual.settings, githubBranch: original.settings.githubBranch,
    encryptionPassphraseSecretId: original.settings.encryptionPassphraseSecretId }, original.settings)
  assert.equal(actual.settings.githubBranch, destination.split("#")[1])
  assert.equal(actual.settings.encryptionPassphraseSecretId, s.f.id.destinationPassphraseSecretId)
  assert.equal(Object.hasOwn(actual.settings, "encryptionPassphrase"), false)
  assert.equal(Object.hasOwn(actual.settings, "githubToken"), false)
  assert.equal(s.f.prepared.restart.settings.githubBranch, original.settings.githubBranch,
    "Source Settings witness remains unchanged")
  assert.deepEqual(await inspectV4FencedDestinationSettingsAfterRestart(s.cutover), {
    observation: "destination-settings-observed-uncommitted",
    artifactWindow: "destination-settings",
    integrityScope: "authenticated-plugin-settings-and-physical-selector",
    evidence: "best-effort-readback-not-power-loss-durable",
    commitDecisionAuthorized: false, localCutoverAuthorized: false,
    resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
    /prior Settings write Intent needs Manual Recovery/)
})

test("D233 write-ahead Intent interruption leaves old data and refuses automatic retry", async () => {
  const s = await d233Scenario()
  const path = s.f.id.indexRoot + "-rekey-cutover-candidate-" + s.f.id.runId
    + "/persisted-settings-write-intent.json"
  const prior = s.f.s.adapter.write
  s.f.s.adapter.write = async (target, value) => {
    if (target === path) {
      s.f.s.files.set(path, value.slice(0, 10))
      throw Error("injected partial Settings Intent")
    }
    return prior(target, value)
  }
  const secrets = new Map(s.f.s.secrets)
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
    /injected partial Settings Intent/)
  assert.equal(s.saved, s.initial)
  assert.equal(s.writes, 0)
  assert.deepEqual(s.f.s.secrets, secrets)
  assert.ok(s.f.s.files.has(path))
  assert.equal((await inspectV4FencedDestinationSettingsAfterRestart(s.cutover))
    .observation, "manual-recovery-required")
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
    /prior Settings write Intent needs Manual Recovery/)
})

test("D233 ambiguous native save failure preserves both secrets and classifies committed-or-not after Restart", async () => {
  for (const effect of ["before-write", "after-write", "torn-settings"] as const) {
    const s = await d233Scenario()
    const savedWrite = s.callbacks.writePersistedPluginData
    s.cutover.writePersistedPluginData = async (data) => {
      if (effect === "before-write") throw Error("injected saveData rejects before write")
      if (effect === "after-write") {
        await savedWrite(data)
        throw Error("injected saveData rejects after committing")
      }
      s.setPersisted({ settings: { ...JSON.parse(s.initial).settings,
        githubBranch: destination.split("#")[1] } })
      throw Error("injected half-written Settings data")
    }
    const preserved = new Map(s.f.s.secrets)
    await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
      /injected/)
    assert.deepEqual(s.f.s.secrets, preserved)
    const restarted = await inspectV4FencedDestinationSettingsAfterRestart(s.cutover)
    assert.equal(restarted.resumeSyncAuthorized, false)
    assert.equal(restarted.artifactWindow, effect === "before-write"
      ? "intent-only-source-settings" : effect === "after-write"
        ? "destination-settings" : "foreign-or-torn", effect)
    assert.equal(restarted.observation, effect === "after-write"
      ? "destination-settings-observed-uncommitted" : "manual-recovery-required")
    assert.equal(s.f.s.holderCounts().held, false)
  }
})

test("D233 full Git content changed with fixed HEAD prevents any native Settings write", async () => {
  const s = await d233Scenario()
  const before = new Map(s.f.s.files)
  const gh = s.f.s.f
  const entry = gh.entries.find(e => e.path === gh.receipts[0]!.path)!
  const bytes = gh.blobs.get(entry.sha)!
  const damaged = bytes.slice()
  damaged[damaged.length - 1] ^= 1
  gh.blobs.set(entry.sha, damaged)
  await assert.rejects(persistV4FencedDestinationSettings(s.cutover),
    /Git|blob|ciphertext|integrity|proof/i)
  assert.equal(s.saved, s.initial)
  assert.equal(s.writes, 0)
  assert.deepEqual(s.f.s.files, before)
  assert.equal(s.f.s.holderCounts().held, false)
})

test("D233 persist changes or missing old/new secret fail closed after Settings write", async () => {
  for (const kind of ["changed-preferences", "missing-old-secret", "moved-backup"] as const) {
    const s = await d233Scenario()
    await persistV4FencedDestinationSettings(s.cutover)
    if (kind === "changed-preferences") {
      const changed = JSON.parse(s.saved)
      changed.settings.ignorePathRegex = "^Altered/"
      s.setPersisted(changed)
    } else if (kind === "missing-old-secret") {
      s.f.s.secrets.delete(s.f.id.sourcePassphraseSecretId)
    } else {
      s.b.setRef("9".repeat(40))
    }
    const recovered = await inspectV4FencedDestinationSettingsAfterRestart(s.cutover)
    assert.equal(recovered.observation, "manual-recovery-required", kind)
    assert.equal(recovered.resumeSyncAuthorized, false, kind)
  }
})

async function d232Scenario(journalKey?: Uint8Array) {
  const f = await d179Scenario(journalKey)
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const settings = { ...f.prepared.restart.settings }
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...settings }),
  }
  await stageV4FencedCutoverActivationDecision(input)
  await stageV4FencedActivationSettingsSwitchPlan(input)
  return { f, b, settings, input }
}

test("D232 commits physical Destination Selector last, Source Settings/Indexes and two secrets remain unchanged under Sync Fence", async () => {
  const { f, input } = await d232Scenario()
  const filesBefore = new Map(f.s.files)
  const secretsBefore = new Map(f.s.secrets)
  const writesBefore = f.s.getWrites()
  const holdersBefore = f.s.holderCounts().calls
  const saved = await writeV4FencedActiveSelectorFirstPhase(input)
  assert.equal(saved.status, "destination-selector-written-settings-pending")
  assert.equal(saved.commitDecisionAuthorized, false)
  assert.equal(saved.localCutoverAuthorized, false)
  assert.equal(saved.resumeSyncAuthorized, false)
  assert.equal(saved.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.holderCounts().calls, holdersBefore + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.getWrites(), writesBefore + 2)
  assert.equal(f.s.files.size, filesBefore.size + 2)
  for (const [path, content] of filesBefore) assert.equal(f.s.files.get(path), content, path)
  assert.deepEqual(f.s.secrets, secretsBefore)
  assert.ok(f.s.files.has(saved.receiptPath))
  assert.ok(f.s.files.has(saved.selectorPath))
  assert.ok(saved.selectorPath.endsWith("/selector.json"))
  assert.ok(saved.selectorPath.includes("-rekey-selector-"))
  const report = await inspectV4FencedActiveSelectorAfterRestart(input)
  assert.deepEqual(report, {
    integrityScope: "read-only-physical-selector-settings-pending",
    observation: "authenticated-selector-settings-pending",
    artifactWindow: "both-linked",
    evidence: "best-effort-local-readback-no-post-switch-full-git-proof",
    commitDecisionAuthorized: false, localCutoverAuthorized: false,
    resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.equal((await inspectV4FencedPendingCommitPreflightAfterRestart(input))
    .observation, "manual-recovery-required", "old preflight MUST reject physical Selector")
  await assert.rejects(writeV4FencedActiveSelectorFirstPhase(input),
    /existing Selector or Receipt requires Manual Recovery/)
})

test("D232 independently authenticated physical pair rejects foreign key, swapped ciphertext and changed D231 plan", async () => {
  const { f, input } = await d232Scenario()
  const saved = await writeV4FencedActiveSelectorFirstPhase(input)
  const root = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
  const manifest = f.s.files.get(root + "/contract.json")!
  const contract = decodeV4ReencryptionCutoverCandidateManifest(manifest)
  const sources = {
    manifest, receiptCiphertext: f.s.files.get(root + "/receipt.json")!,
    selectorCiphertext: f.s.files.get(root + "/selector.json")!,
    intentCiphertext: f.s.files.get(root + "/intent.json")!,
    activationDecisionCiphertext: f.s.files.get(root + "/activation-decision.json")!,
    settingsSwitchPlanCiphertext: f.s.files.get(root + "/settings-switch-plan.json")!,
  }
  const oldSettings = { ...f.prepared.restart.settings }
  const pair = {
    receiptCiphertext: f.s.files.get(saved.receiptPath)!,
    selectorCiphertext: f.s.files.get(saved.selectorPath)!,
  }
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, f.prepared.journalKey, sources, oldSettings, pair,
  )).observation, "authenticated-destination-selector-settings-pending")
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, new Uint8Array(32).fill(5), sources, oldSettings, pair,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, f.prepared.journalKey, sources, oldSettings,
    { ...pair, receiptCiphertext: pair.selectorCiphertext },
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, f.prepared.journalKey,
    { ...sources, settingsSwitchPlanCiphertext: sources.activationDecisionCiphertext },
    oldSettings, pair,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, f.prepared.journalKey, sources, oldSettings,
    { ...pair, selectorCiphertext: null },
  )).artifactWindow, "receipt-only")
  assert.equal((await inspectV4ActiveSelectorCommitPair(
    contract, f.prepared.journalKey, sources, oldSettings,
    { ...pair, receiptCiphertext: null },
  )).artifactWindow, "selector-only")
})

test("D232 crash after Receipt write and after Selector write exposes distinct Manual Recovery windows without overwriting", async () => {
  for (const phase of ["receipt", "selector"] as const) {
    const { f, input } = await d232Scenario()
    const root = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
    const receiptPath = root + "/selector-commit-receipt.json"
    const selectorPath = f.id.indexRoot + "-rekey-selector-" + f.id.runId + "/selector.json"
    const originalWrite = f.s.adapter.write
    let didBreak = false
    const target = phase === "receipt" ? receiptPath : selectorPath
    f.s.adapter.write = async (path, value) => {
      if (path === target && !didBreak) {
        didBreak = true
        f.s.files.set(path, value.slice(0, 16))
        throw Error("injected interrupted " + phase + " write")
      }
      return originalWrite(path, value)
    }
    const oldSecret = new Map(f.s.secrets)
    await assert.rejects(writeV4FencedActiveSelectorFirstPhase(input),
      /injected interrupted/)
    assert.equal(didBreak, true)
    assert.ok(f.s.files.has(receiptPath))
    assert.equal(f.s.files.has(selectorPath), phase === "selector")
    const report = await inspectV4FencedActiveSelectorAfterRestart(input)
    assert.equal(report.observation, "manual-recovery-required", phase)
    assert.equal(report.artifactWindow, phase === "receipt" ? "receipt-only" : "foreign-or-torn")
    assert.equal(report.resumeSyncAuthorized, false)
    assert.deepEqual(f.s.secrets, oldSecret)
    assert.equal(f.s.holderCounts().held, false)
    await assert.rejects(writeV4FencedActiveSelectorFirstPhase(input),
      /existing Selector or Receipt requires Manual Recovery/)
  }
})

test("D232 live Git movement before or after physical Selector refuses success and retains forensic artifacts", async () => {
  for (const phase of ["receipt-backup", "receipt-destination", "selector-backup"] as const) {
    const { f, b, input } = await d232Scenario()
    const receipt = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId + "/selector-commit-receipt.json"
    const selector = f.id.indexRoot + "-rekey-selector-" + f.id.runId + "/selector.json"
    const originalWrite = f.s.adapter.write
    f.s.adapter.write = async (path, value) => {
      await originalWrite(path, value)
      if (path === receipt && phase === "receipt-backup") b.setRef("9".repeat(40))
      if (path === receipt && phase === "receipt-destination") f.s.f.changeRef("9".repeat(40))
      if (path === selector && phase === "selector-backup") b.setRef("9".repeat(40))
    }
    await assert.rejects(writeV4FencedActiveSelectorFirstPhase(input))
    assert.ok(f.s.files.has(receipt), phase)
    assert.equal(f.s.files.has(selector), phase === "selector-backup")
    const recovered = await inspectV4FencedActiveSelectorAfterRestart(input)
    assert.equal(recovered.observation, "manual-recovery-required", phase)
    assert.equal(recovered.resumeSyncAuthorized, false, phase)
    assert.equal(f.s.holderCounts().held, false, phase)
  }
})

test("D232 Restart detects Source Settings, Shadow Index, SecretStorage and Selector tampering without rewriting", async () => {
  const { f, input, b, settings } = await d232Scenario()
  const saved = await writeV4FencedActiveSelectorFirstPhase(input)
  const ciphertext = f.s.files.get(saved.selectorPath)!
  const shadowPath = f.id.indexRoot + "-rekey-" + f.id.runId + "/index.json"
  const shadow = f.s.files.get(shadowPath)!
  const oldSecret = f.s.secrets.get(f.id.sourcePassphraseSecretId)!
  const check = async (kind: string) => {
    assert.equal((await inspectV4FencedActiveSelectorAfterRestart(input))
      .observation, "manual-recovery-required", kind)
  }
  const writesBefore = f.s.getWrites()
  settings.githubBranch = "unauthorized"
  await check("persisted Settings")
  settings.githubBranch = f.prepared.restart.settings.githubBranch
  f.s.files.set(shadowPath, JSON.stringify({
    ...JSON.parse(shadow), repoId: "other/repo#branch",
  }))
  await check("Shadow Index")
  f.s.files.set(shadowPath, shadow)
  f.s.secrets.delete(f.id.sourcePassphraseSecretId)
  await check("missing old Secret")
  f.s.secrets.set(f.id.sourcePassphraseSecretId, oldSecret)
  f.s.files.set(saved.selectorPath, ciphertext.slice(0, 12))
  await check("torn Selector")
  f.s.files.set(saved.selectorPath, ciphertext)
  b.setRef("9".repeat(40))
  await check("stale Backup Git HEAD")
  b.setRef(f.id.sourceCommitSha)
  assert.equal((await inspectV4FencedActiveSelectorAfterRestart(input)).observation,
    "authenticated-selector-settings-pending")
  assert.equal(f.s.getWrites(), writesBefore, "all Restart inspections are read-only")
})

test("D232 forged owner holder cannot create Selector or Receipt and never forges a Cutover", async () => {
  const { f, b, input } = await d232Scenario()
  const fake = async <T>(_body: () => Promise<T>): Promise<T> =>
    Object.freeze({}) as T
  Object.assign(f.prepared, { withExclusiveInitiatorLease: fake })
  Object.assign(f.input.full.branches, { withExclusiveInitiatorLease: fake })
  Object.assign(b.backup, { withExclusiveInitiatorLease: fake })
  const before = new Map(f.s.files)
  await assert.rejects(writeV4FencedActiveSelectorFirstPhase(input),
    /owner holder cannot certify Selector write/)
  assert.deepEqual(f.s.files, before)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal((await inspectV4FencedActiveSelectorAfterRestart(input))
    .observation, "manual-recovery-required")
})

test("D231 one-lease Settings Switch Plan binds exact old/new Settings and distinct Index roots without activating", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  await stageV4FencedCutoverActivationDecision(input)
  const previousFiles = new Map(f.s.files)
  const previousSecrets = new Map(f.s.secrets)
  const holderCount = f.s.holderCounts().calls
  const result = await stageV4FencedActivationSettingsSwitchPlan(input)
  assert.equal(result.status, "settings-switch-plan-staged-not-applied")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.holderCounts().calls, holderCount + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.files.size, previousFiles.size + 1)
  for (const [path, value] of previousFiles) assert.equal(f.s.files.get(path), value, path)
  assert.deepEqual(f.s.secrets, previousSecrets)
  const ciphertext = f.s.files.get(result.planPath)
  assert.ok(ciphertext, "only isolated new Settings Plan is written")
  assert.ok(!ciphertext.includes("encryptionPassphraseSecretId"))
  assert.ok(!ciphertext.includes("githubBranch"))
  const recovered = await inspectV4FencedActivationSettingsSwitchPlanAfterRestart(input)
  assert.deepEqual(recovered, {
    integrityScope: "read-only-restarted-settings-switch-plan",
    observation: "authenticated-settings-switch-plan-not-applied",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, commitDecisionAuthorized: false,
    resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  await assert.rejects(stageV4FencedActivationSettingsSwitchPlan(input),
    /existing Settings Switch Plan requires Manual Recovery/)
})

test("D231 Settings Switch Plan rejects changed settings, key, recorded decision and truncated ciphertext", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  const staged = await stageV4FencedCutoverActivationDecision(input)
  const plan = await stageV4FencedActivationSettingsSwitchPlan(input)
  const root = plan.planPath.slice(0, -"/settings-switch-plan.json".length)
  const manifest = f.s.files.get(root + "/contract.json")!
  const contract = decodeV4ReencryptionCutoverCandidateManifest(manifest)
  const settings = { ...f.prepared.restart.settings }
  const sources = {
    manifest, receiptCiphertext: f.s.files.get(root + "/receipt.json")!,
    selectorCiphertext: f.s.files.get(root + "/selector.json")!,
    intentCiphertext: f.s.files.get(root + "/intent.json")!,
    activationDecisionCiphertext: f.s.files.get(staged.decisionPath)!,
  }
  const ciphertext = f.s.files.get(plan.planPath)!
  assert.equal((await inspectV4ActivationSettingsSwitchPlan(
    contract, f.prepared.journalKey, sources, settings, ciphertext,
  )).observation, "authenticated-settings-switch-plan-not-applied")
  assert.equal((await inspectV4ActivationSettingsSwitchPlan(
    contract, f.prepared.journalKey, sources, { ...settings, githubBranch: "untrusted" },
    ciphertext,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActivationSettingsSwitchPlan(
    contract, new Uint8Array(32).fill(4), sources, settings, ciphertext,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActivationSettingsSwitchPlan(
    contract, f.prepared.journalKey,
    { ...sources, activationDecisionCiphertext: sources.intentCiphertext },
    settings, ciphertext,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4ActivationSettingsSwitchPlan(
    contract, f.prepared.journalKey, sources, settings, ciphertext.slice(0, -8),
  )).observation, "manual-recovery-required")
})

test("D231 interrupted or torn Settings Switch Plan preserves residue and refuses replay", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  await stageV4FencedCutoverActivationDecision(input)
  const path = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
    + "/settings-switch-plan.json"
  const write = f.s.adapter.write
  f.s.adapter.write = async (target, serialized) => {
    if (target === path) {
      f.s.files.set(path, serialized.slice(0, 18))
      throw Error("injected interrupted Settings Plan write")
    }
    return write(target, serialized)
  }
  const secretsBefore = new Map(f.s.secrets)
  await assert.rejects(stageV4FencedActivationSettingsSwitchPlan(input),
    /injected interrupted Settings Plan write/)
  assert.ok(f.s.files.has(path), "partial ciphertext evidence persists")
  assert.equal((await inspectV4FencedActivationSettingsSwitchPlanAfterRestart(input))
    .observation, "manual-recovery-required")
  await assert.rejects(stageV4FencedActivationSettingsSwitchPlan(input),
    /existing Settings Switch Plan requires Manual Recovery/)
  assert.deepEqual(f.s.secrets, secretsBefore)
  assert.equal(f.s.holderCounts().held, false)
})

test("D231 post-write Git ref drift or persisted Source Settings drift denies a successful Settings Plan", async () => {
  for (const failure of ["backup", "destination", "settings"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const settings = { ...f.prepared.restart.settings }
    const input = {
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
      readPersistedSettings: async () => ({ ...settings }),
    }
    await stageV4FencedCutoverActivationDecision(input)
    const path = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
      + "/settings-switch-plan.json"
    const write = f.s.adapter.write
    f.s.adapter.write = async (target, serialized) => {
      await write(target, serialized)
      if (target === path) {
        if (failure === "backup") b.setRef("9".repeat(40))
        else if (failure === "destination") f.s.f.changeRef("9".repeat(40))
        else settings.githubBranch = "unknown-destination"
      }
    }
    await assert.rejects(stageV4FencedActivationSettingsSwitchPlan(input))
    assert.ok(f.s.files.has(path), failure + " residue must be preserved")
    const recovered = await inspectV4FencedActivationSettingsSwitchPlanAfterRestart(input)
    assert.equal(recovered.observation, "manual-recovery-required", failure)
    assert.equal(recovered.resumeSyncAuthorized, false, failure)
    assert.equal(f.s.holderCounts().held, false, failure)
  }
})

test("D230 one owner lease stores encrypted decision only after two fresh full Git and local proofs", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const saved = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const filesBefore = new Map(f.s.files)
  const secretsBefore = new Map(f.s.secrets)
  const writesBefore = f.s.getWrites()
  const holdersBefore = f.s.holderCounts().calls
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  const staged = await stageV4FencedCutoverActivationDecision(input)
  assert.equal(staged.status, "cutover-activation-decision-staged-not-applied")
  assert.equal(staged.commitDecisionAuthorized, false)
  assert.equal(staged.localCutoverAuthorized, false)
  assert.equal(staged.resumeSyncAuthorized, false)
  assert.equal(f.s.holderCounts().calls, holdersBefore + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.getWrites() > writesBefore)
  const ciphertext = f.s.files.get(staged.decisionPath)
  assert.ok(ciphertext)
  assert.ok(!ciphertext.includes("cutover-decision-recorded"), "decision is encrypted")
  for (const [path, data] of filesBefore) assert.equal(f.s.files.get(path), data, path)
  assert.equal(f.s.files.size, filesBefore.size + 1, "only isolated decision was written")
  assert.deepEqual(f.s.secrets, secretsBefore)
  assert.equal(f.s.files.get(saved.intentPath), filesBefore.get(saved.intentPath))
  const recovered = await inspectV4FencedCutoverActivationDecisionAfterRestart(input)
  assert.deepEqual(recovered, {
    integrityScope: "read-only-cutover-activation-decision-after-restart",
    observation: "authenticated-decision-activation-pending",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, commitDecisionAuthorized: false,
    resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(f.s.secrets, secretsBefore)
  await assert.rejects(stageV4FencedCutoverActivationDecision(input),
    /prior decision requires Manual Recovery/)
})

test("D230 distinct decision ciphertext authenticates manifest and Intent but is not itself Cutover authority", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const saved = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  const staged = await stageV4FencedCutoverActivationDecision(input)
  const root = staged.decisionPath.slice(0, -"/activation-decision.json".length)
  const sources = {
    manifest: f.s.files.get(root + "/contract.json")!,
    receiptCiphertext: f.s.files.get(root + "/receipt.json")!,
    selectorCiphertext: f.s.files.get(root + "/selector.json")!,
    intentCiphertext: f.s.files.get(saved.intentPath)!,
  }
  const contract = decodeV4ReencryptionCutoverCandidateManifest(sources.manifest)
  const ciphertext = f.s.files.get(staged.decisionPath)!
  assert.equal((await inspectV4CutoverActivationDecision(
    contract, f.prepared.journalKey, sources, ciphertext,
  )).observation, "authenticated-decision-activation-pending")
  assert.equal((await inspectV4CutoverActivationDecision(
    contract, new Uint8Array(32).fill(7), sources, ciphertext,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4CutoverActivationDecision(
    contract, f.prepared.journalKey, { ...sources, intentCiphertext: sources.receiptCiphertext }, ciphertext,
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4CutoverActivationDecision(
    contract, f.prepared.journalKey, sources, ciphertext.slice(0, -8),
  )).observation, "manual-recovery-required")
  assert.equal((await inspectV4CutoverActivationDecision(
    contract, f.prepared.journalKey, sources, null,
  )).observation, "manual-recovery-required")
})

test("D230 restart detects altered persisted decision, historical Intent, Settings and remote Backup/Destination", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const saved = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const settings = { ...f.prepared.restart.settings }
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...settings }),
  }
  const staged = await stageV4FencedCutoverActivationDecision(input)
  const bytes = f.s.files.get(staged.decisionPath)!
  const intent = f.s.files.get(saved.intentPath)!
  const originalSecret = f.s.secrets.get(f.id.sourcePassphraseSecretId)!
  const writes = f.s.getWrites()
  const check = async (name: string) => {
    const result = await inspectV4FencedCutoverActivationDecisionAfterRestart(input)
    assert.equal(result.observation, "manual-recovery-required", name)
    assert.equal(result.resumeSyncAuthorized, false, name)
    assert.equal(result.commitDecisionAuthorized, false, name)
    assert.equal(f.s.getWrites(), writes, name)
  }
  f.s.files.set(staged.decisionPath, bytes.slice(0, -8))
  await check("torn decision")
  f.s.files.set(staged.decisionPath, bytes)
  f.s.files.set(saved.intentPath, intent + " ")
  await check("foreign Intent")
  f.s.files.set(saved.intentPath, intent)
  settings.githubBranch = "rekey/d83"
  await check("changed persisted settings")
  settings.githubBranch = f.prepared.restart.settings.githubBranch
  b.setRef("9".repeat(40))
  await check("moved Backup HEAD")
  b.setRef(f.id.sourceCommitSha)
  f.s.f.changeRef("9".repeat(40))
  await check("moved Destination HEAD")
  f.s.f.changeRef(f.id.destinationCommitSha)
  f.s.secrets.delete(f.id.sourcePassphraseSecretId)
  await check("old secret removed")
  f.s.secrets.set(f.id.sourcePassphraseSecretId, originalSecret)
  f.s.files.set(staged.decisionPath, bytes)
  assert.equal(
    (await inspectV4FencedCutoverActivationDecisionAfterRestart(input)).observation,
    "authenticated-decision-activation-pending",
  )
})

test("D230 ambiguous decision write leaves residue, never retries over it and never resumes Sync", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  const path = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
    + "/activation-decision.json"
  const write = f.s.adapter.write
  let interrupted = false
  f.s.adapter.write = async (target, data) => {
    if (target === path && !interrupted) {
      interrupted = true
      f.s.files.set(target, data.slice(0, 17))
      throw Error("injected local partial write")
    }
    return write(target, data)
  }
  await assert.rejects(stageV4FencedCutoverActivationDecision(input),
    /injected local partial write/)
  assert.equal(interrupted, true)
  assert.ok(f.s.files.has(path))
  const recovered = await inspectV4FencedCutoverActivationDecisionAfterRestart(input)
  assert.equal(recovered.observation, "manual-recovery-required")
  assert.equal(recovered.localCutoverAuthorized, false)
  assert.equal(recovered.resumeSyncAuthorized, false)
  await assert.rejects(stageV4FencedCutoverActivationDecision(input),
    /prior decision requires Manual Recovery/)
})

test("D230 remote Backup drift AFTER writing decision keeps authenticated residue without success", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const input = {
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
  }
  const path = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
    + "/activation-decision.json"
  const write = f.s.adapter.write
  f.s.adapter.write = async (target, data) => {
    await write(target, data)
    if (target === path) b.setRef("9".repeat(40))
  }
  await assert.rejects(stageV4FencedCutoverActivationDecision(input),
    /complete fresh Git and persisted local proof failed/)
  assert.ok(f.s.files.has(path), "committed decision evidence must not be silently discarded")
  assert.equal(
    (await inspectV4FencedCutoverActivationDecisionAfterRestart(input)).observation,
    "manual-recovery-required",
  )
})

test("D230 forged owner holder or changed persisted Settings reader cannot certify staged activation", async () => {
  for (const failure of ["nonexecuting-holder", "post-holder-settings-reader"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const input = {
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
      readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
    }
    const originalHolder = f.prepared.withExclusiveInitiatorLease
    const replaced = failure === "nonexecuting-holder"
      ? async <T>(_body: () => Promise<T>): Promise<T> => Object.freeze({}) as T
      : async <T>(body: () => Promise<T>): Promise<T> => originalHolder(async () => {
        const result = await body()
        input.readPersistedSettings = async () => ({
          ...f.prepared.restart.settings, githubBranch: "rekey/d83",
        })
        return result
      })
    Object.assign(f.prepared, { withExclusiveInitiatorLease: replaced })
    Object.assign(f.input.full.branches, { withExclusiveInitiatorLease: replaced })
    Object.assign(b.backup, { withExclusiveInitiatorLease: replaced })
    const path = f.id.indexRoot + "-rekey-cutover-candidate-" + f.id.runId
      + "/activation-decision.json"
    const writesBefore = f.s.getWrites()
    await assert.rejects(stageV4FencedCutoverActivationDecision(input),
      /cannot certify a decision/)
    if (failure === "nonexecuting-holder") {
      assert.equal(f.s.files.has(path), false)
      assert.equal(f.s.getWrites(), writesBefore)
    } else {
      assert.equal(f.s.files.has(path), true, "ambiguous post-holder write is preserved")
      assert.equal(
        (await inspectV4FencedCutoverActivationDecisionAfterRestart(input)).observation,
        "manual-recovery-required",
      )
    }
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D229 commit preflight independently verifies current full old Backup, new Destination and persisted local Intent in one lease", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const files = new Map(f.s.files)
  const secrets = new Map(f.s.secrets)
  const beforeWrites = f.s.getWrites()
  const beforeHolders = f.s.holderCounts().calls
  let settingsReads = 0
  const settings = { ...f.prepared.restart.settings }
  const report = await inspectV4FencedPendingCommitPreflightAfterRestart({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    readPersistedSettings: async () => {
      settingsReads++
      return { ...settings }
    },
  })
  assert.deepEqual(report, {
    integrityScope: "fenced-live-full-git-and-persisted-local-pending-intent",
    observation: "full-live-commit-preflight-uncommitted",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    oldBackupContentReverified: true, newDestinationContentReverified: true,
    localCutoverAuthorized: false, commitDecisionAuthorized: false,
    resumeSyncAuthorized: false, rollbackAuthorized: false,
    remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.ok(b.blobReads >= 16, "full old-key Backup ciphertext scanned more than once")
  assert.ok(f.s.f.reads >= 16, "full new-key Destination ciphertext scanned more than once")
  assert.ok(settingsReads >= 4, "persisted Settings independently read before and after live proofs")
  assert.equal(f.s.holderCounts().calls, beforeHolders + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.getWrites(), beforeWrites)
  assert.deepEqual(f.s.files, files)
  assert.deepEqual(f.s.secrets, secrets)
})

test("D229 stale local Intent, changed transaction, missing key or changed current Backup/Destination rejects preflight", async () => {
  for (const failure of [
    "old-head", "new-head", "missing-old", "wrong-transaction",
    "missing-intent", "changed-settings", "lost-wal",
  ] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    const staged = await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const settings = { ...f.prepared.restart.settings }
    if (failure === "old-head") b.setRef("9".repeat(40))
    if (failure === "new-head") f.s.f.changeRef("9".repeat(40))
    if (failure === "missing-old") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    if (failure === "missing-intent") f.s.files.delete(staged.intentPath)
    if (failure === "changed-settings") settings.githubBranch = "rekey/d83"
    if (failure === "lost-wal") f.s.setWal({ ...f.s.getWal(), generation: 999 })
    const writesBefore = f.s.getWrites()
    const report = await inspectV4FencedPendingCommitPreflightAfterRestart({
      readiness: f.input, backup: b.backup,
      transactionId: failure === "wrong-transaction" ? "ab".repeat(16) : d183TransactionId,
      readPersistedSettings: async () => ({ ...settings }),
    })
    assert.equal(report.observation, "manual-recovery-required", failure)
    assert.equal(report.oldBackupContentReverified, false, failure)
    assert.equal(report.newDestinationContentReverified, false, failure)
    assert.equal(report.commitDecisionAuthorized, false, failure)
    assert.equal(report.resumeSyncAuthorized, false, failure)
    assert.equal(f.s.getWrites(), writesBefore, failure)
    assert.equal(f.s.holderCounts().held, false, failure)
  }
})

test("D229 remote refs drifting during or after live Git content scans deny apparently fresh local Intent", async () => {
  for (const moved of ["backup", "destination"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    if (moved === "backup") {
      const original = f.s.f.github.getBlob
      let scans = 0
      f.s.f.github.getBlob = async sha => {
        const bytes = await original(sha)
        if (++scans === 1) b.setRef("9".repeat(40))
        return bytes
      }
    } else {
      const original = b.github.getBlob
      let scans = 0
      b.github.getBlob = async sha => {
        const bytes = await original(sha)
        if (++scans === 1) f.s.f.changeRef("9".repeat(40))
        return bytes
      }
    }
    const writesBefore = f.s.getWrites()
    const report = await inspectV4FencedPendingCommitPreflightAfterRestart({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
      readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
    })
    assert.equal(report.observation, "manual-recovery-required", moved)
    assert.equal(report.commitDecisionAuthorized, false, moved)
    assert.equal(report.resumeSyncAuthorized, false, moved)
    assert.equal(f.s.getWrites(), writesBefore, moved)
    assert.equal(f.s.holderCounts().held, false, moved)
  }
})

test("D229 forged nonexecuting holder and post-holder callback replacement never authorize a Commit", async () => {
  for (const failure of ["fake-holder", "changed-reader"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const input = {
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
      readPersistedSettings: async () => ({ ...f.prepared.restart.settings }),
    }
    if (failure === "fake-holder") {
      f.prepared.withExclusiveInitiatorLease = async <T>(_body: () => Promise<T>): Promise<T> =>
        Object.freeze({}) as T
    } else {
      const originalHolder = f.prepared.withExclusiveInitiatorLease
      f.prepared.withExclusiveInitiatorLease = async <T>(body: () => Promise<T>): Promise<T> =>
        originalHolder(async () => {
          const value = await body()
          input.readPersistedSettings = async () => null as never
          return value
        })
    }
    const report = await inspectV4FencedPendingCommitPreflightAfterRestart(input)
    assert.equal(report.observation, "manual-recovery-required", failure)
    assert.equal(report.commitDecisionAuthorized, false, failure)
    assert.equal(report.resumeSyncAuthorized, false, failure)
  }
})

test("D228 persisted Settings, Source/Shadow Index, Prepared and WAL match all six authenticated Intent digests", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const result = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const files = new Map(f.s.files)
  const secrets = new Map(f.s.secrets)
  const writesBefore = f.s.getWrites()
  const holdersBefore = f.s.holderCounts().calls
  const persistedSettings = { ...f.prepared.restart.settings }
  let settingsReads = 0
  const recovered = await inspectV4FencedPendingCutoverSurfacesAfterRestart({
    prepared: f.prepared,
    readPersistedSettings: async () => {
      settingsReads++
      return { ...persistedSettings }
    },
  })
  assert.deepEqual(recovered, {
    integrityScope: "read-only-fenced-pending-intent-cross-surface-restart",
    observation: "source-and-destination-snapshots-match-pending-intent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.ok(settingsReads >= 2)
  assert.equal(f.s.holderCounts().calls, holdersBefore + 1, "all independent restart reads share one held owner lease")
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.getWrites(), writesBefore, "Restart is read-only")
  assert.equal(f.s.files.get(result.intentPath), files.get(result.intentPath))
  assert.deepEqual(f.s.files, files)
  assert.deepEqual(f.s.secrets, secrets)
})

test("D228 interrupted local Settings/Index/Prepared/WAL or unauthorized active Selector requires Manual Recovery", async () => {
  for (const failure of [
    "settings-branch", "settings-secret", "settings-unreadable",
    "active-index", "shadow-index", "prepared-evidence",
    "wal-drift", "missing-old-secret", "live-selector-residue",
    "missing-intent",
  ] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    const result = await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const settings = { ...f.prepared.restart.settings }
    if (failure === "settings-branch") settings.githubBranch = "rekey/d83"
    if (failure === "settings-secret") settings.encryptionPassphraseSecretId = f.id.destinationPassphraseSecretId
    if (failure === "active-index" || failure === "shadow-index") {
      const root = failure === "active-index" ? V4_RUNTIME_INDEX_ROOT
        : V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId
      const path = root + "/index.json"
      f.s.files.set(path, f.s.files.get(path)!.replace(
        failure === "active-index" ? f.id.sourceCommitSha : f.id.destinationCommitSha,
        "9".repeat(40),
      ))
    }
    if (failure === "prepared-evidence") {
      const path = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/prepared.json"
      f.s.files.set(path, f.s.files.get(path)! + " ")
    }
    if (failure === "wal-drift") f.s.setWal({ ...f.s.getWal(), generation: 999 })
    if (failure === "missing-old-secret") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    if (failure === "live-selector-residue") {
      f.s.files.set(V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json", "{}")
    }
    if (failure === "missing-intent") f.s.files.delete(result.intentPath)
    const writesBefore = f.s.getWrites()
    const recovery = await inspectV4FencedPendingCutoverSurfacesAfterRestart({
      prepared: f.prepared,
      readPersistedSettings: async () => failure === "settings-unreadable" ? null : { ...settings },
    })
    assert.equal(recovery.observation, "manual-recovery-required", failure)
    assert.equal(recovery.resumeSyncAuthorized, false, failure)
    assert.equal(recovery.localCutoverAuthorized, false, failure)
    assert.equal(recovery.oldPassphraseCleanupAuthorized, false, failure)
    assert.equal(f.s.getWrites(), writesBefore, failure)
    assert.equal(f.s.holderCounts().held, false, failure)
  }
})

test("D228 persisted Settings changed during authenticated Intent restart cannot report a coherent Source", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const persisted = { ...f.prepared.restart.settings }
  let reads = 0
  const recovery = await inspectV4FencedPendingCutoverSurfacesAfterRestart({
    prepared: f.prepared,
    readPersistedSettings: async () => {
      if (++reads === 2) persisted.githubBranch = "rekey/d83"
      return { ...persisted }
    },
  })
  assert.ok(reads >= 2)
  assert.equal(recovery.observation, "manual-recovery-required")
  assert.equal(recovery.resumeSyncAuthorized, false)
})

test("D228 a fake holder, changed read callback or unknown active commit cannot create cutover authority", async () => {
  for (const failure of ["holder", "reader", "proposed-root"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    const settings = { ...f.prepared.restart.settings }
    const input = {
      prepared: f.prepared,
      readPersistedSettings: async () => ({ ...settings }),
    }
    if (failure === "proposed-root") {
      const proposedRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
      await f.s.adapter.mkdir(proposedRoot)
      f.s.files.set(proposedRoot + "/marker.json", "foreign")
    }
    if (failure === "holder") {
      f.prepared.withExclusiveInitiatorLease = async <T>(_work: () => Promise<T>): Promise<T> =>
        Object.freeze({}) as T
    }
    if (failure === "reader") {
      const originalHolder = f.prepared.withExclusiveInitiatorLease
      f.prepared.withExclusiveInitiatorLease = async <T>(work: () => Promise<T>): Promise<T> =>
        originalHolder(async () => {
          const reported = await work()
          input.readPersistedSettings = async () => ({ ...settings, githubBranch: "rekey/d83" })
          return reported
        })
    }
    const report = await inspectV4FencedPendingCutoverSurfacesAfterRestart(input)
    assert.equal(report.observation, "manual-recovery-required", failure)
    assert.equal(report.localCutoverAuthorized, false, failure)
  }
})

test("D227 one held lease writes authenticated Intent after current old/new Git proof without selecting a live branch", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const originalFiles = new Map(f.s.files)
  const originalSecrets = new Map(f.s.secrets)
  const originalWal = JSON.stringify(f.s.getWal())
  const beforeHolders = f.s.holderCounts().calls
  const beforeWrites = f.s.getWrites()
  const result = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  assert.equal(result.status, "production-namespace-intent-staged-uncommitted")
  assert.equal(result.intentPath, root + "/intent.json")
  assert.equal(result.provenance, "two-full-current-destination-and-frozen-backup-proofs-bracketing-write")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.holderCounts().calls, beforeHolders + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.equal(f.s.getWrites(), beforeWrites + 4)
  assert.ok(b.blobReads >= 16)
  assert.ok(f.s.f.reads >= 16)
  const contract = decodeV4ReencryptionCutoverCandidateManifest(f.s.files.get(result.manifestPath)!)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, f.prepared.journalKey, {
      receiptCiphertext: f.s.files.get(result.receiptPath)!,
      selectorCiphertext: f.s.files.get(result.selectorPath)!,
    }, f.s.files.get(result.intentPath)!,
  ), {
    integrityScope: "production-namespace-cutover-intent-crypto-only",
    observation: "authenticated-intent-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  const restarted = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
  assert.equal(restarted.observation, "authenticated-intent-uncommitted")
  assert.equal(restarted.localCutoverAuthorized, false)
  assert.equal(restarted.resumeSyncAuthorized, false)
  assert.equal(restarted.oldPassphraseCleanupAuthorized, false)
  for (const [path, value] of originalFiles) assert.equal(f.s.files.get(path), value, path)
  assert.deepEqual(f.s.secrets, originalSecrets)
  assert.equal(JSON.stringify(f.s.getWal()), originalWal)
})

test("D227 interrupted last intent write is detectable after Restart and remains non-authorizing", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  const original = f.s.adapter.write
  let interrupted = false
  f.s.adapter.write = async (path, value) => {
    await original(path, value)
    if (path === root + "/intent.json") {
      interrupted = true
      throw Error("simulated acknowledgement lost after intent disk write")
    }
  }
  await assert.rejects(() => stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  }), /acknowledgement lost/)
  assert.equal(interrupted, true)
  for (const name of ["contract.json", "receipt.json", "selector.json", "intent.json"]) {
    assert.ok(f.s.files.has(root + "/" + name), name)
  }
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
  const restarted = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
  assert.equal(restarted.observation, "authenticated-intent-uncommitted")
  assert.equal(restarted.localCutoverAuthorized, false)
  assert.equal(restarted.resumeSyncAuthorized, false)
})

test("D227 tampering, incomplete artifacts, WAL loss or one-sided foreign intent on Restart fail closed", async () => {
  for (const failure of ["missing-intent", "torn-intent", "swap-candidate", "wal-drift", "missing-old-secret"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    const result = await stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    })
    if (failure === "missing-intent") f.s.files.delete(result.intentPath)
    if (failure === "torn-intent") f.s.files.set(result.intentPath, f.s.files.get(result.intentPath)!.slice(0, -8))
    if (failure === "swap-candidate") f.s.files.set(result.receiptPath, f.s.files.get(result.receiptPath)!.slice(0, -8))
    if (failure === "wal-drift") f.s.setWal({ ...f.s.getWal(), generation: 999 })
    if (failure === "missing-old-secret") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    const after = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
    assert.equal(after.observation, "manual-recovery-required", failure)
    assert.equal(after.localCutoverAuthorized, false, failure)
    assert.equal(after.resumeSyncAuthorized, false, failure)
    assert.equal(after.oldPassphraseCleanupAuthorized, false, failure)
  }
})

test("D227 Git Backup or Destination drift after writing Intent retains encrypted residue but refuses success", async () => {
  for (const changed of ["backup", "destination"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
    const original = f.s.adapter.write
    let reached = false
    f.s.adapter.write = async (path, data) => {
      await original(path, data)
      if (path === root + "/intent.json") {
        reached = true
        if (changed === "backup") b.setRef("9".repeat(40))
        else f.s.f.changeRef("9".repeat(40))
      }
    }
    await assert.rejects(() => stageV4FencedLiveReencryptionIntent({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    }), /Backup|Git|proof|commit|changed|ref|shadow/i, changed)
    assert.equal(reached, true, changed)
    assert.ok(f.s.files.has(root + "/intent.json"), changed)
    assert.equal(f.s.holderCounts().held, false, changed)
    const after = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
    assert.equal(after.localCutoverAuthorized, false, changed)
    assert.equal(after.resumeSyncAuthorized, false, changed)
  }
})

test("D227 Restart refuses intent changed immediately after its second authenticated read", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const result = await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  const original = f.s.adapter.read
  let intentReads = 0
  f.s.adapter.read = async path => {
    const value = await original(path)
    if (path === result.intentPath && ++intentReads === 2) {
      f.s.files.set(path, value.slice(0, -8))
    }
    return value
  }
  const report = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
  assert.equal(intentReads, 3)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
})

test("D227 Restart requires a genuinely executed exclusive owner holder", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  await stageV4FencedLiveReencryptionIntent({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  f.prepared.withExclusiveInitiatorLease = async <T>(_body: () => Promise<T>): Promise<T> =>
    Object.freeze({}) as T
  const report = await inspectV4ReencryptionPendingCutoverIntentAfterRestart(f.prepared)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.localCutoverAuthorized, false)
})

test("D224 one real owner lease derives exact candidate from fresh old-key Backup and new-key Destination Git content", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const files = new Map(f.s.files)
  const oldSecrets = new Map(f.s.secrets)
  const wal = JSON.stringify(f.s.getWal())
  const holders = f.s.holderCounts().calls
  const writes = f.s.getWrites()
  const result = await stageV4FencedLiveReencryptionCandidate({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  })
  assert.equal(result.status, "production-namespace-pair-staged-uncommitted")
  assert.equal(result.provenance,
    "two-full-current-destination-and-frozen-backup-proofs-bracketing-write")
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.holderCounts().calls, holders + 1, "one outer lock for ALL Git+disk phases")
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(b.blobReads >= 16, "two D216 runs with two full Backup passes each")
  assert.ok(f.s.f.reads >= 16, "two D183 runs, each with full new-key Git verification")
  const recorded = decodeV4ReencryptionCutoverCandidateManifest(f.s.files.get(result.manifestPath)!)
  assert.equal(recorded.transactionId, d183TransactionId)
  assert.equal(recorded.identity.backupRepoId, f.id.backupRepoId)
  assert.equal((await inspectV4ReencryptionCutoverCandidateAfterRestart(f.prepared))
    .observation, "authenticated-candidate-uncommitted")
  assert.equal(f.s.getWrites(), writes + 3)
  for (const [path, value] of files) assert.equal(f.s.files.get(path), value, path)
  assert.deepEqual(f.s.secrets, oldSecrets)
  assert.equal(JSON.stringify(f.s.getWal()), wal)
})

test("D224 live frozen Backup already drifted prevents any Cutover candidate write", async () => {
  for (const cause of ["backup-ref", "backup-ciphertext", "missing-old-key"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    if (cause === "backup-ref") b.setRef("9".repeat(40))
    else if (cause === "backup-ciphertext") b.corruptAfterFirstPass()
    else f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    const before = new Map(f.s.files)
    const writes = f.s.getWrites()
    await assert.rejects(() => stageV4FencedLiveReencryptionCandidate({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    }), /Backup|identity|passphrase|keys|proof|snapshot/i, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.deepEqual(f.s.files, before, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D224 full Git Backup/Destination or WAL drift AFTER candidate writing retains uncommitted bytes", async () => {
  for (const cause of ["late-backup-ref", "late-destination-ref", "late-wal"] as const) {
    const f = await d179Scenario()
    const b = await d217CurrentFrozenBackup(f)
    const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
    const originalWrite = f.s.adapter.write
    let reached = false
    f.s.adapter.write = async (path, value) => {
      await originalWrite(path, value)
      if (path === root + "/selector.json") {
        reached = true
        if (cause === "late-backup-ref") b.setRef("9".repeat(40))
        else if (cause === "late-destination-ref") f.s.f.changeRef("9".repeat(40))
        else f.s.setWal({ ...f.s.getWal(), generation: 999 })
      }
    }
    await assert.rejects(() => stageV4FencedLiveReencryptionCandidate({
      readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
    }), /Backup|WAL|Git|identity|proof|checkpoint|candidate|changed/i, cause)
    assert.equal(reached, true, cause)
    assert.equal(f.s.files.has(root + "/contract.json"), true, cause)
    assert.equal(f.s.files.has(root + "/receipt.json"), true, cause)
    assert.equal(f.s.files.has(root + "/selector.json"), true, cause)
    assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"), cause)
    assert.equal(f.s.holderCounts().held, false, cause)
    // The triple on disk is still only CANDIDATE bytes, never a Cutover.
    const observed = await inspectV4ReencryptionCutoverCandidateAfterRestart(f.prepared)
    assert.equal(observed.localCutoverAuthorized, false, cause)
    assert.equal(observed.resumeSyncAuthorized, false, cause)
    assert.equal(observed.oldPassphraseCleanupAuthorized, false, cause)
  }
})

test("D224 cancellation just after held full-Git proof rejects the completed candidate", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const controller = new AbortController()
  Object.assign(f.input.full.shadow.remote, { signal: controller.signal })
  const originalHolder = f.prepared.withExclusiveInitiatorLease
  const changedHolder = async <T>(body: () => Promise<T>): Promise<T> =>
    originalHolder(async () => {
      const value = await body()
      controller.abort()
      return value
    })
  f.prepared.withExclusiveInitiatorLease = changedHolder
  f.input.full.branches.withExclusiveInitiatorLease = changedHolder
  b.backup.withExclusiveInitiatorLease = changedHolder
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  await assert.rejects(() => stageV4FencedLiveReencryptionCandidate({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  }), /identity drift|changed|methods|scope|SecretStorage/i)
  assert.equal(controller.signal.aborted, true)
  assert.equal(f.s.files.has(root + "/selector.json"), true)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
  assert.equal(f.s.holderCounts().held, false)
})

test("D224 post-holder Git method substitution invalidates a completed candidate proof", async () => {
  const f = await d179Scenario()
  const b = await d217CurrentFrozenBackup(f)
  const originalHolder = f.prepared.withExclusiveInitiatorLease
  const changedHolder = async <T>(work: () => Promise<T>): Promise<T> =>
    originalHolder(async () => {
      const result = await work()
      b.github.getGitRef = async () => ({
        ref: "refs/heads/" + b.github.branchName,
        type: "commit" as const, sha: "9".repeat(40),
      })
      return result
    })
  f.prepared.withExclusiveInitiatorLease = changedHolder
  f.input.full.branches.withExclusiveInitiatorLease = changedHolder
  b.backup.withExclusiveInitiatorLease = changedHolder
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  await assert.rejects(() => stageV4FencedLiveReencryptionCandidate({
    readiness: f.input, backup: b.backup, transactionId: d183TransactionId,
  }), /drift|changed|method|Git/i)
  assert.equal(f.s.files.has(root + "/selector.json"), true)
  assert.equal(f.s.holderCounts().held, false)
})

test("D223 production-namespace candidate stages real AES-GCM Receipt/Selector under one held WAL+Fence lease", async () => {
  const f = await d179Scenario()
  const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.equal(derived.observation, "snapshot-contract-derived-uncommitted")
  assert.ok(derived.contract)
  const filesBefore = new Map(f.s.files)
  const secretsBefore = new Map(f.s.secrets)
  const walBefore = JSON.stringify(f.s.getWal())
  const writesBefore = f.s.getWrites()
  const holdersBefore = f.s.holderCounts().calls
  const report = await stageV4ReencryptionCutoverCandidate({
    prepared: f.prepared, contract: derived.contract!,
  })
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  assert.deepEqual(report, {
    status: "production-namespace-pair-staged-uncommitted",
    manifestPath: root + "/contract.json",
    receiptPath: root + "/receipt.json",
    selectorPath: root + "/selector.json",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(f.s.holderCounts().calls, holdersBefore + 1)
  assert.equal(f.s.holderCounts().held, false)
  const persistedManifest = f.s.files.get(report.manifestPath)!
  const recoveredContract = decodeV4ReencryptionCutoverCandidateManifest(persistedManifest)
  assert.deepEqual(recoveredContract, derived.contract)
  assert.doesNotMatch(persistedManifest, /old-d138-secret|new-d83-secret/)
  const auth = await inspectV4ReencryptionCutoverCandidatePair(
    recoveredContract, f.prepared.journalKey, {
      receiptCiphertext: f.s.files.get(report.receiptPath)!,
      selectorCiphertext: f.s.files.get(report.selectorPath)!,
    },
  )
  assert.equal(auth.observation, "cryptographically-linked-candidate-uncommitted")
  assert.equal(auth.localCutoverAuthorized, false)
  assert.equal(auth.resumeSyncAuthorized, false)
  assert.deepEqual(f.s.secrets, secretsBefore)
  assert.equal(JSON.stringify(f.s.getWal()), walBefore)
  for (const [path, value] of filesBefore) assert.equal(f.s.files.get(path), value)
  assert.equal(f.s.getWrites(), writesBefore + 3)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
  const writes = f.s.getWrites()
  await assert.rejects(() => stageV4ReencryptionCutoverCandidate({
    prepared: f.prepared, contract: derived.contract!,
  }), /existing|residue|Manual Recovery/i)
  assert.equal(f.s.getWrites(), writes, "never overwrite even a fully linked candidate")
})

test("D223 interrupted candidate directory, manifest, Receipt or Selector preserves all partial evidence", async () => {
  for (const phase of ["directory", "manifest", "receipt", "selector"] as const) {
    const f = await d179Scenario()
    const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
    assert.ok(derived.contract)
    const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
    const expected = phase === "directory" ? null
      : phase === "manifest" ? "contract.json"
      : phase === "receipt" ? "receipt.json" : "selector.json"
    const oldWrite = f.s.adapter.write
    const oldMkdir = f.s.adapter.mkdir
    if (phase === "directory") {
      f.s.adapter.mkdir = async path => {
        await oldMkdir(path)
        if (path === root) throw Error("simulated-crash-" + phase)
      }
    } else {
      f.s.adapter.write = async (path, value) => {
        await oldWrite(path, value)
        if (path === root + "/" + expected) throw Error("simulated-crash-" + phase)
      }
    }
    const oldFiles = new Map(f.s.files)
    await assert.rejects(() => stageV4ReencryptionCutoverCandidate({
      prepared: f.prepared, contract: derived.contract!,
    }), /simulated-crash-/)
    assert.equal(f.s.holderCounts().held, false, phase)
    assert.equal(f.s.dirs.has(root), true, phase)
    assert.equal(f.s.files.has(root + "/contract.json"), phase !== "directory", phase)
    assert.equal(f.s.files.has(root + "/receipt.json"),
      phase === "receipt" || phase === "selector", phase)
    assert.equal(f.s.files.has(root + "/selector.json"), phase === "selector", phase)
    for (const [path, value] of oldFiles) assert.equal(f.s.files.get(path), value, phase)
    assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
    f.s.adapter.write = oldWrite
    f.s.adapter.mkdir = oldMkdir
    const before = f.s.getWrites()
    await assert.rejects(() => stageV4ReencryptionCutoverCandidate({
      prepared: f.prepared, contract: derived.contract!,
    }), /existing|residue|Manual Recovery/i, phase)
    assert.equal(f.s.getWrites(), before, phase)
  }
})

test("D223 restart reconstructs production-namespace candidate from disk with NO caller historical contract", async () => {
  const f = await d179Scenario()
  const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.ok(derived.contract)
  await stageV4ReencryptionCutoverCandidate({
    prepared: f.prepared, contract: derived.contract!,
  })
  const files = new Map(f.s.files)
  const writes = f.s.getWrites()
  const holders = f.s.holderCounts().calls
  const recreated = {
    ...f.prepared,
    identity: { ...f.prepared.identity },
    journalKey: Uint8Array.from(f.prepared.journalKey),
    restart: { ...f.prepared.restart, settings: { ...f.prepared.restart.settings } },
  }
  const observed = await inspectV4ReencryptionCutoverCandidateAfterRestart(recreated)
  assert.deepEqual(observed, {
    integrityScope: "read-only-production-namespace-candidate-restart",
    observation: "authenticated-candidate-uncommitted",
    candidateCryptographicallyLinked: true,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(f.s.holderCounts().calls, holders + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.deepEqual(f.s.files, files)
  assert.equal(f.s.getWrites(), writes)
})

test("D223 post-Restart never authenticates incomplete, foreign or corrupted candidate artifacts", async () => {
  for (const cause of ["missing-manifest", "torn-manifest", "foreign-transaction",
    "extra-manifest-field", "missing-receipt", "corrupt-receipt",
    "missing-selector", "corrupt-selector", "wal", "fence", "old-secret", "new-secret"] as const) {
    const f = await d179Scenario()
    const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
    assert.ok(derived.contract)
    const report = await stageV4ReencryptionCutoverCandidate({
      prepared: f.prepared, contract: derived.contract!,
    })
    if (cause === "missing-manifest") f.s.files.delete(report.manifestPath)
    else if (cause === "torn-manifest") f.s.files.set(report.manifestPath, "{")
    else if (cause === "foreign-transaction") {
      f.s.files.set(report.manifestPath,
        f.s.files.get(report.manifestPath)!.replace(d183TransactionId, "b7".repeat(16)))
    } else if (cause === "extra-manifest-field") {
      f.s.files.set(report.manifestPath,
        f.s.files.get(report.manifestPath)!.replace(',"phase":', ',"authorized":true,"phase":'))
    } else if (cause === "missing-receipt") f.s.files.delete(report.receiptPath)
    else if (cause === "corrupt-receipt") f.s.files.set(report.receiptPath, "!")
    else if (cause === "missing-selector") f.s.files.delete(report.selectorPath)
    else if (cause === "corrupt-selector") f.s.files.set(report.selectorPath, "!")
    else if (cause === "wal") f.s.setWal({ ...f.s.getWal(), generation: 999 })
    else if (cause === "fence") f.s.files.set(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{")
    else if (cause === "old-secret") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    else f.s.secrets.delete(f.id.destinationPassphraseSecretId)
    const before = new Map(f.s.files)
    const writes = f.s.getWrites()
    const observation = await inspectV4ReencryptionCutoverCandidateAfterRestart(f.prepared)
    assert.equal(observation.observation, "manual-recovery-required", cause)
    assert.equal(observation.candidateCryptographicallyLinked, false, cause)
    assert.equal(observation.localCutoverAuthorized, false, cause)
    assert.equal(observation.resumeSyncAuthorized, false, cause)
    assert.equal(observation.oldPassphraseCleanupAuthorized, false, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
    assert.deepEqual(f.s.files, before, cause)
    assert.equal(f.s.getWrites(), writes, cause)
  }
})

test("D223 Restart detects manifest changed immediately after second successful read", async () => {
  const f = await d179Scenario()
  const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.ok(derived.contract)
  const report = await stageV4ReencryptionCutoverCandidate({
    prepared: f.prepared, contract: derived.contract!,
  })
  const original = f.s.adapter.read
  let reads = 0
  f.s.adapter.read = async path => {
    const data = await original(path)
    if (path === report.manifestPath && ++reads === 2) f.s.files.set(path, "{torn-after-read")
    return data
  }
  const writes = f.s.getWrites()
  const observation = await inspectV4ReencryptionCutoverCandidateAfterRestart(f.prepared)
  assert.equal(observation.observation, "manual-recovery-required")
  assert.equal(observation.candidateCryptographicallyLinked, false)
  assert.equal(observation.resumeSyncAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(f.s.holderCounts().held, false)
})

test("D223 losing authenticated WAL after writing Receipt prevents Selector and leaves Sync fenced", async () => {
  const f = await d179Scenario()
  const derived = await deriveV4FencedCommitPairSnapshotTestContract(d183Input(f))
  assert.ok(derived.contract)
  const root = V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + f.id.runId
  const oldWrite = f.s.adapter.write
  f.s.adapter.write = async (path, data) => {
    await oldWrite(path, data)
    if (path === root + "/receipt.json") f.s.setWal({ ...f.s.getWal(), generation: 999 })
  }
  await assert.rejects(() => stageV4ReencryptionCutoverCandidate({
    prepared: f.prepared, contract: derived.contract!,
  }), /WAL|identity|Manual Recovery/i)
  assert.equal(f.s.files.has(root + "/receipt.json"), true)
  assert.equal(f.s.files.has(root + "/selector.json"), false)
  assert.equal(f.s.holderCounts().held, false)
  assert.ok(f.s.files.has(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"))
})

test("D222 genuine D184+D221 disk/Git evidence maps to Manual Recovery without promoting test pair to Commit", async () => {
  const f = await d179Scenario()
  await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const b = await d217CurrentFrozenBackup(f)
  const contractPath = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
  const historicalContract = decodeV4ReencryptionPersistedTestContract(f.s.files.get(contractPath)!)
  const sourceSettings = { ...f.prepared.restart.settings }
  const local = await inspectV4FencedCrashWindowPairAfterRestart({
    prepared: f.prepared, contract: historicalContract, sourceSettings,
  })
  assert.equal(local.artifactWindow, "pair-present")
  assert.equal(local.pairEvidence, "cryptographically-linked-uncommitted")
  const before = f.s.getWrites()
  const complete = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
    prepared: f.prepared, remote: f.input.full, backup: b.backup,
  })
  const triage = classifyV4ReencryptionManualRecovery(local, complete)
  assert.equal(triage.condition, "linked-test-pair-current-git-verified-uncommitted")
  assert.equal(triage.observation, "manual-recovery-required")
  assert.equal(triage.resumeSyncAuthorized, false)
  assert.equal(triage.localCutoverAuthorized, false)
  assert.equal(triage.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.getWrites(), before)
  // The stored historical test pair stays authentic, but the current frozen
  // Backup is now no longer pinned. Classification MUST lose live Git status.
  b.setRef("9".repeat(40))
  const changed = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
    prepared: f.prepared, remote: f.input.full, backup: b.backup,
  })
  const uncertain = classifyV4ReencryptionManualRecovery(local, changed)
  assert.equal(uncertain.condition, "linked-test-pair-current-git-unverified")
  assert.equal(uncertain.resumeSyncAuthorized, false)
  assert.equal(uncertain.localCutoverAuthorized, false)
  assert.equal(f.s.getWrites(), before)
  assert.equal(f.s.holderCounts().held, false)
})

test("D221 persisted historical pair and current encrypted Backup + Destination all verify under ONE holder", async () => {
  const f = await d179Scenario()
  await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const b = await d217CurrentFrozenBackup(f)
  const beforeFiles = new Map(f.s.files)
  const beforeSecrets = new Map(f.s.secrets)
  const beforeWal = JSON.stringify(f.s.getWal())
  const beforeWrites = f.s.getWrites()
  const beforeCalls = f.s.holderCounts().calls
  const result = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
    prepared: f.prepared, remote: f.input.full, backup: b.backup,
  })
  assert.deepEqual(result, {
    integrityScope: "read-only-restarted-test-pair-current-git-and-frozen-backup",
    observation: "manual-recovery-required",
    reason: "test-pair-and-full-remote-coherent-but-not-a-commit",
    historicalTestPairCryptographicallyLinked: true,
    fullDestinationContentReverifiedAfterRestart: true,
    fullBackupContentReverifiedAfterRestart: true,
    liveThreeBranchRefsReverifiedAfterRestart: true,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.ok(b.blobReads >= 8, "two complete D94 old-key Backup scans")
  assert.ok(f.s.f.reads >= 8, "two complete current Destination scans")
  assert.equal(f.s.holderCounts().calls, beforeCalls + 1, "no recursively acquired initiating-device lock")
  assert.equal(f.s.holderCounts().held, false)
  assert.deepEqual(f.s.files, beforeFiles)
  assert.deepEqual(f.s.secrets, beforeSecrets)
  assert.equal(f.s.getWrites(), beforeWrites)
  assert.equal(JSON.stringify(f.s.getWal()), beforeWal)
})

test("D221 current Backup/Destination drift, broken WAL, local artifacts or Secrets fail closed", async () => {
  for (const cause of ["backup-ref", "backup-ciphertext", "destination-ref",
    "wal", "fence", "manifest", "old-secret", "new-secret"] as const) {
    const f = await d179Scenario()
    await stageV4FencedCommitPairTestArtifacts(d183Input(f))
    const b = await d217CurrentFrozenBackup(f)
    const manifest = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
    if (cause === "backup-ref") b.setRef("9".repeat(40))
    else if (cause === "backup-ciphertext") b.corruptAfterFirstPass()
    else if (cause === "destination-ref") f.s.f.changeRef("9".repeat(40))
    else if (cause === "wal") f.s.setWal({ ...f.s.getWal(), generation: 999 })
    else if (cause === "fence") f.s.files.set(
      V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json", "{torn",
    )
    else if (cause === "manifest") f.s.files.set(manifest, "{not-json")
    else if (cause === "old-secret") f.s.secrets.delete(f.id.sourcePassphraseSecretId)
    else f.s.secrets.set(f.id.destinationPassphraseSecretId, "incorrect-new-passphrase")
    const beforeFiles = new Map(f.s.files)
    const beforeWrites = f.s.getWrites()
    const result = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
      prepared: f.prepared, remote: f.input.full, backup: b.backup,
    })
    assert.equal(result.reason, "local-or-current-git-proof-uncertain", cause)
    assert.equal(result.historicalTestPairCryptographicallyLinked, false, cause)
    assert.equal(result.fullDestinationContentReverifiedAfterRestart, false, cause)
    assert.equal(result.fullBackupContentReverifiedAfterRestart, false, cause)
    assert.equal(result.liveThreeBranchRefsReverifiedAfterRestart, false, cause)
    assert.equal(result.localCutoverAuthorized, false, cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(result.oldPassphraseCleanupAuthorized, false, cause)
    assert.deepEqual(f.s.files, beforeFiles, cause)
    assert.equal(f.s.getWrites(), beforeWrites, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D221 a valid independently advanced old Source still permits read-only live proof", async () => {
  const f = await d179Scenario()
  await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const b = await d217CurrentFrozenBackup(f)
  const source = f.input.full.branches.readers.source
  const latest = "9".repeat(40)
  source.getGitRefOrNull = async () => ({
    ref: "refs/heads/main", sha: latest, type: "commit",
  })
  source.getGitCommit = async sha => ({
    sha, treeSha: "8".repeat(40), parentShas: [f.id.sourceCommitSha],
    message: "old-key device independent sync",
  })
  const report = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
    prepared: f.prepared, remote: f.input.full, backup: b.backup,
  })
  assert.equal(report.reason, "test-pair-and-full-remote-coherent-but-not-a-commit")
  assert.equal(report.fullBackupContentReverifiedAfterRestart, true)
  assert.equal(report.fullDestinationContentReverifiedAfterRestart, true)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(f.s.holderCounts().held, false)
})

test("D221 manifest changes during complete old-key Backup ciphertext read cannot certify current proof", async () => {
  const f = await d179Scenario()
  await stageV4FencedCommitPairTestArtifacts(d183Input(f))
  const b = await d217CurrentFrozenBackup(f)
  const manifest = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId + "/contract.json"
  const originalGetBlob = b.github.getBlob
  let mutated = false
  b.github.getBlob = async sha => {
    const bytes = await originalGetBlob(sha)
    if (!mutated) {
      mutated = true
      f.s.files.set(manifest, "{torn-mid-backup")
    }
    return bytes
  }
  const beforeWrites = f.s.getWrites()
  const report = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
    prepared: f.prepared, remote: f.input.full, backup: b.backup,
  })
  assert.equal(mutated, true, "actual D94 Backup Git Blob method must be reached")
  assert.equal(report.reason, "local-or-current-git-proof-uncertain")
  assert.equal(report.historicalTestPairCryptographicallyLinked, false)
  assert.equal(report.fullBackupContentReverifiedAfterRestart, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(f.s.getWrites(), beforeWrites)
})

test("D221 post-holder Backup Git method substitution or forged non-executing holder fails closed", async () => {
  for (const cause of ["post-holder-backup-method", "forged-holder"] as const) {
    const f = await d179Scenario()
    await stageV4FencedCommitPairTestArtifacts(d183Input(f))
    const b = await d217CurrentFrozenBackup(f)
    const originalHolder = f.prepared.withExclusiveInitiatorLease
    const changedHolder = cause === "post-holder-backup-method"
      ? async <T>(callback: () => Promise<T>): Promise<T> =>
        originalHolder(async () => {
          const result = await callback()
          b.github.getGitRef = async () => ({
            ref: "refs/heads/" + b.github.branchName,
            sha: "9".repeat(40), type: "commit",
          })
          return result
        })
      : async <T>(_callback: () => Promise<T>): Promise<T> => ({
        integrityScope: "read-only-restarted-test-pair-current-git-and-frozen-backup",
        observation: "manual-recovery-required",
        reason: "test-pair-and-full-remote-coherent-but-not-a-commit",
        historicalTestPairCryptographicallyLinked: true,
        fullBackupContentReverifiedAfterRestart: true,
        fullDestinationContentReverifiedAfterRestart: true,
        liveThreeBranchRefsReverifiedAfterRestart: true,
      } as T)
    f.prepared.withExclusiveInitiatorLease = changedHolder
    f.input.full.branches.withExclusiveInitiatorLease = changedHolder
    b.backup.withExclusiveInitiatorLease = changedHolder
    const beforeWrites = f.s.getWrites()
    const report = await inspectV4FencedLivePersistedTestPairAndBackupAfterRestart({
      prepared: f.prepared, remote: f.input.full, backup: b.backup,
    })
    assert.equal(report.reason, "local-or-current-git-proof-uncertain", cause)
    assert.equal(report.historicalTestPairCryptographicallyLinked, false, cause)
    assert.equal(report.localCutoverAuthorized, false, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), beforeWrites, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D217 one held lease covers local crash windows, full Destination and two fresh frozen Backup scans", async () => {
  const f = await d179Scenario()
  const { contract } = await d183PreparedPair(f)
  const b = await d217CurrentFrozenBackup(f)
  const files = new Map(f.s.files)
  const writes = f.s.getWrites()
  const calls = f.s.holderCounts().calls
  const input = { ...d185Input(f, contract), backup: b.backup }
  const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart(input)
  assert.equal(result.observation, "source-prepared-and-git-reverified-uncommitted")
  assert.equal(result.fullDestinationContentReverifiedAfterRestart, true)
  assert.equal(result.fullBackupContentReverifiedAfterRestart, true)
  assert.equal(result.liveThreeBranchRefsReverifiedAfterRestart, true)
  assert.equal(result.integrityScope, "read-only-post-crash-local-current-full-git-and-frozen-backup")
  assert.ok(b.blobReads >= 8, "two independent passes through real AES-GCM Backup")
  assert.ok(b.refReads >= 4)
  assert.equal(f.s.holderCounts().calls, calls + 1, "never recursively acquire outer lease")
  assert.equal(f.s.holderCounts().held, false)
  assert.deepEqual(f.s.files, files)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.rollbackAuthorized, false)
  assert.equal(result.remoteWritesAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
})

test("D218 complete restart proof accepts a second device advancing only the old Source during Backup verification", async () => {
  const f = await d179Scenario()
  const { contract } = await d183PreparedPair(f)
  const b = await d217CurrentFrozenBackup(f)
  const source = f.input.full.branches.readers.source
  let sourceSha = f.id.sourceCommitSha
  let sourceRefReads = 0
  const advancedSha = "9".repeat(40)
  source.getGitRefOrNull = async () => {
    sourceRefReads++
    return { ref: "refs/heads/main", type: "commit", sha: sourceSha }
  }
  source.getGitCommit = async sha => sha === advancedSha
    ? { sha, treeSha: "8".repeat(40), parentShas: [f.id.sourceCommitSha], message: "other-device-sync" }
    : { sha: f.id.sourceCommitSha, treeSha: f.id.sourceTreeSha,
      parentShas: ["1".repeat(40)], message: "original" }
  const originalBlob = b.github.getBlob
  let switched = false
  b.github.getBlob = async sha => {
    const bytes = await originalBlob(sha)
    if (!switched) {
      switched = true
      sourceSha = advancedSha
    }
    return bytes
  }
  const before = new Map(f.s.files)
  const writes = f.s.getWrites()
  const calls = f.s.holderCounts().calls
  const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
    ...d185Input(f, contract), backup: b.backup,
  })
  assert.equal(switched, true)
  assert.ok(sourceRefReads >= 4, "both D178 full scans still check current Source")
  assert.equal(result.observation, "source-prepared-and-git-reverified-uncommitted")
  assert.equal(result.fullBackupContentReverifiedAfterRestart, true)
  assert.equal(result.fullDestinationContentReverifiedAfterRestart, true)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.holderCounts().calls, calls + 1)
  assert.equal(f.s.holderCounts().held, false)
  assert.deepEqual(f.s.files, before)
  assert.equal(f.s.getWrites(), writes)
})

test("D217 late Backup HEAD change or damaged ciphertext fails the complete composed proof", async () => {
  for (const caseName of ["backup-ref", "backup-blob"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const b = await d217CurrentFrozenBackup(f)
    if (caseName === "backup-ref") b.moveRefAfterFirstPass()
    else b.corruptAfterFirstPass()
    const before = f.s.getWrites()
    const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
      ...d185Input(f, contract), backup: b.backup,
    })
    assert.equal(result.observation, "manual-recovery-required", caseName)
    assert.equal(result.fullBackupContentReverifiedAfterRestart, false, caseName)
    assert.equal(result.fullDestinationContentReverifiedAfterRestart, false, caseName)
    assert.equal(result.localCutoverAuthorized, false, caseName)
    assert.equal(result.resumeSyncAuthorized, false, caseName)
    assert.ok(b.blobReads >= 4, "the first Backup pass must read real encrypted content")
    assert.equal(f.s.getWrites(), before)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D217 mismatched WAL/adapter/holder or Backup Secret fails before any Git read", async () => {
  for (const cause of ["wal", "adapter", "holder", "secret", "physical-repo"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const b = await d217CurrentFrozenBackup(f)
    if (cause === "wal") Object.assign(b.backup, {
      wal: { ...b.backup.wal, assertBestEffortCheckpoint: async () => "best-effort-readback-only" },
    })
    else if (cause === "adapter") Object.assign(b.backup, {
      adapter: { ...b.backup.adapter },
    })
    else if (cause === "holder") Object.assign(b.backup, {
      withExclusiveInitiatorLease: async <T>(body: () => Promise<T>) => body(),
    })
    else if (cause === "secret") Object.assign(b.backup.backup, { passphrase: "different-passphrase" })
    else Object.assign(b.backup.backup, {
      plan: { ...b.backup.backup.plan, physicalRepositoryId: 999 },
    })
    const before = f.s.getWrites()
    const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
      ...d185Input(f, contract), backup: b.backup,
    })
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.fullBackupContentReverifiedAfterRestart, false, cause)
    assert.equal(b.blobReads, 0, cause)
    assert.equal(f.s.getWrites(), before)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D217 local SecretStorage or WAL changing during Backup decrypt invalidates the unified proof", async () => {
  for (const cause of ["secret", "wal"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const b = await d217CurrentFrozenBackup(f)
    const originalBlob = b.github.getBlob
    let changed = false
    b.github.getBlob = async sha => {
      const bytes = await originalBlob(sha)
      if (!changed) {
        changed = true
        if (cause === "secret") f.s.secrets.set(f.id.destinationPassphraseSecretId, "changed")
        else f.s.setWal({ ...f.s.getWal(), generation: 777 })
      }
      return bytes
    }
    const writes = f.s.getWrites()
    const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
      ...d185Input(f, contract), backup: b.backup,
    })
    assert.equal(changed, true, cause)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.fullBackupContentReverifiedAfterRestart, false, cause)
    assert.equal(result.localCutoverAuthorized, false, cause)
    assert.equal(result.oldPassphraseCleanupAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D217 a post-holder Backup Git reader swap cannot certify an earlier coherent snapshot", async () => {
  const f = await d179Scenario()
  const { contract } = await d183PreparedPair(f)
  const b = await d217CurrentFrozenBackup(f)
  const original = f.prepared.withExclusiveInitiatorLease
  const wrapper = async <T>(body: () => Promise<T>): Promise<T> =>
    original(async () => {
      const result = await body()
      b.github.getGitRef = async () => ({
        ref: "refs/heads/" + b.github.branchName,
        type: "commit" as const, sha: "9".repeat(40),
      })
      return result
    })
  f.prepared.withExclusiveInitiatorLease = wrapper
  f.input.full.branches.withExclusiveInitiatorLease = wrapper
  Object.assign(b.backup, { withExclusiveInitiatorLease: wrapper })
  const writes = f.s.getWrites()
  const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
    ...d185Input(f, contract), backup: b.backup,
  })
  assert.ok(b.blobReads >= 8)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.fullBackupContentReverifiedAfterRestart, false)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(f.s.holderCounts().held, false)
})

test("D217 absent Backup never falls back to the legacy D185 partial proof", async () => {
  const f = await d179Scenario()
  const { contract } = await d183PreparedPair(f)
  const result = await inspectV4FencedLivePostCrashAndBackupAfterRestart({
    ...d185Input(f, contract), backup: undefined as never,
  })
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.fullBackupContentReverifiedAfterRestart, false)
  assert.equal(result.localCutoverAuthorized, false)
})

test("D185 single held lease brackets local post-crash readback with two fresh complete Destination Git scans", async () => {
  const f = await d179Scenario()
  const { contract } = await d183PreparedPair(f)
  // Production GitHub clients may have cyclic runtime state; the verifier
  // must pin methods without serializing an entire client object.
  Object.assign(f.s.f.github, { circularClientState: f.s.f.github })
  const input = d185Input(f, contract)
  const original = new Map(f.s.files)
  const originalWrites = f.s.getWrites()
  const calls = f.s.holderCounts().calls
  const reads = f.s.f.reads
  const refs = f.s.f.refs
  const report = await inspectV4FencedLivePostCrashAfterRestart(input)
  assert.deepEqual(report, {
    integrityScope: "read-only-post-crash-local-pair-and-current-complete-git",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    observation: "source-prepared-and-git-reverified-uncommitted",
    reason: "source-and-git-coherent-but-uncommitted",
    local: {
      integrityScope: "read-only-fenced-post-crash-test-pair-window",
      evidence: "historical-d183-witness-and-best-effort-wal-readback-not-durable",
      observation: "source-prepared-uncommitted",
      reason: "source-still-selected-no-pair",
      artifactWindow: "absent", settingsSelection: "source",
      activeIndexSelection: "source", pairEvidence: "absent",
      localCutoverAuthorized: false, resumeSyncAuthorized: false,
      rollbackAuthorized: false, remoteWritesAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
    },
    fullDestinationContentReverifiedAfterRestart: true,
    liveThreeBranchRefsReverifiedAfterRestart: true,
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(Object.isFrozen(report), true)
  assert.equal(Object.isFrozen(report.local), true)
  assert.deepEqual(f.s.holderCounts(), { calls: calls + 1, held: false })
  assert.ok(f.s.f.reads >= reads + 8, "two full AES-GCM Git ciphertext reads")
  assert.ok(f.s.f.refs > refs, "live GitHub ref queries cannot be historical-only")
  assert.deepEqual(f.s.files, original)
  assert.equal(f.s.getWrites(), originalWrites)
  assert.equal(f.s.secrets.get("old-d138"), "old-d138-secret")
})

test("D185 on-disk valid D182 pair plus current full Git proof still requires Manual Recovery", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  await d185PlacePairedEvidence(f, pair)
  const writes = f.s.getWrites()
  const files = new Map(f.s.files)
  const report = await inspectV4FencedLivePostCrashAfterRestart(d185Input(f, contract))
  assert.equal(report.observation, "crash-window-git-reverified-manual-recovery")
  assert.equal(report.reason, "local-crash-window-still-requires-manual-recovery")
  assert.equal(report.local?.reason, "linked-test-pair-not-authoritative")
  assert.equal(report.local?.pairEvidence, "cryptographically-linked-uncommitted")
  assert.equal(report.fullDestinationContentReverifiedAfterRestart, true)
  assert.equal(report.liveThreeBranchRefsReverifiedAfterRestart, true)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.rollbackAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.deepEqual(f.s.files, files)
})

test("D185 a Destination-looking Settings/Index cannot become an authorized commit even with live Git proof", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  const input = d185Input(f, contract)
  await d185PlacePairedEvidence(f, pair)
  const shadow = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + f.id.runId)
  await saveV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT, shadow)
  input.local.prepared.restart.settings.githubBranch = "rekey/d83"
  input.local.prepared.restart.settings.encryptionPassphraseSecretId = f.id.destinationPassphraseSecretId
  const writes = f.s.getWrites()
  const result = await inspectV4FencedLivePostCrashAfterRestart(input)
  assert.equal(result.observation, "crash-window-git-reverified-manual-recovery")
  assert.equal(result.local?.reason, "historical-evidence-missing-or-changed")
  assert.equal(result.local?.activeIndexSelection, "destination")
  assert.equal(result.local?.settingsSelection, "destination")
  assert.equal(result.fullDestinationContentReverifiedAfterRestart, true)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
})

test("D186 unrecognized or unauthenticated local commit artifacts must not advertise a complete live proof", async () => {
  for (const cause of ["oversized-selector", "orphan-receipt", "invalid-pair"] as const) {
    const f = await d179Scenario()
    const { contract, pair } = await d183PreparedPair(f)
    await d185PlacePairedEvidence(f, pair)
    const root = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + f.id.runId
    const selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
    if (cause === "oversized-selector") {
      f.s.adapter.stat = async path => ({
        size: path === selector ? 64 * 1024 * 1024 : (f.s.files.get(path)?.length ?? 0),
      })
    } else if (cause === "orphan-receipt") {
      const originalExists = f.s.adapter.exists
      f.s.adapter.exists = async path => path === root ? false : originalExists(path)
    } else {
      f.s.files.set(selector, "invalid-AES-GCM-selector")
    }
    const writes = f.s.getWrites()
    const files = new Map(f.s.files)
    const gitReads = f.s.f.reads
    const refReads = f.s.f.refs
    const report = await inspectV4FencedLivePostCrashAfterRestart(d185Input(f, contract))
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.reason, "local-or-live-git-proof-uncertain", cause)
    assert.equal(report.local, null, cause)
    assert.equal(report.fullDestinationContentReverifiedAfterRestart, false, cause)
    assert.equal(report.liveThreeBranchRefsReverifiedAfterRestart, false, cause)
    assert.equal(report.localCutoverAuthorized, false, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.f.reads, gitReads, cause)
    assert.equal(f.s.f.refs, refReads, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.deepEqual(f.s.files, files, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D185 remote Source, Backup or Destination ref drift and damaged encrypted Git Blob fail closed", async () => {
  for (const cause of ["source-ref", "backup-ref", "destination-ref", "blob", "non-orphan", "wal"] as const) {
    const f = await d179Scenario()
    const { contract, pair } = await d183PreparedPair(f)
    await d185PlacePairedEvidence(f, pair)
    if (cause === "source-ref" || cause === "backup-ref") {
      const reader = f.input.full.branches.readers[cause === "source-ref" ? "source" : "backup"]
      reader.getGitRefOrNull = async () => ({
        ref: "refs/heads/" + reader.branchName, type: "commit" as const, sha: "9".repeat(40),
      })
    } else if (cause === "destination-ref") f.s.f.changeRef("9".repeat(40))
    else if (cause === "blob") {
      const blob = f.s.f.blobs.get(f.s.f.receipts[0]!.sha)!
      const damaged = blob.slice()
      damaged[damaged.length - 1] ^= 1
      f.s.f.blobs.set(f.s.f.receipts[0]!.sha, damaged)
    } else if (cause === "non-orphan") {
      f.s.f.github.getGitCommit = async () => ({
        sha: rootSha, treeSha, parentShas: [pinned], message: "bad parent",
      })
    } else f.s.setWal({ ...f.s.getWal(), generation: 999 })
    const writes = f.s.getWrites()
    const result = await inspectV4FencedLivePostCrashAfterRestart(d185Input(f, contract))
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.reason, "local-or-live-git-proof-uncertain", cause)
    assert.equal(result.local, null, cause)
    assert.equal(result.fullDestinationContentReverifiedAfterRestart, false, cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false)
  }
})

test("D185 a Git ref moving between two full-content rechecks fails closed despite unchanged local Receipt", async () => {
  const f = await d179Scenario()
  const { contract, pair } = await d183PreparedPair(f)
  await d185PlacePairedEvidence(f, pair)
  const originalRead = f.s.adapter.read
  const selectorPath = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + f.id.runId + "/selector.json"
  let selectorReads = 0
  f.s.adapter.read = async path => {
    const value = await originalRead(path)
    if (path === selectorPath && ++selectorReads === 3) {
      // D184's second inspection begins after the FIRST D178 complete scan.
      f.s.f.changeRef("9".repeat(40))
    }
    return value
  }
  const writes = f.s.getWrites()
  const report = await inspectV4FencedLivePostCrashAfterRestart(d185Input(f, contract))
  assert.ok(selectorReads >= 3)
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.fullDestinationContentReverifiedAfterRestart, false)
  assert.equal(report.local, null)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(f.s.getWrites(), writes)
  assert.equal(f.s.holderCounts().held, false)
})

test("D185 mutated SecretStorage, Source Index or Git reader during Git Blob retrieval refuses remote proof", async () => {
  for (const cause of ["secret", "source-index", "reader"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const oldBlob = f.s.f.github.getBlob
    let changed = false
    f.s.f.github.getBlob = async sha => {
      const bytes = await oldBlob(sha)
      if (!changed) {
        changed = true
        if (cause === "secret") f.s.secrets.set("new-d138", "swapped-mid-remote")
        else if (cause === "source-index") {
          const index = await loadV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT)
          index.epoch++
          await saveV4LocalIndex(f.s.adapter, V4_RUNTIME_INDEX_ROOT, index)
        } else {
          f.input.full.branches.readers.source.getGitCommit = async () => ({
            sha: pinned, treeSha: sourceTree,
            parentShas: [], message: "swapped reader",
          })
        }
      }
      return bytes
    }
    const writes = f.s.getWrites()
    const result = await inspectV4FencedLivePostCrashAfterRestart(d185Input(f, contract))
    assert.equal(changed, true, cause)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.fullDestinationContentReverifiedAfterRestart, false, cause)
    assert.equal(result.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes + (cause === "source-index" ? 1 : 0), cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
})

test("D185 forged, double-called or post-mutating outer Holder cannot report positive current Git evidence", async () => {
  for (const cause of ["skip", "double", "post-settings", "post-ref-method"] as const) {
    const f = await d179Scenario()
    const { contract } = await d183PreparedPair(f)
    const input = d185Input(f, contract)
    const originalHolder = f.prepared.withExclusiveInitiatorLease
    const previous = cause === "skip"
      ? await inspectV4FencedLivePostCrashAfterRestart(input)
      : null
    const wrapper = async <T>(action: () => Promise<T>): Promise<T> => {
      if (cause === "skip") return previous as T
      return originalHolder(async () => {
        const first = await action()
        if (cause === "double") await action()
        else if (cause === "post-settings") f.prepared.restart.settings.githubBranch = "other"
        else f.input.full.branches.readers.backup.getGitRefOrNull = async () => ({
          ref: "refs/heads/backup/d178", type: "commit" as const, sha: pinned,
        })
        return first
      })
    }
    f.prepared.withExclusiveInitiatorLease = wrapper
    f.input.full.branches.withExclusiveInitiatorLease = wrapper
    const writes = f.s.getWrites()
    const report = await inspectV4FencedLivePostCrashAfterRestart(input)
    assert.equal(report.observation, "manual-recovery-required", cause)
    assert.equal(report.fullDestinationContentReverifiedAfterRestart, false, cause)
    assert.equal(report.resumeSyncAuthorized, false, cause)
    assert.equal(f.s.getWrites(), writes, cause)
    assert.equal(f.s.holderCounts().held, false, cause)
  }
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
