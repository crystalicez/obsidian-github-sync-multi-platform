import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"

/**
 * D223 defines a distinct production-NAMESPACE wire format for the eventual
 * best-effort cutover. This module only seals/inspects CANDIDATE bytes.
 *
 * D182 test vectors MUST NOT be cast or migrated into this format. A
 * cryptographically valid pair does NOT authorize cutover: the future writer
 * must separately prove remote Git content, fenced WAL, persisted transaction
 * state, OS best-effort checkpoint, local Settings/Index/Secrets and restarted
 * runtime selector semantics. No live branch/Settings/Index writers here.
 */
export type V4ReencryptionCutoverCandidateContract = V4ReencryptionCutoverSnapshotContract

const RECEIPT_CONTEXT = "v4-rekey-cutover-receipt-candidate-v1"
const SELECTOR_CONTEXT = "v4-rekey-cutover-selector-candidate-v1"
const MAX_CIPHERTEXT = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const SHA = /^[0-9a-f]{64}$/u

type Role = "receipt" | "selector"
interface ReceiptCandidate {
  readonly schemaVersion: 1
  readonly phase: "cutover-receipt-candidate-uncommitted"
  readonly contract: V4ReencryptionCutoverCandidateContract
}
interface SelectorCandidate {
  readonly schemaVersion: 1
  readonly phase: "cutover-selector-candidate-uncommitted"
  readonly contract: V4ReencryptionCutoverCandidateContract
  readonly receiptCiphertextSha256: string
}

export interface V4ReencryptionCutoverCandidatePair {
  readonly receiptCiphertext: string
  readonly selectorCiphertext: string
}

export interface V4ReencryptionCutoverCandidateInspection {
  readonly integrityScope: "production-namespace-cutover-candidate-crypto-only"
  readonly observation: "cryptographically-linked-candidate-uncommitted" | "manual-recovery-required"
  readonly reason: "candidate-pair-linked-no-commit-proof" | "both-absent"
    | "one-sided-or-torn" | "invalid-or-foreign-ciphertext"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "production-namespace-cutover-candidate-crypto-only" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})

function report(
  observation: V4ReencryptionCutoverCandidateInspection["observation"],
  reason: V4ReencryptionCutoverCandidateInspection["reason"],
): V4ReencryptionCutoverCandidateInspection {
  return Object.freeze({ ...BASE, observation, reason })
}

const LINKED = report("cryptographically-linked-candidate-uncommitted", "candidate-pair-linked-no-commit-proof")
const NONE = report("manual-recovery-required", "both-absent")
const PARTIAL = report("manual-recovery-required", "one-sided-or-torn")
const INVALID = report("manual-recovery-required", "invalid-or-foreign-ciphertext")

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw Error("Cutover candidate requires an independently authenticated 32-byte journal key.")
  }
}

function context(role: Role): string {
  return role === "receipt" ? RECEIPT_CONTEXT : SELECTOR_CONTEXT
}

function receiptRecord(contract: V4ReencryptionCutoverCandidateContract): ReceiptCandidate {
  return { schemaVersion: 1, phase: "cutover-receipt-candidate-uncommitted", contract }
}

function selectorRecord(
  contract: V4ReencryptionCutoverCandidateContract, receiptSha: string,
): SelectorCandidate {
  if (!SHA.test(receiptSha)) throw Error("Invalid cutover candidate encrypted Receipt digest.")
  return {
    schemaVersion: 1, phase: "cutover-selector-candidate-uncommitted",
    contract, receiptCiphertextSha256: receiptSha,
  }
}

async function roleKey(journalKey: Uint8Array, role: Role): Promise<Uint8Array> {
  const hmac = await crypto.subtle.importKey(
    "raw", journalKey as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC", hmac, utf8ToBytes(context(role) + ":key") as any,
  ))
}

function aad(contract: V4ReencryptionCutoverCandidateContract, role: Role): string {
  const id = contract.identity
  return context(role) + ":" + contract.transactionId
    + ":" + id.runId + ":" + id.sourceCommitSha + ":" + id.destinationRepoId
    + ":" + id.destinationCommitSha
}

async function seal(
  contract: V4ReencryptionCutoverCandidateContract,
  journalKey: Uint8Array,
  role: Role,
  receiptSha?: string,
): Promise<string> {
  const clear = utf8ToBytes(role === "receipt"
    ? JSON.stringify(receiptRecord(contract))
    : JSON.stringify(selectorRecord(contract, receiptSha ?? "")))
  if (clear.byteLength > MAX_CIPHERTEXT / 2) {
    clear.fill(0)
    throw Error("Cutover candidate payload exceeds safe limit.")
  }
  let key: Uint8Array | null = null
  try {
    key = await roleKey(journalKey, role)
    const encrypted = await encryptV4Payload(key, clear, {
      kind: "journal", aad: aad(contract, role),
    })
    try {
      const encoded = toBase64(encrypted)
      if (encoded.length > MAX_CIPHERTEXT) throw Error("Cutover candidate ciphertext too large.")
      return encoded
    } finally { encrypted.fill(0) }
  } finally { key?.fill(0); clear.fill(0) }
}

