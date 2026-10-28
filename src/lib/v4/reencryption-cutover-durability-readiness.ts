/**
 * D140: diagnostic requirements for a future crash-safe local cutover.
 * A test result or caller-asserted qualification is NOT an authenticated,
 * durable transaction receipt. No result ever permits any write.
 */
export type V4ReencryptionCutoverPlatform =
  | "windows-desktop" | "macos-desktop" | "linux-desktop"
  | "android-mobile" | "ios-mobile"

export const V4_REENCRYPTION_CUTOVER_REQUIREMENTS = [
  "encrypted-wal-and-parent-directories",
  "shadow-index-and-parent-directories",
  "active-index-selection",
  "obsidian-settings-saveData",
  "secret-storage-reference-and-presence",
  "cross-surface-writer-exclusion",
  "idempotent-committed-receipt-and-recovery",
  "three-branch-remote-revalidation",
] as const

export type V4ReencryptionCutoverRequirement =
  (typeof V4_REENCRYPTION_CUTOVER_REQUIREMENTS)[number]

/** An observation is diagnostic only; its origin is not authenticated by this helper. */
export type V4ReencryptionCutoverEvidenceLevel =
  | "unverified"
  | "process-restart-only"
  | "claimed-power-loss-qualification"

export interface V4ReencryptionCutoverEvidenceClaim {
  readonly requirement: V4ReencryptionCutoverRequirement
  readonly platform: V4ReencryptionCutoverPlatform
  readonly level: V4ReencryptionCutoverEvidenceLevel
  /** Human-readable mechanism, not a trusted attestation. */
  readonly mechanism: string
}

export interface V4ReencryptionCutoverDurabilityInput {
  readonly platform: V4ReencryptionCutoverPlatform
  readonly evidence: readonly V4ReencryptionCutoverEvidenceClaim[]
}

export interface V4ReencryptionCutoverRequirementStatus {
  readonly requirement: V4ReencryptionCutoverRequirement
  readonly diagnostic: "missing" | "process-only" | "unqualified-claim"
}

export interface V4ReencryptionCutoverDurabilityReport {
  readonly integrityScope: "read-only-platform-cutover-capability-inventory"
  readonly state: "proofs-missing" | "all-proofs-claimed-but-not-authenticated"
  readonly platform: V4ReencryptionCutoverPlatform
  readonly requirements: readonly V4ReencryptionCutoverRequirementStatus[]
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const PLATFORMS: readonly V4ReencryptionCutoverPlatform[] = [
  "windows-desktop", "macos-desktop", "linux-desktop", "android-mobile", "ios-mobile",
]
const LEVELS: readonly V4ReencryptionCutoverEvidenceLevel[] = [
  "unverified", "process-restart-only", "claimed-power-loss-qualification",
]
const REQUIREMENTS: ReadonlySet<string> = new Set(V4_REENCRYPTION_CUTOVER_REQUIREMENTS)

/**
 * Classify *claimed* platform observations without treating a browser/Node
 * callback, successful readback or invented test report as an authorization.
 * This remains fail-closed even when every claim says "power-loss".
 */
export function assessV4ReencryptionCutoverDurability(
  input: V4ReencryptionCutoverDurabilityInput,
): V4ReencryptionCutoverDurabilityReport {
  if (!input || !PLATFORMS.includes(input.platform)
    || !Array.isArray(input.evidence)
    || input.evidence.length > V4_REENCRYPTION_CUTOVER_REQUIREMENTS.length) {
    throw new Error("Invalid Re-encryption durability platform or evidence collection.")
  }
  const seen = new Map<V4ReencryptionCutoverRequirement, V4ReencryptionCutoverEvidenceLevel>()
  for (const claim of input.evidence) {
    if (!claim || !REQUIREMENTS.has(claim.requirement)
      || claim.platform !== input.platform
      || !LEVELS.includes(claim.level)
      || typeof claim.mechanism !== "string"
      || !claim.mechanism.trim() || claim.mechanism.length > 256
      || /[\u0000-\u001f\u007f]/u.test(claim.mechanism)
      || seen.has(claim.requirement)) {
      throw new Error("Unrecognized, conflicting or duplicate Re-encryption durability evidence.")
    }
    seen.set(claim.requirement, claim.level)
  }
  const requirements = V4_REENCRYPTION_CUTOVER_REQUIREMENTS.map(requirement => {
    const level = seen.get(requirement)
    return Object.freeze({
      requirement,
      diagnostic: level === "claimed-power-loss-qualification"
        ? "unqualified-claim" as const
        : level === "process-restart-only"
          ? "process-only" as const
          : "missing" as const,
    })
  })
  return Object.freeze({
    integrityScope: "read-only-platform-cutover-capability-inventory",
    state: requirements.every(row => row.diagnostic === "unqualified-claim")
      ? "all-proofs-claimed-but-not-authenticated" : "proofs-missing",
    platform: input.platform,
    requirements: Object.freeze(requirements),
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    rollbackAuthorized: false,
    remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
}
