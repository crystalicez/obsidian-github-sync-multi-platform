import assert from "node:assert/strict"
import test from "node:test"

import { proposeV4SameRepositoryReencryptionBackupBranch } from "../../src/lib/v4/reencryption-owner-decisions"
import { createV4FrozenSameRepositoryBackupRef } from "../../src/lib/v4/reencryption-frozen-backup-ref"

const sourceSha = "a".repeat(40)
const treeSha = "b".repeat(40)
const parentSha = "c".repeat(40)
const proposal = proposeV4SameRepositoryReencryptionBackupBranch({
  sourceRepoId: "owner/vault#main",
  backupRepoId: "owner/vault#backup/frozen-snapshot",
  destinationRepoId: "owner/vault#rekey/new",
  pinnedSourceCommitSha: sourceSha,
  sourcePhysicalRepositoryId: 77,
  backupPhysicalRepositoryId: 77,
  destinationPhysicalRepositoryId: 77,
  expectedPhysicalRepositoryId: 77,
  defaultBranch: "main",
})

const sourceProof = Object.freeze({
  integrityScope: "all-live-objects" as const,
  pinnedSourceCommitSha: sourceSha,
  verifiedFileCount: 3,
  verifiedRemoteObjectCount: 3,
  totalVerifiedPlaintextBytes: "123",
})

function fixture() {
  const calls: string[] = []
  const data = {
    created: false,
    existence: false,
    wrongPostRef: false,
    wrongRepo: false,
    wrongSourceCommit: false,
    wrongBackupCommit: false,
    wrongDefault: false,
    outcomeUnknown: false,
  }
  const identity = () => ({ id: data.wrongRepo ? 78 : 77, fullName: "owner/vault" })
  const source = {
    branchName: "main",
    async getRepositoryIdentity() { calls.push("source:repo"); return identity() },
    async getRepositoryDefaultBranch() { calls.push("source:default"); return data.wrongDefault ? "rekey/new" : "main" },
    async getGitCommit(_sha: string) {
      calls.push("source:commit")
      return { sha: sourceSha, treeSha: data.wrongSourceCommit ? "d".repeat(40) : treeSha, parentShas: [parentSha] }
    },
  }
  const backup = {
    branchName: "backup/frozen-snapshot",
    async getRepositoryIdentity() { calls.push("backup:repo"); return identity() },
    async getRepositoryDefaultBranch() { calls.push("backup:default"); return "main" },
    async getGitCommit(_sha: string) {
      calls.push("backup:commit")
      return { sha: sourceSha, treeSha: data.wrongBackupCommit ? "d".repeat(40) : treeSha, parentShas: [parentSha] }
    },
    async getGitRefOrNull() {
      calls.push("backup:ref")
      return data.created || data.existence
        ? { ref: data.wrongPostRef ? "refs/heads/other" : "refs/heads/backup/frozen-snapshot", sha: sourceSha, type: "commit" }
        : null
    },
    async createGitRef(sha: string) {
      calls.push("backup:create")
      assert.equal(sha, sourceSha)
      assert.equal(data.created, false)
      data.created = true
      if (data.outcomeUnknown) throw new Error("network outcome unknown")
    },
  }
  const run = (overrides: Record<string, unknown> = {}, signal?: AbortSignal) =>
    createV4FrozenSameRepositoryBackupRef({
      plan: proposal,
      source, backup,
      verifiedSource: sourceProof,
      expectedSourceTreeSha: treeSha,
      signal,
      ...overrides,
    })
  return { source, backup, calls, data, run }
}

test("D93 create-only backup pins authenticated immutable source SHA and proves ref pointer; never authorizes cutover", async () => {
  const f = fixture()
  const result = await f.run()
  assert.deepEqual(result, {
    integrityScope: "created-pinned-backup-ref-pointer-only",
    backupRepoId: proposal.backupRepoId,
    pinnedSourceCommitSha: sourceSha,
    pinnedSourceTreeSha: treeSha,
    backupRefCreatedAndReadBack: true,
    backupContentsReadbackVerified: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
    sourceBranchPreserved: true,
    oldBranchDeletionAuthorized: false,
  })
  assert.equal(f.calls.filter(x => x === "backup:create").length, 1)
  assert.deepEqual(f.calls, [
    "source:repo", "backup:repo", "source:default", "backup:default",
    "source:commit", "backup:ref", "backup:ref", "backup:create",
    "backup:ref", "backup:ref", "backup:commit",
    "source:repo", "backup:repo",
  ])
  assert.ok(Object.isFrozen(result))
})