function decode(encoded: string): Uint8Array | null {
  if (typeof encoded !== "string" || encoded.length < 4
    || encoded.length > MAX_CIPHERTEXT || !BASE64.test(encoded)) return null
  try {
    const bytes = fromBase64(encoded)
    if (bytes.byteLength > MAX_CIPHERTEXT || toBase64(bytes) !== encoded) {
      bytes.fill(0)
      return null
    }
    return bytes
  } catch { return null }
}

async function authenticate(
  contract: V4ReencryptionCutoverCandidateContract, journalKey: Uint8Array,
  role: Role, encoded: string, receiptSha?: string,
): Promise<boolean> {
  const bytes = decode(encoded)
  if (!bytes) return false
  let roleSecret: Uint8Array | null = null
  try {
    roleSecret = await roleKey(journalKey, role)
    let plaintext: Uint8Array
    try {
      plaintext = await decryptV4Payload(roleSecret, bytes, {
        kind: "journal", aad: aad(contract, role),
      })
    } catch { return false }
    try {
      if (plaintext.byteLength > MAX_CIPHERTEXT / 2) return false
      const expected = role === "receipt"
        ? JSON.stringify(receiptRecord(contract))
        : JSON.stringify(selectorRecord(contract, receiptSha ?? ""))
      return bytesToUtf8(plaintext) === expected
    } finally { plaintext.fill(0) }
  } finally { roleSecret?.fill(0); bytes.fill(0) }
}

/**
 * Produce domain-separated encrypted CANDIDATES for a future real transaction
 * writer. The caller MUST supply independently verified Source/Shadow/WAL/
 * Settings digests; this function cannot establish that provenance.
 */
export async function sealV4ReencryptionCutoverCandidatePair(
  contract: V4ReencryptionCutoverCandidateContract,
  journalKey: Uint8Array,
): Promise<V4ReencryptionCutoverCandidatePair> {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  assertKey(journalKey)
  const original = JSON.stringify(contract)
  const originalKey = Uint8Array.from(journalKey)
  try {
    const receiptCiphertext = await seal(contract, journalKey, "receipt")
    if (JSON.stringify(contract) !== original
      || !journalKey.every((value, i) => value === originalKey[i])) {
      throw Error("Cutover candidate changed during Receipt sealing.")
    }
    const digest = await sha256Hex(utf8ToBytes(receiptCiphertext))
    const selectorCiphertext = await seal(contract, journalKey, "selector", digest)
    if (JSON.stringify(contract) !== original
      || !journalKey.every((value, i) => value === originalKey[i])) {
      throw Error("Cutover candidate changed during Selector sealing.")
    }
    return Object.freeze({ receiptCiphertext, selectorCiphertext })
  } finally { originalKey.fill(0) }
}

/**
 * Cryptographic format test only: linked records are ALWAYS uncommitted until
 * the future persisted commit protocol + restart-safe runtime proves authority.
 */
export async function inspectV4ReencryptionCutoverCandidatePair(
  contract: V4ReencryptionCutoverCandidateContract,
  journalKey: Uint8Array,
  pair: {
    readonly receiptCiphertext: string | null
    readonly selectorCiphertext: string | null
  } | null,
): Promise<V4ReencryptionCutoverCandidateInspection> {
  try {
    assertV4ReencryptionCutoverSnapshotContract(contract)
    assertKey(journalKey)
    if (!pair) return INVALID
    const receipt = pair.receiptCiphertext
    const selector = pair.selectorCiphertext
    if (receipt === null && selector === null) return NONE
    if (receipt === null || selector === null) return PARTIAL
    if (typeof receipt !== "string" || typeof selector !== "string") return INVALID
    const original = JSON.stringify(contract)
    const originalKey = Uint8Array.from(journalKey)
    try {
      if (!await authenticate(contract, journalKey, "receipt", receipt)) return INVALID
      const digest = await sha256Hex(utf8ToBytes(receipt))
      if (!await authenticate(contract, journalKey, "selector", selector, digest)
        || JSON.stringify(contract) !== original
        || !journalKey.every((value, i) => value === originalKey[i])
        || pair.receiptCiphertext !== receipt || pair.selectorCiphertext !== selector) {
        return INVALID
      }
      return LINKED
    } finally { originalKey.fill(0) }
  } catch { return INVALID }
}
