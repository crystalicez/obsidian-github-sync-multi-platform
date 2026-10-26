import assert from "node:assert/strict"
import test from "node:test"

import {
  V4_OWNER_REENCRYPTION_DECISIONS,
  proposeV4SameRepositoryReencryptionBackupBranch,
} from "../../src/lib/v4/reencryption-owner-decisions"

const options = {
  sourceRepoId: "owner/repo#main",
  destinationRepoId: "owner/repo#rekey/new",
  backupRepoId: "owner/repo#backup/rekey-old",
  pinnedSourceCommitSha: "a".repeat(40),
  sourcePhysicalRepositoryId: 112,
  destinationPhysicalRepositoryId: 112,
  backupPhysicalRepositoryId: 112,
  expectedPhysicalRepositoryId: 112,
  defaultBranch: "main",
}

test("D87 records all six owner answers verbatim without treating in-repo copy as independent", () => {
  const policy = V4_OWNER_REENCRYPTION_DECISIONS
  assert.equal(policy.oldBranchSync, "pause-all-old-branch-devices")
  assert.equal(policy.vaultEditing, "pause-during-migration")
  assert.equal(policy.backup, "separate-branch-in-original-github-repository")
  assert.equal(policy.backupArchivePassword, "not-applicable")
  assert.equal(policy.desktopWal, "nodejs-only-no-native-helper")
  assert.equal(policy.oldBranchRetention, "delete-only-after-explicit-user-action")
  assert.equal(policy.independentBackupProvidedByChoiceC, false)
  assert.equal(policy.automaticCutoverAuthorized, false)
  assert.ok(Object.isFrozen(policy))
})

test("D87 backup branch proposal binds exactly the original physical repository and pinned source", () => {
  const plan = proposeV4SameRepositoryReencryptionBackupBranch(options)
  assert.deepEqual(plan, {
    proof: "owner-approved-same-repo-backup-topology-only",
    status: "blocked-pending-safe-backup-ref-implementation",
    backupRepoId: options.backupRepoId,
    sourceRepoId: options.sourceRepoId,
    destinationRepoId: options.destinationRepoId,
    pinnedSourceCommitSha: options.pinnedSourceCommitSha,
    physicalRepositoryId: 112,
    backupBranch: "backup/rekey-old",
    independentStorageVerified: false,
    actualBackupCreated: false,
    backupReadbackVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    oldBranchDeletionAuthorized: false,
  })
  assert.ok(Object.isFrozen(plan))
})

test("D87 disallows a same-repository backup branch that conflicts with source/destination/default", () => {
  for (const branch of ["main", "rekey/new", ".hidden", "backup/..", "backup/a.lock", "backup//a"]) {
    assert.throws(() => proposeV4SameRepositoryReencryptionBackupBranch({
      ...options, backupRepoId: "owner/repo#" + branch,
    }), /branch|invalid|distinct|default/i, branch)
  }
})

test("D87 must never propose the DEFAULT branch as a re-encryption destination", () => {
  assert.throws(() => proposeV4SameRepositoryReencryptionBackupBranch({
    ...options,
    destinationRepoId: "owner/repo#main",
    sourceRepoId: "owner/repo#source",
  }), /destination|default|branch/i)
})

test("D87 refuses backup on a different repository or a wrong numeric physical repo identity", () => {
  for (const difference of [
    { backupRepoId: "owner/other#backup/rekey" },
    { backupRepoId: "other/repo#backup/rekey" },
    { backupPhysicalRepositoryId: 113 },
    { expectedPhysicalRepositoryId: 113 },
    { sourcePhysicalRepositoryId: 113 },
    { destinationPhysicalRepositoryId: 113 },
  ]) {
    assert.throws(() => proposeV4SameRepositoryReencryptionBackupBranch({
      ...options, ...difference,
    }), /repository|physical|identity|same/i)
  }
})

test("D87 refuses malformed/unpinned source commit and invalid original branch coordinates", () => {
  for (const invalid of [
    { pinnedSourceCommitSha: "HEAD" },
    { pinnedSourceCommitSha: "A".repeat(40) },
    { sourceRepoId: "owner/repo#bad..branch" },
    { destinationRepoId: "owner/repo#bad lock" },
  ]) {
    assert.throws(() => proposeV4SameRepositoryReencryptionBackupBranch({
      ...options, ...invalid,
    }), /SHA|branch|invalid/i)
  }
})

test("D87 in-repo backup proposal cannot be mistaken for independent recovery proof", () => {
  const policy = V4_OWNER_REENCRYPTION_DECISIONS
  const plan = proposeV4SameRepositoryReencryptionBackupBranch(options)
  assert.equal(policy.independentBackupProvidedByChoiceC, false)
  assert.equal(plan.independentStorageVerified, false)
  assert.equal(plan.backupReadbackVerified, false)
  assert.equal(plan.actualBackupCreated, false)
  assert.equal(plan.cutoverAuthorized, false)
  assert.equal(plan.oldBranchDeletionAuthorized, false)
})
