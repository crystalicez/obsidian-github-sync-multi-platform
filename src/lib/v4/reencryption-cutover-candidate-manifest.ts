import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"

/**
 * D223 candidate bootstrap is nonsecret UNTRUSTED AAD material only. The
 * historic D220 contract.json uses a DIFFERENT phase and is not accepted.
 * A validated manifest is neither cryptographic evidence nor a Commit.
 */
const PHASE = "cutover-candidate-snapshot-uncommitted"
export const V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES = 8 * 1024

export function encodeV4ReencryptionCutoverCandidateManifest(
  contract: V4ReencryptionCutoverSnapshotContract,
): string {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  const bytes = JSON.stringify({ schemaVersion: 1, phase: PHASE, contract })
  if (!fitsV4LocalJsonSizeLimit(bytes, V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES)) {
    throw Error("Cutover candidate manifest exceeds byte limit.")
  }
  return bytes
}

export function decodeV4ReencryptionCutoverCandidateManifest(
  serialized: string,
): V4ReencryptionCutoverSnapshotContract {
  if (typeof serialized !== "string"
    || !fitsV4LocalJsonSizeLimit(serialized, V4_REENCRYPTION_CUTOVER_CANDIDATE_MANIFEST_MAX_BYTES)) {
    throw Error("Cutover candidate manifest missing or oversized.")
  }
  const decoded: unknown = JSON.parse(serialized)
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
    || Object.keys(decoded).sort().join("|") !== "contract|phase|schemaVersion") {
    throw Error("Cutover candidate manifest has foreign envelope.")
  }
  const envelope = decoded as {
    schemaVersion?: unknown; phase?: unknown; contract?: V4ReencryptionCutoverSnapshotContract
  }
  if (envelope.schemaVersion !== 1 || envelope.phase !== PHASE || !envelope.contract) {
    throw Error("Cutover candidate manifest has unsupported phase.")
  }
  assertV4ReencryptionCutoverSnapshotContract(envelope.contract)
  if (encodeV4ReencryptionCutoverCandidateManifest(envelope.contract) !== serialized) {
    throw Error("Cutover candidate manifest encoding is noncanonical.")
  }
  return envelope.contract
}
