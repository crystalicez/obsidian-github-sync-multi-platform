import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyV4ReencryptionManualRecovery,
  V4_MANUAL_RECOVERY_GUIDANCE,
  V4_MANUAL_RECOVERY_PREVIEW_CONDITIONS,
} from "../../src/lib/v4/reencryption-manual-recovery-triage"
import type { V4FencedCrashWindowPairReport } from "../../src/lib/v4/reencryption-fenced-crash-window-pair-inspection"
import type { V4FencedLivePersistedTestPairAndBackupReport } from "../../src/lib/v4/reencryption-fenced-live-persisted-test-pair-recovery"

const local = (
  overrides: Partial<V4FencedCrashWindowPairReport> = {},
): V4FencedCrashWindowPairReport => ({
  integrityScope: "read-only-fenced-post-crash-test-pair-window",
  evidence: "historical-d183-witness-and-best-effort-wal-readback-not-durable",
  observation: "manual-recovery-required",
  reason: "linked-test-pair-not-authoritative",
  artifactWindow: "pair-present",
  settingsSelection: "source",
  activeIndexSelection: "source",
  pairEvidence: "cryptographically-linked-uncommitted",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
  ...overrides,
})

const live = (
  overrides: Partial<V4FencedLivePersistedTestPairAndBackupReport> = {},
): V4FencedLivePersistedTestPairAndBackupReport => ({
  integrityScope: "read-only-restarted-test-pair-current-git-and-frozen-backup",
  evidence: "best-effort-wal-readback-not-power-loss-durable",
  observation: "manual-recovery-required",
  reason: "test-pair-and-full-remote-coherent-but-not-a-commit",
  historicalTestPairCryptographicallyLinked: true,
  fullDestinationContentReverifiedAfterRestart: true,
  fullBackupContentReverifiedAfterRestart: true,
  liveThreeBranchRefsReverifiedAfterRestart: true,
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
  ...overrides,
})

const forbidden = (result: ReturnType<typeof classifyV4ReencryptionManualRecovery>) => {
  assert.equal(result.integrityScope, "read-only-reencryption-manual-recovery-guidance")
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.liveRecoveryAuthorized, false)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.rollbackAuthorized, false)
  assert.equal(result.remoteWritesAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
  assert.ok(!/passphrase[-_]?value|token|api[_-]?key|secret value/iu.test(JSON.stringify(result)))
}

test("D222 exact source-prepared/no-pair observation is still a Manual Recovery guide", () => {
  const report = classifyV4ReencryptionManualRecovery(local({
    observation: "source-prepared-uncommitted",
    reason: "source-still-selected-no-pair",
    artifactWindow: "absent", pairEvidence: "absent",
  }))
  assert.equal(report.condition, "source-prepared-only")
  assert.match(report.nextReview, /Backup and Destination independently/)
  forbidden(report)
})

test("D222 interruption after directory, receipt or selector never allows automated retry or Resume", () => {
  for (const window of ["receipt-directory-only", "receipt-only", "selector-only"] as const) {
    const report = classifyV4ReencryptionManualRecovery(local({
      artifactWindow: window, pairEvidence: "unverifiable",
      reason: "partial-or-foreign-commit-artifacts",
    }), live())
    assert.equal(report.condition, "partial-local-artifacts", window)
    assert.match(report.nextReview, /Retain every partial file/)
    forbidden(report)
  }
})

test("D222 authentic test pair requires independent current full Git proof to distinguish verified vs uncertain", () => {
  const unverified = classifyV4ReencryptionManualRecovery(local(), null)
  assert.equal(unverified.condition, "linked-test-pair-current-git-unverified")
  forbidden(unverified)
  for (const variation of [
    { reason: "local-or-current-git-proof-uncertain" as const },
    { fullDestinationContentReverifiedAfterRestart: false },
    { fullBackupContentReverifiedAfterRestart: false },
    { liveThreeBranchRefsReverifiedAfterRestart: false },
    { historicalTestPairCryptographicallyLinked: false },
    { localCutoverAuthorized: true as false },
  ]) {
    const result = classifyV4ReencryptionManualRecovery(local(), live(variation))
    assert.equal(result.condition, "linked-test-pair-current-git-unverified", JSON.stringify(variation))
    forbidden(result)
  }
  const verified = classifyV4ReencryptionManualRecovery(local(), live())
  assert.equal(verified.condition, "linked-test-pair-current-git-verified-uncommitted")
  assert.match(verified.explanation, /NOT an authoritative Cutover/)
  forbidden(verified)
})

test("D222 destination-looking Settings/Index are never treated as committed, even when both agree", () => {
  for (const settings of ["source", "destination", "mixed"] as const) {
    for (const activeIndex of ["source", "destination", "mixed"] as const) {
      if (settings === "source" && activeIndex === "source") continue
      const report = classifyV4ReencryptionManualRecovery(local({
        settingsSelection: settings, activeIndexSelection: activeIndex,
        reason: "settings-or-index-partially-switched",
      }), live())
      assert.equal(report.condition, "partial-local-selection", settings + "/" + activeIndex)
      forbidden(report)
    }
  }
})

test("D222 uncertain WAL/Fence, foreign artifacts and tampered observers cannot become positive recovery guidance", () => {
  for (const variation of [
    null,
    local({ artifactWindow: "unverifiable" }),
    local({ artifactWindow: "unrecognized-layout" }),
    local({ settingsSelection: "unverifiable" }),
    local({ activeIndexSelection: "unverifiable" }),
    local({ reason: "fence-wal-lease-or-storage-uncertain" }),
    local({ reason: "historical-evidence-missing-or-changed" }),
    local({ artifactWindow: "pair-present", pairEvidence: "unverifiable", reason: "partial-or-foreign-commit-artifacts" }),
    local({ localCutoverAuthorized: true as false }),
    local({ resumeSyncAuthorized: true as false }),
    local({ oldPassphraseCleanupAuthorized: true as false }),
  ]) {
    const result = classifyV4ReencryptionManualRecovery(variation, live())
    assert.equal(result.condition, "unknown-or-corrupt-evidence")
    forbidden(result)
  }
})

test("D222 entire crash-window/selection/Git evidence matrix never returns a mutation authority", () => {
  const windows = [
    "absent", "receipt-directory-only", "receipt-only",
    "selector-only", "pair-present", "unrecognized-layout", "unverifiable",
  ] as const
  const selections = ["source", "destination", "mixed", "unverifiable"] as const
  const pairs = ["absent", "cryptographically-linked-uncommitted", "unverifiable"] as const
  const remotes = [null, live(), live({ fullBackupContentReverifiedAfterRestart: false })]
  let cases = 0
  for (const artifactWindow of windows) {
    for (const settingsSelection of selections) {
      for (const activeIndexSelection of selections) {
        for (const pairEvidence of pairs) {
          for (const remote of remotes) {
            const result = classifyV4ReencryptionManualRecovery(local({
              artifactWindow, settingsSelection, activeIndexSelection, pairEvidence,
            }), remote)
            forbidden(result)
            assert.equal(V4_MANUAL_RECOVERY_GUIDANCE[result.condition].heading, result.heading)
            cases++
          }
        }
      }
    }
  }
  assert.equal(cases, 1008)
  assert.equal(new Set(V4_MANUAL_RECOVERY_PREVIEW_CONDITIONS).size, 5)
  assert.equal(Object.keys(V4_MANUAL_RECOVERY_GUIDANCE).length, 6)
})
