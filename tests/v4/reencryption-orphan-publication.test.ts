import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import { proposeV4SameRepositoryReencryptionBackupBranch } from "../../src/lib/v4/reencryption-owner-decisions"
import {
  prepareV4ReencryptionOrphanCommit,
  publishV4ReencryptionOrphanRef,
  type V4PreparedOrphanCommit,
} from "../../src/lib/v4/reencryption-orphan-publication"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { verifyV4ReencryptionDestinationExactCommit } from "../../src/lib/v4/reencryption-destination-exact-commit"
import { inspectV4ReencryptionOrphanAfterAmbiguousPublication } from "../../src/lib/v4/reencryption-orphan-recovery"
import { publishAndVerifyV4ReencryptionOrphanRef } from "../../src/lib/v4/reencryption-orphan-publication-reconciled"
import { publishV4ThreeBranchDestinationAfterBackup } from "../../src/lib/v4/reencryption-three-branch-publish"
import { publishV4JournaledThreeBranchDestination, publishV4BestEffortJournaledThreeBranchDestination, prepareV4JournaledOrphanCandidate, prepareV4BestEffortJournaledOrphanCandidate, reconcileV4PendingOrphanWithJournal, reconcileV4PendingOrphanWithJournalBestEffort } from "../../src/lib/v4/reencryption-ref-journal-coordinator"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { computeV4ReencryptionCandidateManifestDigest, computeV4ReencryptionPreparationDigest } from "../../src/lib/v4/reencryption-candidate-manifest-digest"
import type { V4LocalIndexAdapter, V4IndexFileRecord } from "../../src/lib/v4/local-index"
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import type { V4ReencryptionStagingResult } from "../../src/lib/v4/reencryption-staging-receipts"
import type { V4GitHubFrozenBackupVerificationReport } from "../../src/lib/v4/reencryption-trusted-loader"

const sourceId = "owner/repo#main"
const targetId = "owner/repo#rekey/new-branch"
const sourceSha = "a".repeat(40)
const sourceTreeSha = "b".repeat(40)
const candidateTreeSha = "c".repeat(40)
const candidateSha = "d".repeat(40)
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: sourceId,
  destinationRepoId: targetId,
  sourceCommitSha: sourceSha,
  sourcePhysicalRepositoryId: 22,
  destinationPhysicalRepositoryId: 22,
  expectedPhysicalRepositoryId: 22,
  defaultBranch: "main",
})
const config = (repoId: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId,
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: toBase64Url(utf8ToBytes(salt)) },
})

async function fixture() {
  const sourceConfig = config(sourceId, "old-salt-d96")
  const destinationConfig = config(targetId, "new-salt-d96")
  const destinationKeyring = await deriveV4Keyring({
    passphrase: "new-secret",
    repoId: targetId, salt: utf8ToBytes("new-salt-d96"), iterations: 600_000,
  })
  const codec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring,
  })
  const plaintext = utf8ToBytes("Vault has real encrypted content")
  const encoded = await codec.prepare("Notes/🪄.md", plaintext, "v1", 123, "D96-file-id")
  const record = { ...encoded.record, path: "Notes/🪄.md" }
  const staged: V4ReencryptionStagingResult = {
    records: [record],
    receipts: encoded.files.map(file => ({
      path: file.path, sha: computeV4GitBlobSha1(file.bytes),
      byteLength: file.bytes.byteLength,
    })),
    preview: {
      integrityScope: "staged-immutable-blobs-only",
      backupVerified: false,
      destinationReadbackVerified: false,
      permissionToPublish: false,
      cutoverAuthorized: false,
      pinnedSourceCommitSha: sourceSha,
      destinationRepoId: targetId,
      finalizedFileCount: 1,
      validatedReceiptCount: encoded.files.length,
      totalPlaintextBytes: String(plaintext.byteLength),
    },
  }
  const verifiedBackup: V4GitHubFrozenBackupVerificationReport = {
    integrityScope: "authenticated-frozen-backup-all-live-objects",
    backupRepoId: "owner/repo#backup/frozen",
    pinnedSourceCommitSha: sourceSha,
    pinnedSourceTreeSha: sourceTreeSha,
    verifiedFileCount: 1,
    verifiedRemoteObjectCount: 1,
    verifiedPlaintextBytes: String(plaintext.byteLength),
    backupContentsReadbackVerified: true,
    backupCreationProven: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
  }
  // Immutable ciphertext receipts from a completed separate D79 staging run.
  const blobs = new Map(encoded.files.map(file => [computeV4GitBlobSha1(file.bytes), file.bytes]))
  const calls: string[] = []
  let remoteRef: string | null = null
  let wrongPhysicalRepo = false
  let wrongCommitParents = false
  let uncertainCreate = false
  let allowRead = true
  let mutationCount = 0
  let treeEntries: Array<{ path: string; sha: string; type: string; mode: string }> = []
  const github = {
    branchName: "rekey/new-branch",
    async getRepositoryIdentity() {
      calls.push("repo")
      return { id: wrongPhysicalRepo ? 99 : 22, fullName: "owner/repo" }
    },
    async getRepositoryDefaultBranch() { calls.push("default"); return "main" },
    async getGitRef() {
      calls.push("ref-strict")
      return remoteRef ? { ref: "refs/heads/rekey/new-branch", type: "commit", sha: remoteRef } : null
    },
    async getBlob(sha: string) {
      calls.push("blob-read")
      const value = blobs.get(sha)
      if (!value) throw new Error("Missing immutable Git blob")
      return value
    },
    async getGitRefOrNull() {
      calls.push("ref")
      if (!allowRead) throw new Error("GitHub uncertain 503")
      return remoteRef
        ? { ref: "refs/heads/rekey/new-branch", type: "commit", sha: remoteRef }
        : null
    },
    async getGitCommit(_sha: string) {
      calls.push("commit-read")
      return { sha: candidateSha, treeSha: candidateTreeSha,
        parentShas: wrongCommitParents ? [sourceSha] : [] }
    },
    async getTreeAt(_sha: string, _recursive = true) {
      calls.push("tree-read")
      return { sha: candidateTreeSha, truncated: false as const, tree: treeEntries }
    },
    async createGitBlob(content: Uint8Array) {
      calls.push("blob-create")
      mutationCount++
      const sha = computeV4GitBlobSha1(content)
      blobs.set(sha, content.slice())
      return sha
    },
    async createGitTree(entries: Array<{ path: string; sha?: string | null; type: string; mode: string }>, baseTree?: string) {
      calls.push("tree-create")
      assert.equal(baseTree, undefined, "MUST NOT inherit old ciphertext or Git tree")
      mutationCount++
      treeEntries = entries.map(x => ({
        path: x.path, sha: x.sha!, type: x.type, mode: x.mode,
      }))
      return candidateTreeSha
    },
    async createGitCommit(_message: string, _tree: string, parents: string[]) {
      calls.push("commit-create")
      assert.deepEqual(parents, [])
      mutationCount++
      return candidateSha
    },
    async createGitRef(sha: string) {
      calls.push("ref-create")
      mutationCount++
      if (remoteRef) throw new Error("Ref already exists")
      remoteRef = sha
      if (uncertainCreate) throw new Error("Network response lost")
    },
  }
  const input = {
    plan, github, sourceConfig, destinationConfig, destinationKeyring,
    staged, verifiedBackup, sourceTreeSha,
    deviceId: "device-D96", journalId: "rekey-D96",
    createdAt: 1234567,
    async assertExclusiveMigrationLease() { calls.push("lease") },
  }
  return {
    input, github, calls, blobs, get mutationCount() { return mutationCount },
    get treeEntries() { return treeEntries },
    markWrongRepo() { wrongPhysicalRepo = true },
    markWrongCommitParents() { wrongCommitParents = true },
    occupyRef(sha = sourceSha) { remoteRef = sha },
    loseCreateResponse() { uncertainCreate = true },
    failRefReads() { allowRead = false },
  }
}

test("D96 creates real metadata blobs and one ZERO-PARENT orphan commit but not a branch ref", async () => {
  const f = await fixture()
  const result = await prepareV4ReencryptionOrphanCommit(f.input)
  assert.equal(result.integrityScope, "unreferenced-encrypted-orphan-commit")
  assert.equal(result.commitSha, candidateSha)
  assert.equal(result.treeSha, candidateTreeSha)
  assert.equal(result.verifiedFileCount, 1)
  assert.equal(result.stagedCiphertextObjectCount, 1)
  assert.equal(result.encryptedMetadataObjectCount, 3)
  assert.equal(result.refPublished, false)
  assert.equal(result.cutoverAuthorized, false)
  assert.deepEqual(f.calls.filter(x => x.includes("-create")), [
    "blob-create", "blob-create", "blob-create", "tree-create", "commit-create",
  ])
  assert.ok(!f.calls.includes("ref-create"))
  assert.equal(f.treeEntries.length, 4)
  assert.ok(f.treeEntries.every(x => x.path.startsWith(".obsidian-github-sync-v4/")))
  assert.ok(!JSON.stringify(f.treeEntries).includes("Notes/🪄.md"))
  assert.ok(Object.isFrozen(result))
})

