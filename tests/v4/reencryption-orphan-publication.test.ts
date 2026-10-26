import assert from "node:assert/strict"
import test from "node:test"
import { toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import {
  prepareV4ReencryptionOrphanCommit,
  publishV4ReencryptionOrphanRef,
} from "../../src/lib/v4/reencryption-orphan-publication"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { verifyV4ReencryptionDestinationExactCommit } from "../../src/lib/v4/reencryption-destination-exact-commit"
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
