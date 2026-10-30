import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import {
  assertV4ReencryptionProposedCommitIdentity,
  type V4ReencryptionProposedCommitIdentity,
} from "./reencryption-proposed-commit-receipt"

const RECEIPT_CONTEXT = "v4-rekey-d182-receipt-contract-test-vector-v1"
const SELECTOR_CONTEXT = "v4-rekey-d182-selector-contract-test-vector-v1"
const SHA256 = /^[a-f0-9]{64}$/u
const TX = /^[a-f0-9]{32}$/u
const MAX_ENCODED_BYTES = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const CONTRACT_KEYS = Object.freeze([
  "transactionId", "identity", "sourceIndexSha256", "destinationShadowSha256",
  "preparedEvidenceSha256", "walSnapshotSha256", "sourceSettingsSha256",
  "destinationSettingsSha256",
].sort())

/** A proposed data contract ONLY, not a permission or a durable commit format. */
export interface V4ReencryptionCommitPairTestContract {
  /** 128-bit per-attempt random ID supplied by the eventual trusted caller. */
  readonly transactionId: string
  readonly identity: V4ReencryptionProposedCommitIdentity
  /** Digests must be computed from independently verified canonical snapshots. */
  readonly sourceIndexSha256: string
  readonly destinationShadowSha256: string
  readonly preparedEvidenceSha256: string
  readonly walSnapshotSha256: string
  readonly sourceSettingsSha256: string
  readonly destinationSettingsSha256: string
}
export interface V4ReencryptionCommitPairTestVectors {
  readonly receiptTestVector: string
  readonly selectorTestVector: string
}
export interface V4ReencryptionCommitPairTestInspection {
  readonly integrityScope: "in-memory-cryptographically-bound-commit-pair-test-vectors"
  readonly observation: "both-test-vectors-authenticate-uncommitted" | "manual-recovery-required"
  readonly reason: "linked-but-not-authoritative" | "both-absent"
    | "one-artifact-missing" | "invalid-or-mismatched-pair"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

type Role = "receipt" | "selector"
interface ReceiptRecord {
  readonly schemaVersion: 1
  readonly phase: "receipt-candidate-test-vector-uncommitted"
  readonly contract: V4ReencryptionCommitPairTestContract
}
interface SelectorRecord {
  readonly schemaVersion: 1
  readonly phase: "selector-candidate-test-vector-uncommitted"
  readonly contract: V4ReencryptionCommitPairTestContract
  readonly receiptCiphertextSha256: string
}

const BASE = Object.freeze({
  integrityScope: "in-memory-cryptographically-bound-commit-pair-test-vectors" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const observation = (
  value: V4ReencryptionCommitPairTestInspection["observation"],
  reason: V4ReencryptionCommitPairTestInspection["reason"],
): V4ReencryptionCommitPairTestInspection =>
  Object.freeze({ ...BASE, observation: value, reason })
const LINKED = observation("both-test-vectors-authenticate-uncommitted", "linked-but-not-authoritative")
const NONE = observation("manual-recovery-required", "both-absent")
const PARTIAL = observation("manual-recovery-required", "one-artifact-missing")
const INVALID = observation("manual-recovery-required", "invalid-or-mismatched-pair")

function assertContract(contract: V4ReencryptionCommitPairTestContract): void {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)
    || Object.keys(contract).sort().join("|") !== CONTRACT_KEYS.join("|")
    || !TX.test(contract.transactionId) || /^0+$/u.test(contract.transactionId)
    || ![
      contract.sourceIndexSha256, contract.destinationShadowSha256,
      contract.preparedEvidenceSha256, contract.walSnapshotSha256,
      contract.sourceSettingsSha256, contract.destinationSettingsSha256,
    ].every(value => typeof value === "string" && SHA256.test(value))) {
    throw new Error("Invalid Re-encryption commit pair test contract.")
  }
  assertV4ReencryptionProposedCommitIdentity(contract.identity)
}
function assertKey(journalKey: Uint8Array): void {
  if (!(journalKey instanceof Uint8Array) || journalKey.byteLength !== 32) {
    throw new Error("Commit pair test vectors need the independent 32-byte journal key.")
  }
}
function record(contract: V4ReencryptionCommitPairTestContract, role: "receipt"): ReceiptRecord
function record(
  contract: V4ReencryptionCommitPairTestContract, role: "selector", receiptSha: string,
): SelectorRecord
function record(
  contract: V4ReencryptionCommitPairTestContract, role: Role, receiptSha?: string,
): ReceiptRecord | SelectorRecord {
  if (role === "receipt") return {
    schemaVersion: 1, phase: "receipt-candidate-test-vector-uncommitted", contract,
  }
  if (!receiptSha || !SHA256.test(receiptSha)) throw new Error("Invalid encrypted receipt linkage.")
  return {
    schemaVersion: 1, phase: "selector-candidate-test-vector-uncommitted",
    contract, receiptCiphertextSha256: receiptSha,
  }
}
function context(role: Role): string {
  return role === "receipt" ? RECEIPT_CONTEXT : SELECTOR_CONTEXT
}
function aad(contract: V4ReencryptionCommitPairTestContract, role: Role): string {
  const id = contract.identity
  return context(role) + ":" + contract.transactionId + ":" + id.runId
    + ":" + id.sourceCommitSha + ":" + id.destinationRepoId
    + ":" + id.destinationCommitSha
}
async function keyFor(journalKey: Uint8Array, role: Role): Promise<Uint8Array> {
  const hmac = await crypto.subtle.importKey(
    "raw", journalKey as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC", hmac, utf8ToBytes(context(role) + ":key") as any,
  ))
}
async function sealRecord(
  contract: V4ReencryptionCommitPairTestContract, journalKey: Uint8Array,
  role: "receipt" | "selector", receiptSha?: string,
): Promise<string> {
  const serialized = role === "receipt"
    ? JSON.stringify(record(contract, "receipt"))
    : JSON.stringify(record(contract, "selector", receiptSha ?? ""))
  const plaintext = utf8ToBytes(serialized)
  if (plaintext.byteLength > MAX_ENCODED_BYTES / 2) {
    plaintext.fill(0)
    throw new Error("Re-encryption commit pair test record too large.")
  }
  let key: Uint8Array | null = null
  try {
    key = await keyFor(journalKey, role)
    const encrypted = await encryptV4Payload(key, plaintext, {
      kind: "journal", aad: aad(contract, role),
    })
    try {
      const encoded = toBase64(encrypted)
      if (encoded.length > MAX_ENCODED_BYTES) throw new Error("Commit pair test vector too large.")
      return encoded
    } finally { encrypted.fill(0) }
  } finally { key?.fill(0); plaintext.fill(0) }
}
function decode(encoded: string): Uint8Array | null {
  if (typeof encoded !== "string" || encoded.length < 4
    || encoded.length > MAX_ENCODED_BYTES || !BASE64.test(encoded)) return null
  const bytes = fromBase64(encoded)
  if (toBase64(bytes) !== encoded || bytes.byteLength > MAX_ENCODED_BYTES) {
    bytes.fill(0)
    return null
  }
  return bytes
}
async function matchesSealed(
  encoded: string, contract: V4ReencryptionCommitPairTestContract,
  journalKey: Uint8Array, role: Role, receiptSha?: string,
): Promise<boolean> {
  const bytes = decode(encoded)
  if (!bytes) return false
  let key: Uint8Array | null = null
  try {
    key = await keyFor(journalKey, role)
    let plain: Uint8Array
    try {
      plain = await decryptV4Payload(key, bytes, {
        kind: "journal", aad: aad(contract, role),
      })
    } catch { return false }
    try {
      const serialized = role === "receipt"
        ? JSON.stringify(record(contract, "receipt"))
        : JSON.stringify(record(contract, "selector", receiptSha ?? ""))
      return plain.byteLength <= MAX_ENCODED_BYTES / 2
        && bytesToUtf8(plain) === serialized
    } finally { plain.fill(0) }
  } finally { key?.fill(0); bytes.fill(0) }
}