test("D96 creates destination branch ONLY after supplied durable intent and via one createGitRef", async () => {
  const f = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(f.input)
  let journalWrites = 0
  const res = await publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    async assertExclusiveMigrationLease() { f.calls.push("lease") },
    async assertDurablePublicationIntent() { journalWrites++; f.calls.push("durable-intent") },
  })
  assert.equal(journalWrites, 1)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
  assert.ok(f.calls.indexOf("durable-intent") < f.calls.indexOf("ref-create"))
  assert.equal(res.status, "destination-ref-create-confirmed")
  assert.equal(res.destinationContentReadbackVerified, false)
  assert.equal(res.cutoverAuthorized, false)
  assert.ok(!JSON.stringify(res).includes("new-secret"))
})

test("D125 refuses a candidate SHA changed after Git commit verification and durable intent", async () => {
  const f = await fixture()
  const verified = await prepareV4ReencryptionOrphanCommit(f.input)
  // A caller can reconstruct a mutable structural candidate during recovery.
  // TypeScript readonly does not establish run-time object immutability.
  const candidate = { ...verified }
  let intentRecorded = false
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {
      intentRecorded = true
      candidate.commitSha = "e".repeat(40)
    },
  }), /candidate|changed|commit|intent/i)
  assert.equal(intentRecorded, true)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0,
    "an independently verified candidate SHA cannot switch before GitHub create-ref")
})

test("D96 full in-memory GitHub lifecycle reads and decrypts every newly encrypted orphan blob from the published exact commit", async () => {
  const f = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(f.input)
  await publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  })
  const verified = await verifyV4ReencryptionDestinationExactCommit({
    github: f.github,
    plan, destinationCommitSha: candidate.commitSha, sourceTreeSha,
    sourceConfig: f.input.sourceConfig,
    expectedDestinationConfig: f.input.destinationConfig,
    expectedRecords: f.input.staged.records,
    expectedReceipts: f.input.staged.receipts,
    destinationPassphrase: "new-secret",
  })
  assert.equal(verified.integrityScope, "exact-orphan-commit-all-live-content")
  assert.equal(verified.verifiedFileCount, 1)
  assert.equal(verified.verifiedRemoteObjectCount, 1)
  assert.equal(verified.totalVerifiedPlaintextBytes, f.input.staged.preview.totalPlaintextBytes)
  assert.equal(verified.permissionToPublish, false)
  assert.equal(verified.cutoverAuthorized, false)
  // A wrong new password must fail to decrypt the published branch.
  await assert.rejects(() => verifyV4ReencryptionDestinationExactCommit({
    github: f.github,
    plan, destinationCommitSha: candidate.commitSha, sourceTreeSha,
    sourceConfig: f.input.sourceConfig,
    expectedDestinationConfig: f.input.destinationConfig,
    expectedRecords: f.input.staged.records,
    expectedReceipts: f.input.staged.receipts,
    destinationPassphrase: "old-wrong-secret",
  }), /auth|decrypt|integrity|metadata/i)
})

function recoveryInput(f: Awaited<ReturnType<typeof fixture>>, prepared: Awaited<ReturnType<typeof prepareV4ReencryptionOrphanCommit>>) {
  return {
    github: f.github, plan, prepared,
    sourceTreeSha,
    sourceConfig: f.input.sourceConfig,
    expectedDestinationConfig: f.input.destinationConfig,
    expectedRecords: f.input.staged.records,
    expectedReceipts: f.input.staged.receipts,
    destinationPassphrase: "new-secret",
  }
}

test("D97 read-only recovery distinguishes two absent ref samples; no retry, overwrite or cutover", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const mutationBefore = f.mutationCount
  const report = await inspectV4ReencryptionOrphanAfterAmbiguousPublication(recoveryInput(f, prepared))
  assert.equal(report.outcome, "destination-not-observed")
  assert.equal(report.destinationContentsVerified, false)
  assert.equal(report.verifiedFileCount, 0)
  assert.equal(report.refPublicationProvenByThisRun, false)
  assert.equal(report.automaticallyRetryCreateAuthorized, false)
  assert.equal(report.overwriteAuthorized, false)
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(f.mutationCount, mutationBefore)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
  assert.ok(Object.isFrozen(report))
})

test("D97 recovery reports an unexpected occupying commit without touching the old or new refs", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const before = f.mutationCount
  f.occupyRef(sourceSha)
  const report = await inspectV4ReencryptionOrphanAfterAmbiguousPublication(recoveryInput(f, prepared))
  assert.equal(report.outcome, "destination-occupied-by-unexpected-commit")
  assert.equal(report.destinationContentsVerified, false)
  assert.equal(report.automaticallyRetryCreateAuthorized, false)
  assert.equal(f.mutationCount, before)
  assert.equal(f.calls.filter(x => x === "blob-read").length, 0)
})

test("D97 lost create-ref response recovers full encrypted orphan content with the NEW key but authorizes no cutover", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  f.loseCreateResponse()
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }), /response lost/)
  const mutations = f.mutationCount
  const report = await inspectV4ReencryptionOrphanAfterAmbiguousPublication(recoveryInput(f, prepared))
  assert.deepEqual(report, {
    integrityScope: "read-only-orphan-ref-and-complete-ciphertext-reconciliation",
    destinationRepoId: targetId,
    pinnedSourceCommitSha: sourceSha,
    expectedOrphanCommitSha: candidateSha,
    outcome: "destination-pinned-and-fully-verified",
    destinationContentsVerified: true,
    verifiedFileCount: 1,
    verifiedPlaintextBytes: f.input.staged.preview.totalPlaintextBytes,
    refPublicationProvenByThisRun: false,
    automaticallyRetryCreateAuthorized: false,
    overwriteAuthorized: false,
    backupRestoreVerified: false,
    localCutoverAuthorized: false,
  })
  assert.equal(f.mutationCount, mutations)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
  assert.ok(f.calls.filter(x => x === "blob-read").length >= 4)
})

test("D97 recovery rejects wrong destination secret and corrupted exact Git blob without granting success", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  f.occupyRef(candidateSha)
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    ...recoveryInput(f, prepared), destinationPassphrase: "wrong-new-passphrase",
  }), /auth|decrypt|integrity|metadata/i)
  const entry = [...f.blobs.entries()].find(([, bytes]) => bytes.length > 0)!
  const corrupt = entry[1].slice()
  corrupt[0] = corrupt[0]! ^ 0xff
  f.blobs.set(entry[0], corrupt)
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication(
    recoveryInput(f, prepared),
  ), /Git blob|SHA|identity|mismatch/i)
})

test("D97 recovery fails closed for ref drift, malformed ref, repository change and unknown GitHub status", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  let reads = 0
  const original = f.github.getGitRefOrNull
  f.github.getGitRefOrNull = async () => {
    const ref = await original()
    reads++
    if (reads === 2) return { ref: "refs/heads/rekey/new-branch", type: "commit", sha: sourceSha }
    return ref
  }
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication(
    recoveryInput(f, prepared),
  ), /changed/i)

  const wrong = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(wrong.input)
  wrong.markWrongRepo()
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication(
    recoveryInput(wrong, candidate),
  ), /physical GitHub repository mismatch/i)

  const invalidRef = await fixture()
  const root = await prepareV4ReencryptionOrphanCommit(invalidRef.input)
  invalidRef.github.getGitRefOrNull = async () => ({
    ref: "refs/heads/main", type: "tag", sha: sourceSha,
  })
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication(
    recoveryInput(invalidRef, root),
  ), /wrong Git ref/i)

  const unknown = await fixture()
  const pre = await prepareV4ReencryptionOrphanCommit(unknown.input)
  unknown.failRefReads()
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication(
    recoveryInput(unknown, pre),
  ), /503/i)
})

test("D97 recovery checks candidate plan, branch scope, committed records and AbortSignal before Git reads", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const before = f.calls.length
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    ...recoveryInput(f, prepared), prepared: { ...prepared, commitSha: "HEAD" },
  }), /candidate/i)
  assert.equal(f.calls.length, before)

  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    ...recoveryInput(f, prepared),
    github: { ...f.github, branchName: "main" },
  }), /scope/i)

  const controller = new AbortController()
  controller.abort(new Error("user cancelled rekey"))
  await assert.rejects(() => inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    ...recoveryInput(f, prepared), signal: controller.signal,
  }), /cancelled rekey/i)
  assert.equal(f.calls.length, before)
})

