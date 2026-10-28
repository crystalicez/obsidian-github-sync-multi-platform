/**
 * Option A: the local Source Index stays at its original root, the destination
 * stays at its existing Shadow root, and the future selector has its own path.
 * This defines an inspection contract, NOT a persistent selector writer.
 */
export interface V4ReencryptionSeparatedRoots {
  readonly sourceIndexRoot: string
  readonly shadowIndexRoot: string
  readonly selectorPath: string
}

const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SEGMENT = /^[A-Za-z0-9_.-]+$/u

export function planV4ReencryptionSeparatedRoots(
  sourceIndexRoot: string, runId: string,
): V4ReencryptionSeparatedRoots {
  if (typeof sourceIndexRoot !== "string"
    || sourceIndexRoot.split("/").length < 2
    || !sourceIndexRoot.split("/").every(segment =>
      SEGMENT.test(segment) && segment !== "." && segment !== "..")
    || typeof runId !== "string" || !RUN.test(runId)) {
    throw new Error("Invalid immutable Source/Shadow selector roots.")
  }
  return Object.freeze({
    sourceIndexRoot,
    shadowIndexRoot: sourceIndexRoot + "-rekey-" + runId,
    selectorPath: sourceIndexRoot + "-rekey-selector-" + runId + "/selector.json",
  })
}

/** These are independent observations, not authenticated disk records. */
export interface V4ReencryptionSeparatedSelectorSnapshot {
  readonly selector: "absent" | "source" | "destination" | "torn"
  readonly settings: "source" | "destination" | "mixed"
  readonly sourceIndex: "matching" | "missing-or-changed"
  readonly shadowIndex: "matching" | "missing-or-changed"
  readonly oldSecretAvailable: boolean
  readonly newSecretAvailable: boolean
  readonly authenticatedPreparedWal: boolean
}

export interface V4ReencryptionSeparatedSelectorReport {
  readonly integrityScope: "pure-option-a-selector-diagnostic-uncommitted"
  readonly observation: "source-prepared-uncommitted" | "destination-observed-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4ReencryptionSeparatedSelectorReport = Object.freeze({
  integrityScope: "pure-option-a-selector-diagnostic-uncommitted",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const SOURCE: V4ReencryptionSeparatedSelectorReport =
  Object.freeze({ ...MANUAL, observation: "source-prepared-uncommitted" })
const DESTINATION: V4ReencryptionSeparatedSelectorReport =
  Object.freeze({ ...MANUAL, observation: "destination-observed-uncommitted" })

/**
 * A selected Destination with matching Settings is only an observation.
 * Even a future authenticated selector needs independent physical durability,
 * WAL, Git and cross-process writer proofs before any operation can proceed.
 * Never infer rollback permission from a surviving Source cache.
 */
export function classifyV4ReencryptionSeparatedSelector(
  state: V4ReencryptionSeparatedSelectorSnapshot,
): V4ReencryptionSeparatedSelectorReport {
  if (!state || state.sourceIndex !== "matching" || state.shadowIndex !== "matching"
    || state.oldSecretAvailable !== true || state.newSecretAvailable !== true
    || state.authenticatedPreparedWal !== true) return MANUAL

  if (state.settings === "source"
    && (state.selector === "absent" || state.selector === "source")) return SOURCE
  if (state.settings === "destination" && state.selector === "destination") return DESTINATION
  return MANUAL
}
