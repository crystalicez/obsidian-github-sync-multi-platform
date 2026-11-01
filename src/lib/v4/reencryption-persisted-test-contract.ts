import { fitsV4LocalJsonSizeLimit } from "./local-index"
import {
  assertV4ReencryptionCommitPairTestContract,
  type V4ReencryptionCommitPairTestContract,
} from "./reencryption-commit-pair-test-vectors"

export const V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES = 8 * 1024
const PHASE = "persisted-test-pair-contract-uncommitted"

interface PersistedTestContract {
  readonly schemaVersion: 1
  readonly phase: typeof PHASE
  readonly contract: V4ReencryptionCommitPairTestContract
}

/**
 * NONSECRET bootstrap metadata only. This JSON is NOT an authentication or a
 * commit receipt: readers must independently authenticate the D182 sealed
 * Receipt+Selector against its contract and the trusted WAL/fenced Source.
 *
 * The encrypted D182 AAD depends on the contract, so a restarted reader
 * cannot bootstrap the pair without this independently saved, untrusted hint.
 */
export function encodeV4ReencryptionPersistedTestContract(
  contract: V4ReencryptionCommitPairTestContract,
): string {
  assertV4ReencryptionCommitPairTestContract(contract)
  const serialized = JSON.stringify({
    schemaVersion: 1,
    phase: PHASE,
    contract,
  } satisfies PersistedTestContract)
  if (!fitsV4LocalJsonSizeLimit(serialized, V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
    throw Error("Re-encryption persisted test contract exceeds size limit.")
  }
  return serialized
}

export function decodeV4ReencryptionPersistedTestContract(
  serialized: string,
): V4ReencryptionCommitPairTestContract {
  if (typeof serialized !== "string"
    || !fitsV4LocalJsonSizeLimit(serialized, V4_REENCRYPTION_TEST_CONTRACT_MAX_BYTES)) {
    throw Error("Re-encryption persisted test contract is absent or oversized.")
  }
  const raw: unknown = JSON.parse(serialized)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).sort().join("|") !== "contract|phase|schemaVersion") {
    throw Error("Re-encryption persisted test contract envelope is not canonical.")
  }
  const record = raw as Partial<PersistedTestContract>
  if (record.schemaVersion !== 1 || record.phase !== PHASE || !record.contract) {
    throw Error("Re-encryption persisted test contract envelope is foreign.")
  }
  assertV4ReencryptionCommitPairTestContract(record.contract)
  if (encodeV4ReencryptionPersistedTestContract(record.contract) !== serialized) {
    throw Error("Re-encryption persisted test contract has noncanonical encoding.")
  }
  return record.contract
}