test("D98 publish + independent content verification is success only after every encrypted blob is decrypted", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  let intentWritten = false
  const report = await publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertDurablePublicationIntent: async () => { intentWritten = true; f.calls.push("intent") },
    assertExclusiveMigrationLease: async () => {},
  })
  assert.equal(intentWritten, true)
  assert.equal(report.publicationOutcome, "response-confirmed")
  assert.equal(report.destinationContentsReadbackVerified, true)
  assert.equal(report.verifiedFileCount, 1)
  assert.equal(report.verifiedPlaintextBytes, f.input.staged.preview.totalPlaintextBytes)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(report.durableJournalIndependentlyAudited, false)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
  assert.ok(f.calls.indexOf("intent") < f.calls.indexOf("ref-create"))
})

test("D98 lost create response recovers exact new-key ciphertext without a second ref mutation", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  f.loseCreateResponse()
  const report = await publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertDurablePublicationIntent: async () => {},
    assertExclusiveMigrationLease: async () => {},
  })
  assert.equal(report.publicationOutcome, "lost-response-reconciled")
  assert.equal(report.destinationContentsReadbackVerified, true)
  assert.equal(report.backupRestoreVerified, false)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
})

test("D98 without a durable intent cannot make a remote ref; wrong new-key readback cannot report success", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  await assert.rejects(() => publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertDurablePublicationIntent: async () => { throw new Error("directory fsync EPERM") },
    assertExclusiveMigrationLease: async () => {},
  }), /fsync EPERM/)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)

  const bad = await fixture()
  const root = await prepareV4ReencryptionOrphanCommit(bad.input)
  const mutationBefore = bad.mutationCount
  await assert.rejects(() => publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(bad, root),
    destinationPassphrase: "wrong",
    assertDurablePublicationIntent: async () => {},
    assertExclusiveMigrationLease: async () => {},
  }), /auth|decrypt|integrity|metadata/i)
  assert.equal(bad.calls.filter(x => x === "ref-create").length, 1)
  assert.equal(bad.mutationCount, mutationBefore + 1)
  // Ref may now exist. A failed post-publication verification never switches
  // the current vault or deletes any branch.
})

test("D99 refuses to misclassify pre-create name collision as our successful lost create response", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  await assert.rejects(() => publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {
      // Another actor claimed this exact SHA/ref after our initial absence
      // probes, but before our own create request. This is NOT our operation.
      f.occupyRef(prepared.commitSha)
    },
  }), /present|overwrite/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D100 deterministic GitHub 422 after a competing identical ref cannot be accepted as our own publication", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  f.github.createGitRef = async () => {
    f.occupyRef(prepared.commitSha)
    throw Object.assign(new Error("GitHub 422 refused create-ref collision"), { status: 422 })
  }
  await assert.rejects(() => publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }), /422 refused/)
  // No successful owned ref creation, even though third-party ref points to
  // exactly the same immutable Git candidate SHA.
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D99 records a distinct post-create readback recovery outcome without claiming a lost create response", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  let firstAfterCreate = true
  const originalRead = f.github.getGitRefOrNull
  const originalWrite = f.github.createGitRef
  f.github.createGitRef = async sha => {
    await originalWrite(sha)
    f.github.getGitRefOrNull = async () => {
      if (firstAfterCreate) {
        firstAfterCreate = false
        throw new Error("GitHub 503 after successful create response")
      }
      return originalRead()
    }
  }
  const report = await publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  })
  assert.equal(report.publicationOutcome, "post-create-readback-reconciled")
  assert.equal(report.destinationContentsReadbackVerified, true)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
})

test("D98 refused GitHub reads after uncertain mutation remain unresolved; no blind retry", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  f.loseCreateResponse()
  const original = f.github.createGitRef
  f.github.createGitRef = async sha => {
    try { await original(sha) }
    finally { f.failRefReads() }
  }
  await assert.rejects(() => publishAndVerifyV4ReencryptionOrphanRef({
    ...recoveryInput(f, prepared),
    assertDurablePublicationIntent: async () => {},
    assertExclusiveMigrationLease: async () => {},
  }), /ambiguous|recovery/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
})

const D100backupPlan = proposeV4SameRepositoryReencryptionBackupBranch({
  sourceRepoId: sourceId,
  backupRepoId: "owner/repo#backup/frozen",
  destinationRepoId: targetId,
  pinnedSourceCommitSha: sourceSha,
  sourcePhysicalRepositoryId: 22,
  backupPhysicalRepositoryId: 22,
  destinationPhysicalRepositoryId: 22,
  expectedPhysicalRepositoryId: 22,
  defaultBranch: "main",
})

function D100input(f: Awaited<ReturnType<typeof fixture>>, prepared: Awaited<ReturnType<typeof prepareV4ReencryptionOrphanCommit>>) {
  const total = f.input.staged.preview.totalPlaintextBytes
  return {
    ...recoveryInput(f, prepared),
    backupPlan: D100backupPlan,
    initiatorLocalParity: {
      pinnedSourceCommitSha: sourceSha,
      verifiedSource: {
        integrityScope: "all-live-objects" as const,
        pinnedSourceCommitSha: sourceSha,
        verifiedFileCount: f.input.staged.records.length,
        verifiedRemoteObjectCount: f.input.staged.receipts.length,
        totalVerifiedPlaintextBytes: total,
      },
      sourceRecords: f.input.staged.records,
      reader: {
        async listFiles() {
          return f.input.staged.records.map(record => ({
            path: record.path, size: record.size, mtime: 123,
          }))
        },
        async openFile(_path: string) {
          const bytes = utf8ToBytes("Vault has real encrypted content")
          return {
            size: bytes.byteLength,
            async *chunks(_n: number) { yield bytes },
          }
        },
        async listOpenEditorPaths() { return [] as string[] },
        async assertIdleAndNoPendingEdits() {},
        async assertSourceConfigurationUnchanged() {},
        async assertExclusiveInitiatorLease() {},
      },
    },
    backupRefReader: {
      branchName: "backup/frozen",
      async getRepositoryIdentity() { return { id: 22, fullName: "owner/repo" } },
      async getRepositoryDefaultBranch() { return "main" },
      async getGitRefOrNull() {
        return { ref: "refs/heads/backup/frozen", type: "commit", sha: sourceSha }
      },
      async getGitCommit(sha: string) {
        assert.equal(sha, sourceSha)
        return { sha: sourceSha, treeSha: sourceTreeSha, parentShas: [] }
      },
    },
    createdAndVerifiedBackup: {
      integrityScope: "backup-ref-create-only-and-full-authenticated-content" as const,
      backupRepoId: D100backupPlan.backupRepoId,
      pinnedSourceCommitSha: sourceSha,
      pinnedSourceTreeSha: sourceTreeSha,
      publicationOutcome: "response-confirmed" as const,
      verifiedFileCount: f.input.staged.records.length,
      verifiedPlaintextBytes: total,
      backupContentsReadbackVerified: true as const,
      backupRefCreateAttemptedByThisRun: true as const,
      independentlyProvenCreationProvenance: false as const,
      independentlyAuditedDurableIntent: false as const,
      installedObsidianRestoreVerified: false as const,
      independentStorageVerified: false as const,
      destinationPublicationAuthorized: false as const,
      initiatingDeviceCutoverAuthorized: false as const,
      oldSourceBranchMayKeepSyncing: true as const,
    },
    scratchRestore: {
      integrityScope: "isolated-scratch-restore-roundtrip-only" as const,
      pinnedSourceCommitSha: sourceSha,
      roundTripFileCount: f.input.staged.records.length,
      roundTripPlaintextBytes: total,
      scratchReadbackMatched: true as const,
      independentStorageVerified: false as const,
      installedObsidianRestoreVerified: false as const,
      permissionToPublish: false as const,
      cutoverAuthorized: false as const,
    },
    assertCrashDurable: async () => {},
    assertInitiatingVaultUnchanged: async () => {},
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }
}

test("D100 complete three-role proof permits one destination publication and remote encrypted parity, NEVER local cutover", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const report = await publishV4ThreeBranchDestinationAfterBackup(D100input(f, prepared))
  assert.deepEqual(report, {
    integrityScope: "three-branch-verified-backup-and-destination-remote-only",
    sourceRepoId: sourceId,
    backupRepoId: D100backupPlan.backupRepoId,
    destinationRepoId: targetId,
    originalSourceCommitSha: sourceSha,
    destinationCommitSha: candidateSha,
    verifiedFileCount: 1,
    verifiedPlaintextBytes: f.input.staged.preview.totalPlaintextBytes,
    backupContentsReadbackVerified: true,
    backupScratchRoundTripVerified: true,
    destinationContentsReadbackVerified: true,
    oldBranchSyncRemainsIndependent: true,
    powerLossDurabilityIndependentlyAudited: false,
    initiatingDeviceCutoverAuthorized: false,
  })
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
  assert.ok(Object.isFrozen(report))
})

