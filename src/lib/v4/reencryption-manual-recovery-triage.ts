import type { V4FencedCrashWindowPairReport } from "./reencryption-fenced-crash-window-pair-inspection"
import type { V4FencedLivePersistedTestPairAndBackupReport } from "./reencryption-fenced-live-persisted-test-pair-recovery"

/**
 * D222: explain evidence to an operator, never infer a Cutover transition.
 * A D182 test pair remains UNCOMMITTED even if D221 re-decrypts every Git
 * object. No condition is sufficient to delete old keys, retry Re-encryption,
 * roll back, select Destination, mutate refs or resume normal Sync.
 */
export type V4ManualRecoveryCondition =
  | "source-prepared-only"
  | "partial-local-artifacts"
  | "linked-test-pair-current-git-verified-uncommitted"
  | "linked-test-pair-current-git-unverified"
  | "partial-local-selection"
  | "unknown-or-corrupt-evidence"

export interface V4ManualRecoveryGuidance {
  readonly condition: V4ManualRecoveryCondition
  readonly heading: string
  readonly explanation: string
  readonly nextReview: string
}

export const V4_MANUAL_RECOVERY_GUIDANCE: Readonly<Record<
  V4ManualRecoveryCondition, V4ManualRecoveryGuidance
>> = Object.freeze({
  "source-prepared-only": Object.freeze({
    condition: "source-prepared-only",
    heading: "Source is still selected; migration evidence is only prepared",
    explanation: "The local Source settings and index match, but no Receipt/Selector pair was found. The migration is not committed.",
    nextReview: "Preserve the prepared WAL, Intent, Source Index, Shadow Index and all three branches; verify current Backup and Destination independently before any manual decision.",
  }),
  "partial-local-artifacts": Object.freeze({
    condition: "partial-local-artifacts",
    heading: "Receipt/Selector staging was interrupted",
    explanation: "A directory, Receipt or Selector exists without its complete authenticated pair. Do not treat the surviving file as an authorization.",
    nextReview: "Retain every partial file and its timestamps. Inspect WAL, Sync Fence, both passphrases, and the three remote branches before any manually supervised recovery.",
  }),
  "linked-test-pair-current-git-verified-uncommitted": Object.freeze({
    condition: "linked-test-pair-current-git-verified-uncommitted",
    heading: "Encrypted test pair and current Git content match, but no commit exists",
    explanation: "The historical test Receipt/Selector is linked and complete Backup/Destination ciphertext was reverified. These are explicitly test-vector phases, NOT an authoritative Cutover.",
    nextReview: "Preserve the verified evidence and keep Sync fenced. Review the eventual production commit protocol before deciding whether a new migration attempt is safe.",
  }),
  "linked-test-pair-current-git-unverified": Object.freeze({
    condition: "linked-test-pair-current-git-unverified",
    heading: "Historical test pair matches; current Git remains uncertain",
    explanation: "Cryptographic linkage of the saved test pair does not establish that GitHub's current frozen Backup and Destination still match.",
    nextReview: "Recheck current full Backup/Destination contents and all three Git refs using read-only authenticated verification before any recovery choice.",
  }),
  "partial-local-selection": Object.freeze({
    condition: "partial-local-selection",
    heading: "Settings and local Index no longer both point at Source",
    explanation: "At least one local selection looks changed or mixed. Even two Destination-looking values do not establish a committed transition.",
    nextReview: "Keep Sync disabled, preserve BOTH keys, original Source Index, Shadow Index, Receipt/Selector, and current Settings; compare readbacks before supervised repair.",
  }),
  "unknown-or-corrupt-evidence": Object.freeze({
    condition: "unknown-or-corrupt-evidence",
    heading: "Evidence is missing, foreign, torn or cannot be verified",
    explanation: "The local evidence, authenticated WAL, Sync Fence or observations are insufficient to classify the interrupted migration safely.",
    nextReview: "Stop Sync on all devices. Copy the Vault and plugin data, preserve both passphrases and every Git branch, and investigate without deleting, retrying or force-pushing.",
  }),
})