test("D93 rejects forged or unverified migration evidence before any remote mutation/read", async () => {
  const values = [
    { verifiedSource: { ...sourceProof, pinnedSourceCommitSha: "d".repeat(40) } },
    { verifiedSource: { ...sourceProof, integrityScope: "untrusted" } },
    { verifiedSource: { ...sourceProof, totalVerifiedPlaintextBytes: "not a number" } },
    { plan: { ...proposal, permissionToPublish: true } },
    { plan: { ...proposal, status: "ready" } },
    { plan: { ...proposal, physicalRepositoryId: 0 } },
    { plan: { ...proposal, backupRepoId: "other/vault#backup/frozen-snapshot" } },
    { expectedSourceTreeSha: "HEAD" },
  ]
  for (const value of values) {
    const f = fixture()
    await assert.rejects(f.run(value), /backup|repository|source|tree|proposal|plan/i)
    assert.ok(!f.calls.includes("backup:create"), JSON.stringify(value))
  }
})

test("D93 refuses wrong branch-scoped source or backup clients before ANY remote read or write", async () => {
  for (const which of ["source", "backup"] as const) {
    const f = fixture()
    f[which].branchName = "unrelated"
    await assert.rejects(f.run(), /wrong source or backup branch/i)
    assert.deepEqual(f.calls, [])
  }
})

test("D93 rejects an existing frozen backup branch without modifying it", async () => {
  const f = fixture()
  f.data.existence = true
  await assert.rejects(f.run(), /already exists/i)
  assert.equal(f.calls.filter(c => c === "backup:create").length, 0)
})

test("D93 fails before writing for wrong repo, actual default branch drift or exact source commit mismatch", async () => {
  for (const flag of ["wrongRepo", "wrongDefault", "wrongSourceCommit"] as const) {
    const f = fixture()
    f.data[flag] = true
    await assert.rejects(f.run(), /repository|default|commit|tree/i)
    assert.ok(!f.calls.includes("backup:create"))
  }
})

test("D93 refuses an ambiguous create-ref response and never retries mutation", async () => {
  const f = fixture()
  f.data.outcomeUnknown = true
  await assert.rejects(f.run(), /unknown/)
  assert.equal(f.data.created, true)
  assert.equal(f.calls.filter(c => c === "backup:create").length, 1)
  assert.ok(!f.calls.includes("backup:commit"))
})

test("D93 refuses a mismatched post-publication ref or immutable commit; leaves source untouched", async () => {
  for (const flag of ["wrongPostRef", "wrongBackupCommit"] as const) {
    const f = fixture()
    f.data[flag] = true
    await assert.rejects(f.run(), /ref|commit|tree/i)
    assert.equal(f.calls.filter(c => c === "backup:create").length, 1)
  }
})

test("D93 cancellation before mutation never creates the backup; cancellation after mutation never grants proof", async () => {
  const f = fixture()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.run({}, abort.signal))
  assert.deepEqual(f.calls, [])

  const after = fixture()
  const later = new AbortController()
  const original = after.backup.createGitRef
  after.backup.createGitRef = async sha => { await original(sha); later.abort() }
  await assert.rejects(after.run({}, later.signal))
  assert.equal(after.calls.filter(c => c === "backup:create").length, 1)
  assert.ok(!after.calls.includes("backup:commit"))
})

test("D93 does not gate independent source-branch HEAD advances after pinned snapshot", async () => {
  const f = fixture()
  // No getGitRef() call to the source branch is part of the frozen pointer
  // creation contract. A new old-branch commit must not re-key its followers.
  await f.run()
  assert.ok(!f.calls.some(c => c === "source:ref"))
})