test("D100 rejects nonmatching backup/scratch/source/destination evidence BEFORE any remote branch publication", async () => {
  const mutants = [
    (v: ReturnType<typeof D100input>) => ({
      ...v, createdAndVerifiedBackup: { ...v.createdAndVerifiedBackup, pinnedSourceTreeSha: "f".repeat(40) },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, createdAndVerifiedBackup: { ...v.createdAndVerifiedBackup, verifiedPlaintextBytes: "10101" },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, createdAndVerifiedBackup: { ...v.createdAndVerifiedBackup, backupRefCreateAttemptedByThisRun: false as const },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, scratchRestore: { ...v.scratchRestore, scratchReadbackMatched: false as const },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, scratchRestore: { ...v.scratchRestore, pinnedSourceCommitSha: "f".repeat(40) },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, backupPlan: { ...v.backupPlan, destinationRepoId: "owner/repo#wrong" },
    }),
    (v: ReturnType<typeof D100input>) => ({
      ...v, createdAndVerifiedBackup: { ...v.createdAndVerifiedBackup, verifiedFileCount: 2 },
    }),
  ]
  for (const mutate of mutants) {
    const f = await fixture()
    const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
    await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup(
      mutate(D100input(f, prepared)) as Parameters<typeof publishV4ThreeBranchDestinationAfterBackup>[0],
    ), /three-branch publication evidence/i)
    assert.ok(!f.calls.includes("ref-create"))
  }
})

test("D100 refuses unproven Windows WAL durability or concurrent local edits without creating the destination branch", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input, assertCrashDurable: async () => { throw new Error("Node Windows directory fsync EPERM") },
  }), /fsync EPERM/)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)

  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input, assertInitiatingVaultUnchanged: async () => { throw new Error("Local edit detected") },
  }), /Local edit detected/)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D105 D100 publication fails BEFORE create-only Git ref mutation for same-size unsynced local bytes", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  const reader = {
    ...input.initiatorLocalParity.reader,
    async openFile(_path: string) {
      const bytes = utf8ToBytes("X".repeat(utf8ToBytes("Vault has real encrypted content").length))
      return {
        size: bytes.length,
        async *chunks() { yield bytes },
      }
    },
  }
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input,
    initiatorLocalParity: { ...input.initiatorLocalParity, reader },
  }), /SHA-256/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D105 D100 publication rechecks local vault after durable intent before destination ref creation", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  let extraFileAppeared = false
  const reader = {
    ...input.initiatorLocalParity.reader,
    async listFiles() {
      const files = await input.initiatorLocalParity.reader.listFiles()
      return extraFileAppeared
        ? [...files, { path: "unsynced.md", size: 7, mtime: 123 }]
        : files
    },
  }
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input,
    initiatorLocalParity: { ...input.initiatorLocalParity, reader },
    assertDurablePublicationIntent: async () => { extraFileAppeared = true },
  }), /unexpected|missing/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D124 rejects cross-guard source SHA substitution after durable intent before Destination ref create", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  const remoteEvidence = input.initiatorLocalParity.sourceRecords.map(r => ({ ...r }))
  const original = utf8ToBytes("Vault has real encrypted content")
  const changed = utf8ToBytes("X".repeat(original.length))
  const changedSha = await sha256Hex(changed)
  let localBytes: Uint8Array = original
  let mutated = false
  const reader = {
    ...input.initiatorLocalParity.reader,
    async openFile(_path: string) {
      const bytes = localBytes
      return {
        size: bytes.length,
        async *chunks() { yield bytes },
      }
    },
  }
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input,
    initiatorLocalParity: { ...input.initiatorLocalParity, sourceRecords: remoteEvidence, reader },
    assertDurablePublicationIntent: async () => {
      mutated = true
      localBytes = changed
      // This mutable caller-owned record can be replaced after the first
      // full parity proof. It must NOT become new remote truth at guard #2.
      remoteEvidence[0]!.plaintextSha256 = changedSha
    },
  }), /SHA-256|source|parity|changed|authenticated/i)
  assert.equal(mutated, true)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0,
    "never publish a Git ref using a locally substituted Source Index hash")
})

test("D100 backup ref deleted or retargeted after proof is never accepted for destination creation", async () => {
  for (const altered of [null, "f".repeat(40)]) {
    const f = await fixture()
    const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
    const input = D100input(f, prepared)
    const backupRefReader = {
      ...input.backupRefReader,
      async getGitRefOrNull() {
        return altered === null ? null
          : { ref: "refs/heads/backup/frozen", type: "commit", sha: altered }
      },
    }
    await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
      ...input, backupRefReader,
    }), /Backup ref disappeared or changed/i)
    assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
  }
})

test("D100 backup moved after intent was persisted but before create MUST NOT publish destination", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  let backupMoved = false
  const read = input.backupRefReader.getGitRefOrNull
  const backupRefReader = {
    ...input.backupRefReader,
    getGitRefOrNull: async () => backupMoved ? null : read(),
  }
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input, backupRefReader,
    assertDurablePublicationIntent: async () => { backupMoved = true },
  }), /Backup ref disappeared or changed/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

test("D100 refuses actual GitHub default-branch drift into the Backup branch", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  const backupRefReader = {
    ...input.backupRefReader,
    async getRepositoryDefaultBranch() { return "backup/frozen" },
  }
  await assert.rejects(() => publishV4ThreeBranchDestinationAfterBackup({
    ...input, backupRefReader,
  }), /GitHub default branch/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
})

function D110manifestDigest(f: Awaited<ReturnType<typeof fixture>>,
  prepared: Awaited<ReturnType<typeof prepareV4ReencryptionOrphanCommit>>) {
  const input = D100input(f, prepared)
  return computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha: input.sourceTreeSha,
    destinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  })
}

test("D110 candidate digest is stable across config object insertion order and detects any changed manifest evidence", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const input = D100input(f, prepared)
  const original = D110manifestDigest(f, prepared)
  assert.match(original, /^[0-9a-f]{64}$/u)
  const configReordered = Object.fromEntries(Object.entries(input.expectedDestinationConfig).reverse()) as typeof input.expectedDestinationConfig
  const reordered = computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha: input.sourceTreeSha,
    destinationConfig: configReordered,
    expectedRecords: [...input.expectedRecords].reverse(),
    expectedReceipts: [...input.expectedReceipts].reverse(),
  })
  assert.equal(original, reordered)
  for (const modified of [
    { expectedRecords: input.expectedRecords.map(r => ({ ...r, plaintextSha256: "f".repeat(64) })) },
    { expectedReceipts: input.expectedReceipts.map(r => ({ ...r, sha: "f".repeat(40) })) },
    { destinationConfig: {
      ...input.expectedDestinationConfig,
      kdfParams: { ...input.expectedDestinationConfig.kdfParams!, salt: "forged-new-salt" },
    } },
  ]) {
    const digest = computeV4ReencryptionCandidateManifestDigest({
      prepared, sourceTreeSha: input.sourceTreeSha,
      destinationConfig: modified.destinationConfig ?? input.expectedDestinationConfig,
      expectedRecords: modified.expectedRecords ?? input.expectedRecords,
      expectedReceipts: modified.expectedReceipts ?? input.expectedReceipts,
    })
    assert.notEqual(original, digest)
  }
  assert.throws(() => computeV4ReencryptionCandidateManifestDigest({
    prepared, sourceTreeSha: "f".repeat(40),
    destinationConfig: input.expectedDestinationConfig,
    expectedRecords: input.expectedRecords, expectedReceipts: input.expectedReceipts,
  }), /inputs disagree/i)
})

test("D110 recovery refuses changed manifest/KDF/receipt even with exact pinned destination Git commit", async () => {
  for (const mutation of ["record", "receipt", "config"] as const) {
    const f = await fixture()
    const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
    const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
    let state = (await j.journal.load())!
    state = await j.journal.recordRefIntent({
      role: "destination", repoId: targetId,
      commitSha: candidateSha, treeSha: candidateTreeSha,
      manifestSha256: D110manifestDigest(f, prepared),
    }, state.generation)
    const baseline = recoveryInput(f, prepared)
    const altered = {
      ...baseline,
      expectedRecords: mutation === "record"
        ? baseline.expectedRecords.map(r => ({ ...r, plaintextSha256: "f".repeat(64) }))
        : baseline.expectedRecords,
      expectedReceipts: mutation === "receipt"
        ? baseline.expectedReceipts.map(r => ({ ...r, sha: "f".repeat(40) }))
        : baseline.expectedReceipts,
      expectedDestinationConfig: mutation === "config"
        ? { ...baseline.expectedDestinationConfig,
            kdfParams: { ...baseline.expectedDestinationConfig.kdfParams!, salt: "altered" } }
        : baseline.expectedDestinationConfig,
    }
    await assert.rejects(() => reconcileV4PendingOrphanWithJournal({
      ...altered, backupPlan: D100backupPlan,
      backupRefReader: D100input(f, prepared).backupRefReader,
      verifiedOriginalSource: D103originalProof(f),
      journal: j.open(), wal: j.wal,
    }), /exact pending Destination intent/i)
    assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
    const stillPending = await j.open().load()
    assert.ok(stillPending)
    assert.equal(stillPending.pendingRefIntents.length, 1)
    assert.equal(stillPending.permissionToPublish, false)
    assert.equal(stillPending.cutoverAuthorized, false)
  }
})

