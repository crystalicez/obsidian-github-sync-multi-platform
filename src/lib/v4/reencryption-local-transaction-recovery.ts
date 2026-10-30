import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndex } from "./local-index"
import { inspectV4ReencryptionRestartEvidence, type V4ReencryptionRestartInspectionInput } from "./reencryption-local-cutover-restart"
import { expectedV4PathLayout } from "./protocol-types"
import { isSafeV4ReencryptionSourceIndexRoot } from "./reencryption-index-root"

export type V4ReencryptionLocalCutoverSelection = "source" | "destination" | "mixed"

export type V4ReencryptionLocalRecoveryObservation =
  | "source-prepared-uncommitted"
  | "destination-observed-without-commit-proof"
  | "manual-recovery-required"

export interface V4ReencryptionLocalRecoverySnapshot {
  readonly settings: V4ReencryptionLocalCutoverSelection
  readonly activeIndex: V4ReencryptionLocalCutoverSelection
  readonly shadowComplete: boolean
  readonly oldSecretAvailable: boolean
  readonly newSecretAvailable: boolean
  readonly authenticatedSourceIntentAndWal: boolean
}

export interface V4ReencryptionLocalRecoveryReport {
  readonly integrityScope: "read-only-local-transaction-crash-window"
  readonly observation: V4ReencryptionLocalRecoveryObservation
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

export interface V4ReencryptionLocalRecoveryInput extends V4ReencryptionRestartInspectionInput {
  /** Must hold a real exclusive initiator lease throughout every asynchronous read. */
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
}

const MANUAL: V4ReencryptionLocalRecoveryReport = Object.freeze({
  integrityScope: "read-only-local-transaction-crash-window",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})

const SOURCE: V4ReencryptionLocalRecoveryReport = Object.freeze({
  ...MANUAL, observation: "source-prepared-uncommitted",
})

const DESTINATION: V4ReencryptionLocalRecoveryReport = Object.freeze({
  ...MANUAL, observation: "destination-observed-without-commit-proof",
})

/**
 * An executable crash matrix, not a commit state machine. The only currently
 * persisted local cutover marker is D135's *prepared-uncommitted* Intent.
 * No combination permits a local/remote mutation or automatic recovery.
 */
export function classifyV4ReencryptionLocalRecovery(
  state: V4ReencryptionLocalRecoverySnapshot,
): V4ReencryptionLocalRecoveryReport {
  if (!state || !state.shadowComplete
    || !state.oldSecretAvailable || !state.newSecretAvailable) return MANUAL

  if (state.settings === "source" && state.activeIndex === "source"
    && state.authenticatedSourceIntentAndWal === true) return SOURCE

  if (state.settings === "destination" && state.activeIndex === "destination") {
    // Even two matching destination selectors are not an atomic commit receipt.
    return DESTINATION
  }
  return MANUAL
}

function matchingIndex(
  index: V4LocalIndex,
  repoId: string, sha: string, deviceId: string,
): boolean {
  return index.repoId === repoId && index.remoteCommitSha === sha
    && index.deviceId === deviceId && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(record => record.dirty !== true && record.deleted !== true))
}

function settingsSelection(input: V4ReencryptionLocalRecoveryInput): V4ReencryptionLocalCutoverSelection {
  const { settings, expected } = input
  if (settings.encryptionMode !== "encrypted" || settings.vault !== expected.deviceId) return "mixed"
  const repoId = settings.githubOwner + "/" + settings.githubRepo + "#" + settings.githubBranch
  if (repoId === expected.sourceRepoId
    && settings.encryptionPassphraseSecretId === expected.sourcePassphraseSecretId) return "source"
  if (repoId === expected.destinationRepoId
    && settings.encryptionPassphraseSecretId === expected.destinationPassphraseSecretId) return "destination"
  return "mixed"
}

function indexSelection(input: V4ReencryptionLocalRecoveryInput, index: V4LocalIndex): V4ReencryptionLocalCutoverSelection {
  if (matchingIndex(index, input.expected.sourceRepoId, input.sourceCommitSha, input.expected.deviceId)) return "source"
  if (matchingIndex(index, input.expected.destinationRepoId, input.expected.destinationCommitSha, input.expected.deviceId)) return "destination"
  return "mixed"
}

function validate(input: V4ReencryptionLocalRecoveryInput): void {
  if (!input || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof input.runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.runId)
    || !isSafeV4ReencryptionSourceIndexRoot(input.indexRoot)
    || !/^[0-9a-f]{40}$/u.test(input.sourceCommitSha)
    || !/^[0-9a-f]{40}$/u.test(input.expected?.destinationCommitSha)
    || input.sourceCommitSha === input.expected.destinationCommitSha
    || typeof input.getSecret !== "function"
    || typeof input.indexAdapter?.read !== "function"
    || typeof input.indexAdapter.exists !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function") {
    throw new Error("Invalid read-only Re-encryption crash-window recovery contract.")
  }
}

