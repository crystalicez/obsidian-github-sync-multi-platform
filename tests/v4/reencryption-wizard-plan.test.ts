import assert from "node:assert/strict"
import test from "node:test"
import {
  proposeV4ReencryptionWizardDraft,
  suggestV4ReencryptionBranchNames,
} from "../../src/lib/v4/reencryption-wizard-plan"

const oldPassphrase = "super-secret-source-vault-passphrase"
const newPassphrase = "independently-new-secret"

const valid = Object.freeze({
  owner: "owner",
  repo: "vault",
  sourceBranch: "main",
  backupBranch: "backup/rekey-2026-10-26-aabbccdd",
  destinationBranch: "rekey/2026-10-26-aabbccdd",
  defaultBranch: "main",
  sourceCommitSha: "a".repeat(40),
  sourcePhysicalRepositoryId: 123456,
  requestedIterations: 600_000,
  oldPassphrase,
  newPassphrase,
  confirmation: newPassphrase,
})

test("D92 always proposes all THREE distinct same-repo branches, blocked from publication and cutover", () => {
  const result = proposeV4ReencryptionWizardDraft(valid)
  assert.deepEqual(result, {
    status: "blocked-pending-production-migration",
    sourceRepoId: "owner/vault#main",
    backupRepoId: valid.backupBranch.replace(/^/u, "owner/vault#"),
    destinationRepoId: valid.destinationBranch.replace(/^/u, "owner/vault#"),
    pinnedSourceCommitSha: valid.sourceCommitSha,
    physicalRepositoryId: 123456,
    requestedIterations: 600_000,
    destinationOrphan: true,
    sourceRemainsSyncable: true,
    otherDeviceCutover: "optional-manual",
    initiatorVaultChangeDetection: "cross-platform-best-effort",
    externalWritesPrevented: false,
    userConfirmation: "once-before-execution",
    initiatorCutover: "automatic-after-verified-crash-safe-completion",
    oldPassphraseLocalRetention: "clear-after-proven-durable-cutover",
    oldPassphraseRequiredForOldBranches: true,
    oldPassphraseCleanupAuthorized: false,
    sourceAndBackupRetained: true,
    actualBackupCreated: false,
    actualDestinationCreated: false,
    publicationAuthorized: false,
    localCutoverAuthorized: false,
  })
  assert.ok(Object.isFrozen(result))
  assert.ok(!JSON.stringify(result).includes(newPassphrase))
  assert.ok(!JSON.stringify(result).includes(oldPassphrase))
})

test("D92 suggests stable safe names from date and source SHA without claiming an unused ref", () => {
  assert.deepEqual(suggestV4ReencryptionBranchNames(new Date("2026-10-26T03:50:00.000Z"), "b".repeat(40)), {
    destinationBranch: "rekey/2026-10-26-bbbbbbbb",
    backupBranch: "backup/rekey-2026-10-26-bbbbbbbb",
  })
  assert.throws(() => suggestV4ReencryptionBranchNames(new Date(Number.NaN), "b".repeat(40)), /date/i)
  assert.throws(() => suggestV4ReencryptionBranchNames(new Date(), "HEAD"), /commit/i)
})

test("D92 rejects in-place, default-branch and overlapping destination/backup", () => {
  for (const changed of [
    { destinationBranch: "main" },
    { destinationBranch: "main", sourceBranch: "old" },
    { backupBranch: "main" },
    { backupBranch: valid.destinationBranch },
    { destinationBranch: valid.backupBranch },
    { destinationBranch: "rekey//oops" },
    { backupBranch: "backup/../oops" },
    { destinationBranch: "@{" },
  ]) {
    assert.throws(() => proposeV4ReencryptionWizardDraft({ ...valid, ...changed }), /branch|default|distinct|different/i)
  }
})

test("D92 rejects bad repository coordinates and unverified physical GitHub identity", () => {
  for (const changed of [
    { owner: "bad owner" },
    { repo: "bad/repo" },
    { sourcePhysicalRepositoryId: 0 },
    { sourcePhysicalRepositoryId: -1 },
    { sourcePhysicalRepositoryId: Number.NaN },
    { sourceCommitSha: "HEAD" },
    { sourceCommitSha: "C".repeat(40) },
  ]) {
    assert.throws(() => proposeV4ReencryptionWizardDraft({ ...valid, ...changed }), /invalid|SHA|physical|repository|branch/i)
  }
})

test("D92 rejects empty, unequal and reused passphrases without echoing secrets", () => {
  const bads = [
    { newPassphrase: "", confirmation: "" },
    { newPassphrase, confirmation: "wrong" },
    { newPassphrase: oldPassphrase, confirmation: oldPassphrase },
    { oldPassphrase: "" },
  ]
  for (const changed of bads) {
    assert.throws(() => proposeV4ReencryptionWizardDraft({ ...valid, ...changed }), /passphrase/i)
  }
})

test("D92 enforces existing PBKDF2 new-repository bounds", () => {
  for (const iterations of [0, 1, 599_999, 1_200_001, 600_000.5, Number.NaN]) {
    assert.throws(() => proposeV4ReencryptionWizardDraft({
      ...valid, requestedIterations: iterations,
    }), /PBKDF2/i)
  }
  assert.equal(proposeV4ReencryptionWizardDraft({
    ...valid, requestedIterations: 1_200_000,
  }).requestedIterations, 1_200_000)
})