async function D102DestinationJournal(
  receipts: readonly { path: string; sha: string; byteLength: number }[],
  records: readonly V4IndexFileRecord[],
  destinationConfig: V4RemoteConfig,
  sealCandidate = true,
  prepared?: V4PreparedOrphanCommit,
) {
  const files = new Map<string, string>()
  const adapter: V4LocalIndexAdapter = {
    async exists(path) { return files.has(path) },
    async read(path) {
      const data = files.get(path)
      if (data === undefined) throw new Error("missing")
      return data
    },
    async write(path, data) { files.set(path, data) },
    async mkdir(_path) {},
  }
  const open = () => createV4ReencryptionRecoveryJournal({
    adapter, root: "v4/rekey-destination",
    destinationRepoId: targetId, sourceCommitSha: sourceSha,
    runId: "d102-destination-run", journalKey: new Uint8Array(32).fill(0x36),
  })
  const journal = open()
  let snapshot = await journal.begin()
  const backupIntent = {
    role: "backup" as const, repoId: D100backupPlan.backupRepoId,
    commitSha: sourceSha, treeSha: sourceTreeSha,
  }
  snapshot = await journal.recordRefIntent(backupIntent, snapshot.generation)
  snapshot = await journal.markRefReadbackObserved(backupIntent, snapshot.generation)
  snapshot = await journal.recordStagingHandoff(backupIntent, snapshot.generation)
  for (const receipt of receipts) {
    snapshot = await journal.recordUploadIntent(receipt, snapshot.generation)
    snapshot = await journal.appendReceipt(receipt, snapshot.generation)
  }
  if (sealCandidate) {
    if (!prepared) throw new Error("Test fixture requires exact prepared candidate proof.")
    snapshot = await journal.recordCandidatePreparationIntent(
      computeV4ReencryptionPreparationDigest({
        sourceCommitSha: sourceSha, sourceTreeSha,
        destinationRepoId: targetId, destinationConfig,
        sourceConfig: config(sourceId, "old-salt-d96"),
        deviceId: "device-D96", journalId: "rekey-D96", createdAt: 1234567,
        expectedRecords: records, expectedReceipts: receipts,
      }), snapshot.generation)
    snapshot = await journal.recordPreparedCandidateReceipt({
      commitSha: prepared.commitSha, treeSha: prepared.treeSha,
      manifestSha256: computeV4ReencryptionCandidateManifestDigest({
        prepared, sourceTreeSha, destinationConfig,
        expectedRecords: records, expectedReceipts: receipts,
      }),
    }, snapshot.generation)
  }
  const wal = {
    async assertExclusiveStageLease() {},
    async assertCrashDurable() {},
  }
  // No-op WAL is test ONLY: does NOT certify power-loss-safe Windows writes.
  return { journal, open, wal, files }
}

test("D111 sealed preparation fingerprint includes source crypto config and the exact metadata device/journal/time", async () => {
  const f = await fixture()
  const baseline = {
    sourceCommitSha: sourceSha, sourceTreeSha, destinationRepoId: targetId,
    destinationConfig: f.input.destinationConfig,
    sourceConfig: f.input.sourceConfig,
    deviceId: f.input.deviceId, journalId: f.input.journalId,
    createdAt: f.input.createdAt,
    expectedRecords: f.input.staged.records,
    expectedReceipts: f.input.staged.receipts,
  }
  const expected = computeV4ReencryptionPreparationDigest(baseline)
  for (const changed of [
    { deviceId: "other-D96" },
    { journalId: "other-rekey-D96" },
    { createdAt: baseline.createdAt + 1 },
    { sourceConfig: {
      ...baseline.sourceConfig,
      kdfParams: { ...baseline.sourceConfig.kdfParams!, salt: "changed-old-public-salt" },
    } },
  ]) {
    assert.notEqual(computeV4ReencryptionPreparationDigest({ ...baseline, ...changed }), expected)
  }
})

const d168RiskAcknowledgement = "accept-best-effort-power-loss-recovery-risk" as const

function d168BestEffortWal() {
  return {
    async assertExclusiveStageLease() {},
    async assertBestEffortCheckpoint() { return "best-effort-readback-only" as const },
  }
}

test("D168 best-effort candidate records one authenticated preparation and receipt, creates zero-parent commit without publishing", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const input = {
    ...f.input, journal: j.journal, wal: d168BestEffortWal(),
    acknowledgement: d168RiskAcknowledgement,
  }
  const prepared = await prepareV4BestEffortJournaledOrphanCandidate(input)
  assert.equal(prepared.commitSha, candidateSha)
  assert.equal(prepared.treeSha, candidateTreeSha)
  assert.equal(prepared.rootHasZeroParents, true)
  assert.equal(prepared.refPublished, false)
  assert.equal(prepared.cutoverAuthorized, false)
  assert.equal(f.calls.filter(x => x === "blob-create").length, 3)
  assert.equal(f.calls.filter(x => x === "tree-create").length, 1)
  assert.equal(f.calls.filter(x => x === "commit-create").length, 1)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
  const snapshot = await j.open().load()
  assert.ok(snapshot)
  assert.deepEqual(snapshot.preparedCandidateReceipt, {
    commitSha: prepared.commitSha, treeSha: prepared.treeSha,
    manifestSha256: D110manifestDigest(f, prepared),
  })
  assert.equal(snapshot.permissionToPublish, false)
  assert.equal(snapshot.cutoverAuthorized, false)
  const count = f.mutationCount
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate({
    ...input, journal: j.open(),
  }), /one-shot preparation|Manual Recovery/i)
  assert.equal(f.mutationCount, count)
})

test("D168 absent risk acknowledgement refuses before WAL or GitHub mutation", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  let reads = 0
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate({
    ...f.input, journal: j.journal,
    wal: {
      async assertExclusiveStageLease() { reads++ },
      async assertBestEffortCheckpoint() {
        reads++
        return "best-effort-readback-only" as const
      },
    },
    acknowledgement: "declined" as typeof d168RiskAcknowledgement,
  }), /risk acknowledgement/i)
  assert.equal(reads, 0)
  assert.equal(f.mutationCount, 0)
  assert.equal((await j.open().load())?.candidatePreparationSha256, null)
})

test("D168 WAL checkpoint failure after one-shot candidate intent blocks all Git metadata writes and retries", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  let checkpoints = 0
  const input = {
    ...f.input, journal: j.journal,
    wal: {
      async assertExclusiveStageLease() {},
      async assertBestEffortCheckpoint() {
        checkpoints++
        if (checkpoints === 4) throw new Error("interrupted WAL slot readback")
        return "best-effort-readback-only" as const
      },
    },
    acknowledgement: d168RiskAcknowledgement,
  }
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate(input), /Manual Recovery/i)
  assert.equal(f.mutationCount, 0)
  const state = await j.open().load()
  assert.match(state?.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(state?.preparedCandidateReceipt, null)
  assert.equal(state?.cutoverAuthorized, false)
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate({
    ...input, journal: j.open(), wal: d168BestEffortWal(),
  }), /one-shot preparation|Manual Recovery/i)
  assert.equal(f.mutationCount, 0)
})

test("D168 lost metadata GitHub response cannot repeat one-shot best-effort candidate creation", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const original = f.github.createGitBlob
  f.github.createGitBlob = async bytes => {
    await original(bytes)
    throw new Error("GitHub 503 lost metadata Blob response")
  }
  const input = { ...f.input, journal: j.journal, wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement }
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate(input), /503 lost metadata/i)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
  assert.equal(f.calls.filter(c => c === "tree-create" || c === "commit-create" || c === "ref-create").length, 0)
  const snapshot = await j.open().load()
  assert.match(snapshot?.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(snapshot?.preparedCandidateReceipt, null)
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate({
    ...input, journal: j.open(),
  }), /one-shot preparation|Manual Recovery/i)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
})

test("D168 mutation of sealed staged ciphertext manifest after first metadata write blocks further writes", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const original = f.github.createGitBlob
  let changed = false
  f.github.createGitBlob = async bytes => {
    const sha = await original(bytes)
    if (!changed) {
      changed = true
      f.input.staged.records[0] = {
        ...f.input.staged.records[0]!, plaintextSha256: "f".repeat(64),
      }
    }
    return sha
  }
  await assert.rejects(() => prepareV4BestEffortJournaledOrphanCandidate({
    ...f.input, journal: j.journal, wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  }), /candidate inputs or WAL intent changed/i)
  assert.equal(changed, true)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
  assert.equal(f.calls.filter(c => c === "tree-create" || c === "commit-create" || c === "ref-create").length, 0)
  assert.equal((await j.open().load())?.cutoverAuthorized, false)
})

