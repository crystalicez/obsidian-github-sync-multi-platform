import {
  assertV4ReencryptionProposedCommitIdentity,
  type V4ReencryptionProposedCommitIdentity,
} from "./reencryption-proposed-commit-receipt"

const SHA256 = /^[a-f0-9]{64}$/u
const TX = /^[a-f0-9]{32}$/u
const CONTRACT_KEYS = Object.freeze([
  "transactionId", "identity", "sourceIndexSha256", "destinationShadowSha256",
  "preparedEvidenceSha256", "walSnapshotSha256", "sourceSettingsSha256",
  "destinationSettingsSha256",
].sort())

/**
 * Shared immutable digest contract for the pending local cutover.
 * The facts must come from independently verified Source/Shadow/Intent/WAL/
 * Settings snapshots; valid syntax alone does NOT attest to their provenance
 * or establish a committed transaction.
 */
export interface V4ReencryptionCutoverSnapshotContract {
  /** Externally generated unpredictable 128-bit per-attempt ID. */
  readonly transactionId: string
  readonly identity: V4ReencryptionProposedCommitIdentity
  readonly sourceIndexSha256: string
  readonly destinationShadowSha256: string
  readonly preparedEvidenceSha256: string
  readonly walSnapshotSha256: string
  readonly sourceSettingsSha256: string
  readonly destinationSettingsSha256: string
}

export function assertV4ReencryptionCutoverSnapshotContract(
  contract: V4ReencryptionCutoverSnapshotContract,
): void {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)
    || Object.keys(contract).sort().join("|") !== CONTRACT_KEYS.join("|")
    || !TX.test(contract.transactionId) || /^0+$/u.test(contract.transactionId)
    || ![
      contract.sourceIndexSha256, contract.destinationShadowSha256,
      contract.preparedEvidenceSha256, contract.walSnapshotSha256,
      contract.sourceSettingsSha256, contract.destinationSettingsSha256,
    ].every(value => typeof value === "string" && SHA256.test(value))) {
    throw Error("Invalid Re-encryption cutover snapshot digest contract.")
  }
  assertV4ReencryptionProposedCommitIdentity(contract.identity)
}