export interface V4ManualRecoveryTriageReport extends V4ManualRecoveryGuidance {
  readonly integrityScope: "read-only-reencryption-manual-recovery-guidance"
  readonly observation: "manual-recovery-required"
  readonly liveRecoveryAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-reencryption-manual-recovery-guidance" as const,
  observation: "manual-recovery-required" as const,
  liveRecoveryAuthorized: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})

const triage = (condition: V4ManualRecoveryCondition): V4ManualRecoveryTriageReport =>
  Object.freeze({ ...BASE, ...V4_MANUAL_RECOVERY_GUIDANCE[condition] })

const UNKNOWN = triage("unknown-or-corrupt-evidence")

function fullyReverified(
  live: V4FencedLivePersistedTestPairAndBackupReport | null,
): boolean {
  return live?.integrityScope === "read-only-restarted-test-pair-current-git-and-frozen-backup"
    && live.observation === "manual-recovery-required"
    && live.reason === "test-pair-and-full-remote-coherent-but-not-a-commit"
    && live.historicalTestPairCryptographicallyLinked === true
    && live.fullDestinationContentReverifiedAfterRestart === true
    && live.fullBackupContentReverifiedAfterRestart === true
    && live.liveThreeBranchRefsReverifiedAfterRestart === true
    && live.localCutoverAuthorized === false && live.resumeSyncAuthorized === false
    && live.rollbackAuthorized === false && live.remoteWritesAuthorized === false
    && live.oldPassphraseCleanupAuthorized === false
}

/**
 * Classify actual D184 local crash evidence, optionally with D221 current Git
 * evidence. A missing D221 result is NEVER interpreted as current remote
 * verification. The report is guidance, NOT a live recovery capability.
 *
 * This pure function has no access to GitHub, local storage or credentials.
 * A caller must separately collect genuine fenced proof; untrusted caller
 * supplied reports are not a security boundary and can never authorize action.
 */
export function classifyV4ReencryptionManualRecovery(
  local: V4FencedCrashWindowPairReport | null,
  live: V4FencedLivePersistedTestPairAndBackupReport | null = null,
): V4ManualRecoveryTriageReport {
  if (!local
    || local.integrityScope !== "read-only-fenced-post-crash-test-pair-window"
    || local.localCutoverAuthorized !== false || local.resumeSyncAuthorized !== false
    || local.rollbackAuthorized !== false || local.remoteWritesAuthorized !== false
    || local.oldPassphraseCleanupAuthorized !== false
    || local.artifactWindow === "unverifiable" || local.artifactWindow === "unrecognized-layout"
    || local.settingsSelection === "unverifiable"
    || local.activeIndexSelection === "unverifiable"
    || local.reason === "fence-wal-lease-or-storage-uncertain"
    || local.reason === "historical-evidence-missing-or-changed") return UNKNOWN

  if (local.settingsSelection !== "source" || local.activeIndexSelection !== "source") {
    return triage("partial-local-selection")
  }
  if (local.artifactWindow === "receipt-directory-only"
    || local.artifactWindow === "receipt-only"
    || local.artifactWindow === "selector-only") return triage("partial-local-artifacts")

  if (local.artifactWindow === "absent"
    && local.reason === "source-still-selected-no-pair"
    && local.pairEvidence === "absent"
    && local.observation === "source-prepared-uncommitted") {
    return triage("source-prepared-only")
  }
  if (local.artifactWindow === "pair-present"
    && local.reason === "linked-test-pair-not-authoritative"
    && local.pairEvidence === "cryptographically-linked-uncommitted"
    && local.observation === "manual-recovery-required") {
    return triage(fullyReverified(live)
      ? "linked-test-pair-current-git-verified-uncommitted"
      : "linked-test-pair-current-git-unverified")
  }
  return UNKNOWN
}

/** Stable Preview-only examples; these are NOT readings from the user's Vault. */
export const V4_MANUAL_RECOVERY_PREVIEW_CONDITIONS = Object.freeze([
  "partial-local-artifacts",
  "linked-test-pair-current-git-unverified",
  "linked-test-pair-current-git-verified-uncommitted",
  "partial-local-selection",
  "unknown-or-corrupt-evidence",
] as const satisfies readonly V4ManualRecoveryCondition[])