test("D168 real Windows WAL authenticates a zero-parent orphan candidate without publishing a ref", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d168-orphan-wal-"))
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: root, journalRoot: "v4/rekey-destination",
    })
    try {
      const f = await fixture()
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: storage.adapter, root: "v4/rekey-destination",
        destinationRepoId: targetId, sourceCommitSha: sourceSha,
        runId: "d168-orphan-run", journalKey: new Uint8Array(32).fill(0x36),
      })
      let state = await journal.begin()
      const backup = {
        role: "backup" as const, repoId: D100backupPlan.backupRepoId,
        commitSha: sourceSha, treeSha: sourceTreeSha,
      }
      state = await journal.recordRefIntent(backup, state.generation)
      state = await journal.markRefReadbackObserved(backup, state.generation)
      state = await journal.recordStagingHandoff(backup, state.generation)
      for (const receipt of f.input.staged.receipts) {
        state = await journal.recordUploadIntent(receipt, state.generation)
        state = await journal.appendReceipt(receipt, state.generation)
      }
      const prepared = await prepareV4BestEffortJournaledOrphanCandidate({
        ...f.input, journal, wal: storage, acknowledgement: d168RiskAcknowledgement,
      })
      assert.equal(prepared.commitSha, candidateSha)
      assert.equal(prepared.rootHasZeroParents, true)
      assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
      const saved = await journal.assertHealthySnapshot(state.generation + 2)
      assert.equal(saved.preparedCandidateReceipt?.commitSha, candidateSha)
      assert.equal(saved.permissionToPublish, false)
      assert.equal(saved.cutoverAuthorized, false)
    } finally { await storage.release() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("D111 one-shot candidate preparation persists WAL BEFORE Git metadata/tree/commit and refuses a second attempt", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const prepared = await prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal, wal: j.wal,
  })
  assert.equal(prepared.commitSha, candidateSha)
  assert.equal(prepared.refPublished, false)
  assert.ok(f.calls.includes("blob-create"))
  assert.ok(f.calls.includes("tree-create"))
  assert.ok(f.calls.includes("commit-create"))
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  const restarted = await j.open().load()
  assert.ok(restarted)
  assert.equal(restarted.candidatePreparationSha256, computeV4ReencryptionPreparationDigest({
    sourceCommitSha: sourceSha, sourceTreeSha, destinationRepoId: targetId,
    destinationConfig: f.input.destinationConfig,
    sourceConfig: f.input.sourceConfig,
    deviceId: f.input.deviceId, journalId: f.input.journalId, createdAt: f.input.createdAt,
    expectedRecords: f.input.staged.records, expectedReceipts: f.input.staged.receipts,
  }))
  assert.deepEqual(restarted.preparedCandidateReceipt, {
    commitSha: prepared.commitSha, treeSha: prepared.treeSha,
    manifestSha256: D110manifestDigest(f, prepared),
  })
  assert.equal(restarted.permissionToPublish, false)
  assert.equal(restarted.cutoverAuthorized, false)
  const mutationCount = f.mutationCount
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(f.mutationCount, mutationCount)
})

test("D112 failed post-commit WAL receipt leaves sealed preparation but cannot create Destination branch", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const brokenJournal = {
    ...j.journal,
    async recordPreparedCandidateReceipt() {
      throw new Error("Post-commit WAL receipt persist failed")
    },
  }
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: brokenJournal, wal: j.wal,
  }), /Post-commit WAL receipt persist failed/i)
  assert.ok(f.calls.includes("commit-create"))
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  const state = await j.open().load()
  assert.ok(state)
  assert.match(state.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(state.preparedCandidateReceipt, null)
  assert.equal(state.cutoverAuthorized, false)
  await assert.rejects(() => j.journal.recordRefIntent({
    role: "destination", repoId: targetId, commitSha: candidateSha,
    treeSha: candidateTreeSha, manifestSha256: "a".repeat(64),
  }, state.generation), /candidate receipt/i)
  const originalMutations = f.mutationCount
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(f.mutationCount, originalMutations)
})

test("D111 WAL durability failure AFTER sealed candidate intent blocks ALL metadata Git writes and replay", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  let durableChecks = 0
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal,
    wal: { ...j.wal, async assertCrashDurable() {
      if (++durableChecks === 2) throw new Error("Windows WAL directory fsync EPERM")
    } },
  }), /fsync EPERM/i)
  assert.equal(f.mutationCount, 0, "candidate Git Blob/Tree/Commit must not be created")
  const interrupted = await j.open().load()
  assert.ok(interrupted)
  assert.match(interrupted.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(interrupted.permissionToPublish, false)
  assert.equal(interrupted.cutoverAuthorized, false)
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(f.mutationCount, 0)
})

test("D111 altered staged file evidence after sealed intent must block ALL Git metadata mutations", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  let durabilityChecks = 0
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal,
    wal: {
      ...j.wal,
      async assertCrashDurable() {
        if (++durabilityChecks === 2) {
          // Concurrent mutable caller changes a record after WAL seals the
          // pre-commit manifest, but before the very first Git mutation.
          (f.input.staged.records[0]! as { plaintextSha256: string }).plaintextSha256 = "f".repeat(64)
        }
      },
    },
  }), /inputs or WAL intent changed/i)
  assert.equal(f.mutationCount, 0)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  const state = await j.open().load()
  assert.ok(state?.candidatePreparationSha256)
  assert.equal(state.cutoverAuthorized, false)
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(f.mutationCount, 0)
})

test("D111 lost metadata Git POST response leaves a sealed preparation WAL and no automatic repeat", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const originalUpload = f.github.createGitBlob
  let accepted = 0
  f.github.createGitBlob = async bytes => {
    const sha = await originalUpload(bytes)
    accepted++
    throw new Error("GitHub accepted encrypted metadata blob but reply was lost: " + sha)
  }
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal, wal: j.wal,
  }), /reply was lost/i)
  assert.equal(accepted, 1)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  const pending = await j.open().load()
  assert.ok(pending)
  assert.match(pending.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(pending.pendingRefIntents.length, 0)
  assert.equal(pending.cutoverAuthorized, false)
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(accepted, 1, "no blind re-upload after ambiguous GitHub response")
})

test("D111 candidate preparation detects a changed manifest after the first Git metadata Blob, before more Git mutations", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const originalCreate = f.github.createGitBlob
  let changed = false
  f.github.createGitBlob = async bytes => {
    const sha = await originalCreate(bytes)
    if (!changed) {
      changed = true
      f.input.staged.records[0] = {
        ...f.input.staged.records[0]!, plaintextSha256: "f".repeat(64),
      }
    }
    return sha
  }
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal, wal: j.wal,
  }), /candidate inputs or WAL intent changed/i)
  assert.equal(changed, true)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
  assert.equal(f.calls.filter(c => c === "tree-create" || c === "commit-create" || c === "ref-create").length, 0)
  assert.match((await j.open().load())?.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
})

test("D111 lost response AFTER Git metadata Blob upload never retries candidate creation after restart", async () => {
  const f = await fixture()
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  const originalCreate = f.github.createGitBlob
  let threw = false
  f.github.createGitBlob = async bytes => {
    const sha = await originalCreate(bytes)
    if (!threw) {
      threw = true
      throw new Error("GitHub 503 lost after metadata blob creation")
    }
    return sha
  }
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.journal, wal: j.wal,
  }), /503 lost/i)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
  assert.equal(f.calls.filter(c => c === "tree-create" || c === "commit-create" || c === "ref-create").length, 0)
  const interrupted = await j.open().load()
  assert.ok(interrupted)
  assert.match(interrupted.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u)
  assert.equal(interrupted.permissionToPublish, false)
  assert.equal(interrupted.cutoverAuthorized, false)
  await assert.rejects(() => prepareV4JournaledOrphanCandidate({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /one-shot preparation/i)
  assert.equal(f.calls.filter(c => c === "blob-create").length, 1)
})

test("D111 publishing Destination refuses an unsealed candidate even when ref and content match", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, false)
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal, wal: j.wal,
  }), /sealed candidate preparation/i)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 0)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
})

test("D102 WAL-bound 3-branch publication requires persisted blob receipts and records verified Destination ref", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const result = await publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal, wal: j.wal,
  })
  assert.equal(result.destinationContentsReadbackVerified, true)
  assert.equal(result.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  const restarted = await j.open().load()
  assert.ok(restarted)
  assert.deepEqual(restarted.verifiedRefObservations, [
    {
      role: "backup",
      repoId: D100backupPlan.backupRepoId,
      commitSha: sourceSha, treeSha: sourceTreeSha,
    },
    {
      role: "destination",
      repoId: targetId,
      commitSha: candidateSha,
      treeSha: candidateTreeSha,
      manifestSha256: D110manifestDigest(f, prepared),
    },
  ])
  assert.equal(restarted.pendingRefIntents.length, 0)
  assert.equal(restarted.cutoverAuthorized, false)
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.open(), wal: j.wal,
  }), /previous ref intent|unresolved mutations|previous/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
})