/**
 * Inspect local selector windows without relying on any hypothetical future
 * durable commit marker. A destination-looking snapshot remains UNCONFIRMED.
 */
export async function inspectV4ReencryptionLocalTransactionAfterCrash(
  input: V4ReencryptionLocalRecoveryInput,
): Promise<V4ReencryptionLocalRecoveryReport> {
  validate(input)
  const owner = input.withExclusiveInitiatorLease
  const adapter = input.indexAdapter
  const adapterRead = adapter.read
  const adapterExists = adapter.exists
  const adapterStat = adapter.stat
  const journal = input.journal
  const walReader = journal.assertHealthySnapshot
  const lease = input.assertExclusiveInitiatorLease
  const durable = input.assertCrashDurable
  const getSecret = input.getSecret
  const expected = JSON.stringify(input.expected)
  const settings = JSON.stringify(input.settings)
  const values = Object.freeze({
    runId: input.runId, indexRoot: input.indexRoot,
    sourceCommitSha: input.sourceCommitSha, backupRepoId: input.backupRepoId,
    expectedWalGeneration: input.expectedWalGeneration,
  })
  const unchanged = (): boolean =>
    input.withExclusiveInitiatorLease === owner
    && input.indexAdapter === adapter
    && adapter.read === adapterRead && adapter.exists === adapterExists
    && adapter.stat === adapterStat && input.journal === journal
    && journal.assertHealthySnapshot === walReader
    && input.getSecret === getSecret
    && input.assertExclusiveInitiatorLease === lease
    && input.assertCrashDurable === durable
    && input.runId === values.runId && input.indexRoot === values.indexRoot
    && input.sourceCommitSha === values.sourceCommitSha
    && input.backupRepoId === values.backupRepoId
    && input.expectedWalGeneration === values.expectedWalGeneration
    && JSON.stringify(input.expected) === expected
    && JSON.stringify(input.settings) === settings

  let invoked = false
  const report = await owner(async () => {
    if (invoked) throw new Error("Re-encryption recovery reader was invoked more than once.")
    invoked = true
    await lease()
    await durable()
    if (!unchanged()) return MANUAL
    const shadowRoot = values.indexRoot + "-rekey-" + values.runId
    const firstIndex = await loadV4LocalIndex(adapter, values.indexRoot)
    const firstShadow = await loadV4LocalIndex(adapter, shadowRoot)
    const firstIndexBytes = JSON.stringify(firstIndex)
    const firstShadowBytes = JSON.stringify(firstShadow)
    const firstSettings = settingsSelection(input)
    const firstActive = indexSelection(input, firstIndex)
    const shadowComplete = matchingIndex(firstShadow,
      input.expected.destinationRepoId, input.expected.destinationCommitSha, input.expected.deviceId)
    const oldValue = getSecret(input.expected.sourcePassphraseSecretId)
    const newValue = getSecret(input.expected.destinationPassphraseSecretId)
    if (!unchanged() || !oldValue || !newValue || !shadowComplete) return MANUAL

    let sourceProof = false
    if (firstSettings === "source" && firstActive === "source") {
      const result = await inspectV4ReencryptionRestartEvidence(input)
      sourceProof = result.observation === "source-with-prepared-intent-uncommitted"
    }
    await lease()
    await durable()
    if (!unchanged()) return MANUAL
    const secondIndex = await loadV4LocalIndex(adapter, values.indexRoot)
    const secondShadow = await loadV4LocalIndex(adapter, shadowRoot)
    if (JSON.stringify(secondIndex) !== firstIndexBytes
      || JSON.stringify(secondShadow) !== firstShadowBytes
      || settingsSelection(input) !== firstSettings
      || indexSelection(input, secondIndex) !== firstActive
      || getSecret(input.expected.sourcePassphraseSecretId) !== oldValue
      || getSecret(input.expected.destinationPassphraseSecretId) !== newValue
      || !unchanged()) return MANUAL
    return classifyV4ReencryptionLocalRecovery({
      settings: firstSettings,
      activeIndex: firstActive,
      shadowComplete,
      oldSecretAvailable: true,
      newSecretAvailable: true,
      authenticatedSourceIntentAndWal: sourceProof,
    })
  })
  if (!invoked || !unchanged()) return MANUAL
  return report === SOURCE || report === DESTINATION ? report : MANUAL
}