/**
 * Test-vector only: seals two separate AES-GCM records with domain-separated
 * HMAC-derived keys. Selector binds the SHA-256 of the *actual encrypted*
 * receipt. No persistent writes or authoritative committed phase exists.
 */
export async function sealV4ReencryptionCommitPairTestVectors(
  contract: V4ReencryptionCommitPairTestContract, journalKey: Uint8Array,
): Promise<V4ReencryptionCommitPairTestVectors> {
  assertContract(contract)
  assertKey(journalKey)
  const pinned = JSON.stringify(contract)
  const keyCopy = Uint8Array.from(journalKey)
  try {
    const receiptTestVector = await sealRecord(contract, journalKey, "receipt")
    if (JSON.stringify(contract) !== pinned
      || !journalKey.every((value, i) => value === keyCopy[i])) {
      throw Error("Commit pair inputs changed during receipt sealing.")
    }
    const digest = await sha256Hex(utf8ToBytes(receiptTestVector))
    const selectorTestVector = await sealRecord(contract, journalKey, "selector", digest)
    if (JSON.stringify(contract) !== pinned
      || !journalKey.every((value, i) => value === keyCopy[i])) {
      throw Error("Commit pair inputs changed during selector sealing.")
    }
    return Object.freeze({ receiptTestVector, selectorTestVector })
  } finally { keyCopy.fill(0) }
}

/**
 * Pure in-memory diagnostic; intentionally never returns "committed".
 * Neither these bytes nor an authenticated pair are an OS durability receipt,
 * migration commit point, Sync resume permission or valid production selector.
 */
export async function inspectV4ReencryptionCommitPairTestVectors(
  contract: V4ReencryptionCommitPairTestContract, journalKey: Uint8Array,
  pair: { readonly receiptTestVector: string | null; readonly selectorTestVector: string | null },
): Promise<V4ReencryptionCommitPairTestInspection> {
  try {
    assertContract(contract)
    assertKey(journalKey)
    if (!pair) return INVALID
    const receipt = pair.receiptTestVector
    const selector = pair.selectorTestVector
    if (receipt === null && selector === null) return NONE
    if (receipt === null || selector === null) return PARTIAL
    if (typeof receipt !== "string" || typeof selector !== "string") return INVALID
    const pinnedContract = JSON.stringify(contract)
    const keyCopy = Uint8Array.from(journalKey)
    try {
      const validReceipt = await matchesSealed(receipt, contract, journalKey, "receipt")
      if (!validReceipt) return INVALID
      const receiptSha = await sha256Hex(utf8ToBytes(receipt))
      const validSelector = await matchesSealed(selector, contract, journalKey, "selector", receiptSha)
      if (!validSelector || JSON.stringify(contract) !== pinnedContract
        || !journalKey.every((value, i) => value === keyCopy[i])
        || pair.receiptTestVector !== receipt || pair.selectorTestVector !== selector) {
        return INVALID
      }
      return LINKED
    } finally { keyCopy.fill(0) }
  } catch { return INVALID }
}