test("D169 best-effort Destination publication writes one ref only after authenticated WAL and full new-key readback", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const input = {
    ...D100input(f, prepared), journal: j.journal,
    wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  }
  const result = await publishV4BestEffortJournaledThreeBranchDestination(input)
  assert.equal(result.destinationContentsReadbackVerified, true)
  assert.equal(result.backupScratchRoundTripVerified, true)
  assert.equal(result.verifiedFileCount, 1)
  assert.equal(result.powerLossDurabilityIndependentlyAudited, false)
  assert.equal(result.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  const state = await j.open().load()
  assert.ok(state)
  assert.equal(state.pendingRefIntents.length, 0)
  assert.deepEqual(state.verifiedRefObservations[1], {
    role: "destination", repoId: targetId, commitSha: candidateSha,
    treeSha: candidateTreeSha, manifestSha256: D110manifestDigest(f, prepared),
  })
  assert.equal(state.cutoverAuthorized, false)
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination({
    ...input, journal: j.open(),
  }), /previous|unresolved|Manual Recovery/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
})

test("D169 missing risk acknowledgement denies Destination publication before WAL and network I/O", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  let checks = 0
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal,
    wal: {
      async assertExclusiveStageLease() { checks++ },
      async assertBestEffortCheckpoint() {
        checks++
        return "best-effort-readback-only" as const
      },
    },
    acknowledgement: "declined" as typeof d168RiskAcknowledgement,
  }), /risk acknowledgement/i)
  assert.equal(checks, 0)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 0)
})

test("D169 damaged WAL after Destination ref intent stops before GitHub POST and preserves pending intent", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  let failed = false
  const input = {
    ...D100input(f, prepared), journal: j.journal, acknowledgement: d168RiskAcknowledgement,
    wal: {
      async assertExclusiveStageLease() {},
      async assertBestEffortCheckpoint() {
        if ((await j.journal.load())?.pendingRefIntents.length) {
          failed = true
          throw new Error("simulated unreadable WAL after Destination intent")
        }
        return "best-effort-readback-only" as const
      },
    },
  }
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination(input), /Manual Recovery/i)
  assert.equal(failed, true)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  const state = await j.open().load()
  assert.equal(state?.pendingRefIntents.length, 1)
  assert.equal(state?.cutoverAuthorized, false)
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination({
    ...input, journal: j.open(), wal: d168BestEffortWal(),
  }), /previous|unresolved|Manual Recovery/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
})

test("D169 lost Destination POST response recovers by full read-only GitHub verification without a second POST", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const originalRead = f.github.getGitRefOrNull
  const originalCreate = f.github.createGitRef
  f.github.createGitRef = async sha => {
    try { await originalCreate(sha) }
    finally {
      f.github.getGitRefOrNull = async () => { throw new Error("GitHub 503 after ref creation") }
    }
  }
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal,
    wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  }), /ambiguous|recovery|readback/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1)
  f.github.getGitRefOrNull = originalRead
  const report = await reconcileV4PendingOrphanWithJournalBestEffort({
    ...recoveryInput(f, prepared), backupPlan: D100backupPlan,
    backupRefReader: D100input(f, prepared).backupRefReader,
    verifiedOriginalSource: D103originalProof(f),
    journal: j.open(), wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  })
  assert.equal(report.destinationContentsVerified, true)
  assert.equal(report.verifiedFileCount, 1)
  assert.equal(report.automaticallyRetryCreateAuthorized, false)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  const recovered = await j.open().load()
  assert.equal(recovered?.pendingRefIntents.length, 0)
  assert.equal(recovered?.verifiedRefObservations.length, 2)
  assert.equal(recovered?.cutoverAuthorized, false)
})

test("D169 conflicted Destination ref during best-effort recovery preserves pending WAL and never rewrites GitHub", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const originalCreate = f.github.createGitRef
  f.github.createGitRef = async sha => {
    await originalCreate(sha)
    f.github.getGitRefOrNull = async () => { throw new Error("GitHub 503 prevents reconciliation") }
    throw new Error("simulated GitHub response loss")
  }
  await assert.rejects(() => publishV4BestEffortJournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal,
    wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  }), /ambiguous|recovery/i)
  f.occupyRef("f".repeat(40))
  f.github.getGitRefOrNull = async () => ({
    ref: "refs/heads/rekey/new-branch", type: "commit", sha: "f".repeat(40),
  })
  await assert.rejects(() => reconcileV4PendingOrphanWithJournalBestEffort({
    ...recoveryInput(f, prepared), backupPlan: D100backupPlan,
    backupRefReader: D100input(f, prepared).backupRefReader,
    verifiedOriginalSource: D103originalProof(f),
    journal: j.open(), wal: d168BestEffortWal(), acknowledgement: d168RiskAcknowledgement,
  }), /missing|conflicting|incomplete/i)
  const state = await j.open().load()
  assert.equal(state?.pendingRefIntents.length, 1)
  assert.equal(state?.verifiedRefObservations.length, 1)
  assert.equal(state?.cutoverAuthorized, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
})

test("D169 real Windows WAL permits exact best-effort Destination ref publication and preserves local cutover denial", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d169-publish-wal-"))
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: root, journalRoot: "v4/rekey-destination",
    })
    try {
      const f = await fixture()
      const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: storage.adapter, root: "v4/rekey-destination",
        destinationRepoId: targetId, sourceCommitSha: sourceSha,
        runId: "d169-publish-run", journalKey: new Uint8Array(32).fill(0x36),
      })
      let state = await journal.begin()
      const backup = {
        role: "backup" as const, repoId: D100backupPlan.backupRepoId,
        commitSha: sourceSha, treeSha: sourceTreeSha,
      }
      state = await journal.recordRefIntent(backup, state.generation)
      state = await journal.markRefReadbackObserved(backup, state.generation)
      state = await journal.recordStagingHandoff(backup, state.generation)
      for (const receipt of f.input.staged.receipts) {
        state = await journal.recordUploadIntent(receipt, state.generation)
        state = await journal.appendReceipt(receipt, state.generation)
      }
      state = await journal.recordCandidatePreparationIntent(
        computeV4ReencryptionPreparationDigest({
          sourceCommitSha: sourceSha, sourceTreeSha, destinationRepoId: targetId,
          destinationConfig: f.input.destinationConfig, sourceConfig: f.input.sourceConfig,
          deviceId: prepared.deviceId, journalId: prepared.journalId,
          createdAt: prepared.createdAt,
          expectedRecords: f.input.staged.records, expectedReceipts: f.input.staged.receipts,
        }), state.generation)
      state = await journal.recordPreparedCandidateReceipt({
        commitSha: prepared.commitSha, treeSha: prepared.treeSha,
        manifestSha256: D110manifestDigest(f, prepared),
      }, state.generation)
      const report = await publishV4BestEffortJournaledThreeBranchDestination({
        ...D100input(f, prepared), journal, wal: storage,
        acknowledgement: d168RiskAcknowledgement,
      })
      assert.equal(report.destinationContentsReadbackVerified, true)
      assert.equal(report.initiatingDeviceCutoverAuthorized, false)
      assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
      const saved = await journal.assertHealthySnapshot(state.generation + 2)
      assert.equal(saved.pendingRefIntents.length, 0)
      assert.equal(saved.verifiedRefObservations.length, 2)
      assert.equal(saved.cutoverAuthorized, false)
    } finally { await storage.release() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("D124 WAL coordinator pins source parity before writing the one-shot Destination ref intent", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records,
    f.input.destinationConfig, true, prepared)
  const input = D100input(f, prepared)
  const evidence = input.initiatorLocalParity.sourceRecords.map(r => ({ ...r }))
  const original = utf8ToBytes("Vault has real encrypted content")
  const changed = utf8ToBytes("Z".repeat(original.length))
  const changedSha = await sha256Hex(changed)
  let currentBytes: Uint8Array = original
  let intentWritten = false
  const reader = {
    ...input.initiatorLocalParity.reader,
    async openFile(_path: string) {
      const bytes = currentBytes
      return {
        size: bytes.length,
        async *chunks() { yield bytes },
      }
    },
  }
  const journal = {
    ...j.journal,
    async recordRefIntent(...args: Parameters<typeof j.journal.recordRefIntent>) {
      const result = await j.journal.recordRefIntent(...args)
      // The authenticated WAL intent was just persisted; there is now an
      // async gap before D100's first parity readback.
      intentWritten = true
      currentBytes = changed
      evidence[0]!.plaintextSha256 = changedSha
      return result
    },
  }
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...input, journal,
    wal: j.wal,
    initiatorLocalParity: { ...input.initiatorLocalParity, sourceRecords: evidence, reader },
  }), /SHA-256|source|parity|changed|authenticated/i)
  assert.equal(intentWritten, true)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 0)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1,
    "once written, the one-shot intent is preserved for operator recovery")
})

