import assert from "node:assert/strict"
import test from "node:test"

import {
  proposeV4SameRepositoryReencryptionBackupBranch,
} from "../../src/lib/v4/reencryption-owner-decisions"
import {
  inspectV4SameRepositoryBackupRef,
} from "../../src/lib/v4/reencryption-backup-ref-readback"

const sourceCommitSha = "a".repeat(40)
const sourceTreeSha = "b".repeat(40)
const proposal = proposeV4SameRepositoryReencryptionBackupBranch({
  sourceRepoId: "owner/repo#main",
  destinationRepoId: "owner/repo#rekey/new",
  backupRepoId: "owner/repo#backup/old-encrypted",
  pinnedSourceCommitSha: sourceCommitSha,
  sourcePhysicalRepositoryId: 901,
  destinationPhysicalRepositoryId: 901,
  backupPhysicalRepositoryId: 901,
  expectedPhysicalRepositoryId: 901,
  defaultBranch: "main",
})

type Ref = { ref: string; sha: string; type: string }
type Commit = { sha: string; treeSha: string; parentShas: string[] }

function fixture() {
  const sourceRefs: Ref[] = [
    { ref: "refs/heads/main", sha: sourceCommitSha, type: "commit" },
    { ref: "refs/heads/main", sha: sourceCommitSha, type: "commit" },
  ]
  const backupRefs: Ref[] = [
    { ref: "refs/heads/backup/old-encrypted", sha: sourceCommitSha, type: "commit" },
    { ref: "refs/heads/backup/old-encrypted", sha: sourceCommitSha, type: "commit" },
  ]
  const calls: string[] = []
  const repo = { id: 901, fullName: "owner/repo" }
  const commit: Commit = { sha: sourceCommitSha, treeSha: sourceTreeSha, parentShas: ["c".repeat(40)] }
  let sourceRefIndex = 0
  let backupRefIndex = 0
  const source = {
    branchName: "main",
    async getRepositoryIdentity() { calls.push("source:identity"); return repo },
    async getGitRef() { calls.push("source:ref"); return sourceRefs[Math.min(sourceRefIndex++, sourceRefs.length - 1)]! },
    async getGitCommit(_sha: string) { calls.push("source:commit"); return commit },
  }
  const backup = {
    branchName: "backup/old-encrypted",
    async getRepositoryIdentity() { calls.push("backup:identity"); return repo },
    async getGitRef() { calls.push("backup:ref"); return backupRefs[Math.min(backupRefIndex++, backupRefs.length - 1)]! },
    async getGitCommit(_sha: string) { calls.push("backup:commit"); return commit },
  }
  return { source, backup, repo, commit, sourceRefs, backupRefs, calls }
}

function inspect(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  return inspectV4SameRepositoryBackupRef({
    plan: proposal, expectedSourceTreeSha: sourceTreeSha,
    source: f.source, backup: f.backup, signal,
  })
}

test("D89 only proves same-repo backup ref pinned to the exact authenticated source commit/tree", async () => {
  const f = fixture()
  const result = await inspect(f)
  assert.deepEqual(result, {
    integrityScope: "same-repository-frozen-backup-ref-pointer-only",
    backupRepoId: proposal.backupRepoId,
    pinnedSourceCommitSha: sourceCommitSha,
    pinnedSourceTreeSha: sourceTreeSha,
    backupRefPinnedToSourceSnapshot: true,
    sourceRefReadable: true,
    sourceBranchMayAdvanceIndependently: true,
    backupCreationProven: false,
    backupContentsReadbackVerified: false,
    independentStorageVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    oldBranchDeletionAuthorized: false,
  })
  assert.ok(Object.isFrozen(result))
  assert.deepEqual(f.calls, [
    "source:identity", "backup:identity", "source:ref", "backup:ref",
    "source:commit", "backup:commit",
    "source:ref", "backup:ref", "source:identity", "backup:identity",
  ])
})

test("D89 refuses physical repo or owner/repo identity mismatch", async () => {
  for (const repo of [{ id: 902, fullName: "owner/repo" }, { id: 901, fullName: "owner/other" }]) {
    const f = fixture()
    Object.assign(f.repo, repo)
    await assert.rejects(inspect(f), /repository identity/i)
  }
})

