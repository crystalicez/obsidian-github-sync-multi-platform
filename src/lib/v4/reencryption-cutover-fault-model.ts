/**
 * D141: PURE, non-authorizing model of local cutover persistence ambiguity.
 *
 * This is NOT a cutover transaction, WAL writer or proof of physical durability.
 * Acknowledged writes to Settings, Index, receipt and SecretStorage can survive
 * a crash independently until real platform guarantees are established.
 */
export const V4_REENCRYPTION_FAULT_MODEL_ACTIONS = [
  "settings-branch-destination",
  "settings-secret-id-destination",
  "active-index-destination",
  "hypothetical-commit-receipt",
  "old-secret-clear",
] as const

export type V4ReencryptionFaultModelAction = (typeof V4_REENCRYPTION_FAULT_MODEL_ACTIONS)[number]

export type V4ReencryptionFaultModelSelection = "source" | "destination" | "mixed"

export type V4ReencryptionFaultModelHazard =
  | "settings-branch-secret-id-mismatch"
  | "settings-active-index-mismatch"
  | "claimed-receipt-without-matching-destination"
  | "destination-without-authenticated-durable-commit"
  | "old-secret-cleared-without-authenticated-durable-commit"
  | "original-active-index-may-be-overwritten"

export interface V4ReencryptionFaultModelCase {
  readonly integrityScope: "pure-untrusted-cross-store-crash-model"
  /** Number of hypothetical writes acknowledged before the simulated crash. */
  readonly acknowledgedWrites: number
  /** A bit set means that particular acknowledged write survives the crash. */
  readonly persistedMask: number
  readonly settings: V4ReencryptionFaultModelSelection
  readonly activeIndex: "source" | "destination"
  readonly hypotheticalReceiptPresent: boolean
  readonly oldSecretAvailable: boolean
  readonly newSecretAvailable: true
  /** Only the remote Source branch is outside the modeled local writes. */
  readonly sourceRemoteBranchPreserved: true
  readonly shadowIndexPreserved: true
  readonly hazards: readonly V4ReencryptionFaultModelHazard[]
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const ACTIONS: ReadonlySet<string> = new Set(V4_REENCRYPTION_FAULT_MODEL_ACTIONS)

function assertValidSequence(order: readonly V4ReencryptionFaultModelAction[]): void {
  if (!Array.isArray(order) || order.length !== V4_REENCRYPTION_FAULT_MODEL_ACTIONS.length
    || new Set(order).size !== V4_REENCRYPTION_FAULT_MODEL_ACTIONS.length
    || !order.every(action => ACTIONS.has(action))) {
    throw new Error("Crash model requires each known hypothetical cutover write exactly once.")
  }
}

function evaluate(
  order: readonly V4ReencryptionFaultModelAction[],
  acknowledgedWrites: number,
  persistedMask: number,
): V4ReencryptionFaultModelCase {
  const persisted = new Set<V4ReencryptionFaultModelAction>()
  for (let i = 0; i < acknowledgedWrites; i++) {
    if ((persistedMask & (1 << i)) !== 0) persisted.add(order[i]!)
  }
  const branchNew = persisted.has("settings-branch-destination")
  const secretIdNew = persisted.has("settings-secret-id-destination")
  const activeIndex = persisted.has("active-index-destination") ? "destination" : "source"
  const settings: V4ReencryptionFaultModelSelection =
    branchNew !== secretIdNew ? "mixed" : branchNew ? "destination" : "source"
  const hypotheticalReceiptPresent = persisted.has("hypothetical-commit-receipt")
  const oldSecretAvailable = !persisted.has("old-secret-clear")
  const hazards: V4ReencryptionFaultModelHazard[] = []
  if (settings === "mixed") hazards.push("settings-branch-secret-id-mismatch")
  if (settings !== activeIndex) hazards.push("settings-active-index-mismatch")
  if (hypotheticalReceiptPresent
    && (settings !== "destination" || activeIndex !== "destination")) {
    hazards.push("claimed-receipt-without-matching-destination")
  }
  if (activeIndex === "destination") {
    // A direct overwrite of the active root can destroy the original local
    // Source cache even though the remote Source Git ref is untouched.
    hazards.push("original-active-index-may-be-overwritten")
  }
  if (settings === "destination" && activeIndex === "destination") {
    // Even a purported receipt is NOT independently authenticated/durable.
    hazards.push("destination-without-authenticated-durable-commit")
  }
  if (!oldSecretAvailable) {
    hazards.push("old-secret-cleared-without-authenticated-durable-commit")
  }
  return Object.freeze({
    integrityScope: "pure-untrusted-cross-store-crash-model",
    acknowledgedWrites, persistedMask, settings, activeIndex,
    hypotheticalReceiptPresent, oldSecretAvailable,
    newSecretAvailable: true,
    sourceRemoteBranchPreserved: true,
    shadowIndexPreserved: true,
    hazards: Object.freeze(hazards),
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    rollbackAuthorized: false,
    remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
}

/**
 * Model every crash boundary (including before the first write) and every
 * subset of acknowledged writes that could be durable after power loss.
 * No action is executed; the returned snapshots contain no secret material.
 *
 * This is intentionally conservative: some storage providers may guarantee
 * stronger ordering. A test passing here cannot establish those guarantees.
 */
export function enumerateV4ReencryptionCutoverCrashCases(
  order: readonly V4ReencryptionFaultModelAction[],
): readonly V4ReencryptionFaultModelCase[] {
  assertValidSequence(order)
  const cases: V4ReencryptionFaultModelCase[] = []
  for (let acknowledgedWrites = 0; acknowledgedWrites <= order.length; acknowledgedWrites++) {
    for (let persistedMask = 0; persistedMask < 2 ** acknowledgedWrites; persistedMask++) {
      cases.push(evaluate(order, acknowledgedWrites, persistedMask))
    }
  }
  return Object.freeze(cases)
}

/** Generate ALL 5! write orders; intentionally make no architectural choice. */
export function enumerateV4ReencryptionHypotheticalWriteOrders():
  readonly (readonly V4ReencryptionFaultModelAction[])[] {
  const result: (readonly V4ReencryptionFaultModelAction[])[] = []
  function visit(prefix: V4ReencryptionFaultModelAction[], remaining: V4ReencryptionFaultModelAction[]): void {
    if (remaining.length === 0) {
      result.push(Object.freeze(prefix.slice()))
      return
    }
    for (let i = 0; i < remaining.length; i++) {
      visit([...prefix, remaining[i]!], remaining.filter((_, index) => index !== i))
    }
  }
  visit([], [...V4_REENCRYPTION_FAULT_MODEL_ACTIONS])
  return Object.freeze(result)
}