test("D125 WAL coordinator refuses changed candidate identity before GitHub ref creation", async () => {
  const f = await fixture()
  const sealed = await prepareV4ReencryptionOrphanCommit(f.input)
  const candidate = { ...sealed }
  const j = await D102DestinationJournal(f.input.staged.receipts,
    f.input.staged.records, f.input.destinationConfig, true, sealed)
  const originalGetCommit = f.github.getGitCommit
  let gitCommitVerified = false
  f.github.getGitCommit = async sha => {
    gitCommitVerified = true
    return originalGetCommit(sha)
  }
  let changedDuringWalRead = false
  const journal = {
    ...j.journal,
    async assertHealthySnapshot(...args: Parameters<typeof j.journal.assertHealthySnapshot>) {
      const result = await j.journal.assertHealthySnapshot(...args)
      if (gitCommitVerified && !changedDuringWalRead) {
        changedDuringWalRead = true
        candidate.commitSha = "e".repeat(40)
      }
      return result
    },
  }
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, candidate), journal, wal: j.wal,
  }), /candidate|changed|commit|intent/i)
  assert.equal(gitCommitVerified, true)
  assert.equal(changedDuringWalRead, true)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0,
    "even a persisted, healthy WAL cannot justify posting a different candidate SHA")
  const pending = await j.open().load()
  assert.ok(pending)
  assert.equal(pending.pendingRefIntents.length, 1,
    "failed publication must retain the one-shot WAL intent for manual recovery")
})

test("D102 refuses Destination mutation if encrypted WAL is missing even one staged object receipt", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal([], f.input.staged.records, f.input.destinationConfig, false)
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal, wal: j.wal,
  }), /staged blob receipts/i)
  assert.equal((await j.journal.load())?.pendingRefIntents.length, 0)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
})

test("D102 fails closed for unsupported Windows WAL durability before Destination ref intent", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal,
    wal: {
      ...j.wal,
      assertCrashDurable: async () => { throw new Error("Node directory fsync EPERM") },
    },
  }), /fsync EPERM/i)
  assert.deepEqual((await j.journal.load())?.pendingRefIntents, [])
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
})

test("D102 ambiguous Destination network result with unreadable GitHub leaves exact pending WAL for manual recovery", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const original = f.github.createGitRef
  f.github.createGitRef = async sha => {
    try { await original(sha) }
    finally {
      f.github.getGitRefOrNull = async () => { throw new Error("GitHub 503 unavailable after create") }
    }
  }
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal, wal: j.wal,
  }), /ambiguous|readback|recovery/i)
  const pending = await j.open().load()
  assert.ok(pending)
  assert.deepEqual(pending.pendingRefIntents, [{
    role: "destination", repoId: targetId,
    commitSha: candidateSha, treeSha: candidateTreeSha,
    manifestSha256: D110manifestDigest(f, prepared),
  }])
  assert.equal(pending.requiresRemoteRevalidation, true)
  assert.equal(pending.permissionToPublish, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
})

function D103originalProof(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    integrityScope: "all-live-objects" as const,
    pinnedSourceCommitSha: sourceSha,
    verifiedFileCount: f.input.staged.records.length,
    verifiedRemoteObjectCount: f.input.staged.receipts.length,
    totalVerifiedPlaintextBytes: f.input.staged.preview.totalPlaintextBytes,
  }
}

test("D103 Destination lost POST/GET recovered after restart by read-only Git+new-key full verification", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  const originalGet = f.github.getGitRefOrNull
  const originalCreate = f.github.createGitRef
  f.github.createGitRef = async sha => {
    try { await originalCreate(sha) }
    finally {
      f.github.getGitRefOrNull = async () => { throw new Error("GitHub 503 unreadable ref after POST") }
    }
  }
  await assert.rejects(() => publishV4JournaledThreeBranchDestination({
    ...D100input(f, prepared), journal: j.journal, wal: j.wal,
  }), /ambiguous|recovery|readback/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1)
  f.github.getGitRefOrNull = originalGet
  const backupReader = D100input(f, prepared).backupRefReader
  const report = await reconcileV4PendingOrphanWithJournal({
    ...recoveryInput(f, prepared),
    backupPlan: D100backupPlan,
    backupRefReader: backupReader,
    verifiedOriginalSource: D103originalProof(f),
    journal: j.open(), wal: j.wal,
  })
  assert.equal(report.destinationContentsVerified, true)
  assert.equal(report.verifiedFileCount, 1)
  assert.equal(report.automaticallyRetryCreateAuthorized, false)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 1)
  const recovered = await j.open().load()
  assert.ok(recovered)
  assert.equal(recovered.pendingRefIntents.length, 0)
  assert.equal(recovered.verifiedRefObservations.length, 2)
  assert.equal(recovered.permissionToPublish, false)
  await assert.rejects(() => reconcileV4PendingOrphanWithJournal({
    ...recoveryInput(f, prepared), backupPlan: D100backupPlan,
    backupRefReader: backupReader, verifiedOriginalSource: D103originalProof(f),
    journal: j.open(), wal: j.wal,
  }), /exact pending Destination intent/i)
})

test("D103 incomplete/moved Destination readback keeps WAL pending and never retries GitHub POST", async () => {
  const f = await fixture()
  const prepared = await prepareV4ReencryptionOrphanCommit(f.input)
  const j = await D102DestinationJournal(f.input.staged.receipts, f.input.staged.records, f.input.destinationConfig, true, prepared)
  let state = (await j.journal.load())!
  state = await j.journal.recordRefIntent({
    role: "destination", repoId: targetId,
    commitSha: candidateSha, treeSha: candidateTreeSha,
    manifestSha256: D110manifestDigest(f, prepared),
  }, state.generation)
  f.occupyRef(sourceSha) // Different commit has claimed the destination name
  await assert.rejects(() => reconcileV4PendingOrphanWithJournal({
    ...recoveryInput(f, prepared), backupPlan: D100backupPlan,
    backupRefReader: D100input(f, prepared).backupRefReader,
    verifiedOriginalSource: D103originalProof(f),
    journal: j.journal, wal: j.wal,
  }), /missing|conflicting|incomplete/i)
  assert.equal(f.calls.filter(c => c === "ref-create").length, 0)
  assert.equal((await j.journal.load())?.pendingRefIntents.length, 1)
})

test("D96 refuses remote ref collision, wrong repository, missing backup proof and staged SHA mismatch before any mutation", async () => {
  const tests = [
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => f.occupyRef() },
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => f.markWrongRepo() },
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => { f.input.verifiedBackup = {
      ...f.input.verifiedBackup, verifiedFileCount: 5,
    } } },
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => { f.input.staged = {
      ...f.input.staged,
      receipts: f.input.staged.receipts.map(x => ({ ...x, sha: "f".repeat(40), path: "outside" })),
    } } },
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => { f.input.verifiedBackup = {
      ...f.input.verifiedBackup, pinnedSourceTreeSha: "f".repeat(40),
    } } },
    { modify: (f: Awaited<ReturnType<typeof fixture>>) => { f.input.verifiedBackup = {
      ...f.input.verifiedBackup, backupRepoId: plan.destinationRepoId,
    } } },
  ]
  for (const item of tests) {
    const f = await fixture()
    item.modify(f)
    await assert.rejects(() => prepareV4ReencryptionOrphanCommit(f.input))
    assert.equal(f.mutationCount, 0)
  }
})

test("D96 aborts publication before mutation when durable-intent step refuses it", async () => {
  const f = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(f.input)
  const before = f.mutationCount
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => { throw new Error("Durability unproven") },
  }), /Durability unproven/)
  assert.equal(f.mutationCount, before)
  assert.ok(!f.calls.includes("ref-create"))
})

test("D96 refuses an orphan root with parents, and ambiguous create-ref is NEVER retried", async () => {
  const invalid = await fixture()
  invalid.markWrongCommitParents()
  await assert.rejects(() => prepareV4ReencryptionOrphanCommit(invalid.input), /zero parents|orphan|root/i)
  assert.ok(!invalid.calls.includes("ref-create"))

  const f = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(f.input)
  f.loseCreateResponse()
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }), /response lost/i)
  assert.equal(f.calls.filter(x => x === "ref-create").length, 1)
})

test("D96 publication refuses occupied ref and unexpected read error rather than overwriting", async () => {
  const f = await fixture()
  const candidate = await prepareV4ReencryptionOrphanCommit(f.input)
  f.occupyRef()
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: f.github, plan, prepared: candidate,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }), /present|exists|overwrit/i)
  assert.ok(!f.calls.includes("ref-create"))
  const another = await fixture()
  const prep = await prepareV4ReencryptionOrphanCommit(another.input)
  another.failRefReads()
  await assert.rejects(() => publishV4ReencryptionOrphanRef({
    github: another.github, plan, prepared: prep,
    assertExclusiveMigrationLease: async () => {},
    assertDurablePublicationIntent: async () => {},
  }), /503/)
  assert.ok(!another.calls.includes("ref-create"))
})