test("D94 rejects malformed/wrong-branch source and any wrong backup ref", async () => {
  for (const key of ["sourceRefs", "backupRefs"] as const) {
    const changes = [
      { ref: "refs/heads/unexpected" },
      { sha: "HEAD" }, { type: "tree" }, { ref: "" },
      ...(key === "backupRefs" ? [{ sha: "d".repeat(40) }] : []),
    ]
    for (const change of changes) {
      const f = fixture()
      Object.assign(f[key][0]!, change)
      await assert.rejects(inspect(f), /ref|commit/i)
    }
  }
})

test("D94 detects frozen backup pointer drift while permitting old source HEAD drift", async () => {
  const backupDrift = fixture()
  backupDrift.backupRefs[1] = { ...backupDrift.backupRefs[1]!, sha: "d".repeat(40) }
  await assert.rejects(inspect(backupDrift), /ref|changed/i)

  const oldBranchAdvanced = fixture()
  oldBranchAdvanced.sourceRefs[0] = { ...oldBranchAdvanced.sourceRefs[0]!, sha: "d".repeat(40) }
  oldBranchAdvanced.sourceRefs[1] = { ...oldBranchAdvanced.sourceRefs[1]!, sha: "e".repeat(40) }
  const result = await inspect(oldBranchAdvanced)
  assert.equal(result.backupRefPinnedToSourceSnapshot, true)
  assert.equal(result.sourceBranchMayAdvanceIndependently, true)
})

test("D89 checks immutable commit identity and tree on both clients", async () => {
  for (const side of ["source", "backup"] as const) {
    for (const field of ["sha", "treeSha", "parentShas"] as const) {
      const f = fixture()
      const altered = field === "parentShas"
        ? { ...f.commit, parentShas: ["e".repeat(40)] }
        : { ...f.commit, [field]: "f".repeat(40) }
      f[side].getGitCommit = async () => altered
      await assert.rejects(inspect(f), /commit|tree|ancestry/i, side + ":" + field)
    }
  }
})

test("D89 aborts and propagates uncertain GitHub read failure without granting backup proof", async () => {
  const f = fixture()
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(inspect(f, ctrl.signal))
  assert.deepEqual(f.calls, [])
  const other = fixture()
  other.backup.getGitRef = async () => { throw new Error("GitHub 503") }
  await assert.rejects(inspect(other), /503/)
})

test("D89 catches physical identity drift after both Git refs and commits were checked", async () => {
  const f = fixture()
  let checks = 0
  f.backup.getRepositoryIdentity = async () => ++checks === 1
    ? { id: 901, fullName: "owner/repo" }
    : { id: 902, fullName: "owner/repo" }
  await assert.rejects(inspect(f), /repository identity/i)
  assert.equal(checks, 2)
})

test("D89 checks AbortSignal again immediately after remote read", async () => {
  const f = fixture()
  const controller = new AbortController()
  const first = f.source.getGitRef
  f.source.getGitRef = async () => { const value = await first(); controller.abort(); return value }
  await assert.rejects(inspect(f, controller.signal))
  assert.deepEqual(f.calls.slice(-1), ["source:ref"])
})

test("D89 rejects forged backup branch bindings before network reads", async () => {
  const f = fixture()
  await assert.rejects(inspectV4SameRepositoryBackupRef({
    plan: { ...proposal, backupBranch: "backup/another" },
    expectedSourceTreeSha: sourceTreeSha, source: f.source, backup: f.backup,
  }), /branch identity/i)
  assert.deepEqual(f.calls, [])
})

test("D89 rejects invalid or forged preflight plan, wrong expected tree", async () => {
  const f = fixture()
  await assert.rejects(inspectV4SameRepositoryBackupRef({
    plan: { ...proposal, status: "allowed" } as unknown as typeof proposal,
    expectedSourceTreeSha: sourceTreeSha, source: f.source, backup: f.backup,
  }), /plan|approved/i)
  await assert.rejects(inspectV4SameRepositoryBackupRef({
    plan: proposal, expectedSourceTreeSha: "short", source: f.source, backup: f.backup,
  }), /tree|SHA/i)
})
