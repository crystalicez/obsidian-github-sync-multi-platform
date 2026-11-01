import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import {
  inspectV4ReencryptionCutoverCandidatePair,
  type V4ReencryptionCutoverCandidatePair,
} from "./reencryption-cutover-candidate-crypto"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"

const CONTEXT = "v4-rekey-cutover-intent-pending-v1"
const MAX_CIPHERTEXT = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

interface PendingIntent {
  readonly schemaVersion: 1
  readonly phase: "cutover-intent-pending-uncommitted"
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly receiptCiphertextSha256: string
  readonly selectorCiphertextSha256: string
}

export interface V4ReencryptionCutoverIntentInspection {
  readonly integrityScope: "production-namespace-cutover-intent-crypto-only"
  readonly observation: "authenticated-intent-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "production-namespace-cutover-intent-crypto-only" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const LINKED: V4ReencryptionCutoverIntentInspection =
  Object.freeze({ ...BASE, observation: "authenticated-intent-uncommitted" })
const MANUAL: V4ReencryptionCutoverIntentInspection =
  Object.freeze({ ...BASE, observation: "manual-recovery-required" })

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw Error("Cutover intent needs the authenticated 32-byte journal key.")
  }
}

function aad(contract: V4ReencryptionCutoverSnapshotContract): string {
  const id = contract.identity
  return CONTEXT + ":" + contract.transactionId + ":" + id.runId
    + ":" + id.sourceCommitSha + ":" + id.destinationRepoId
    + ":" + id.destinationCommitSha
}

async function intentKey(journalKey: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", journalKey as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, utf8ToBytes(CONTEXT + ":key") as any,
  ))
}

async function canonicalIntent(
  contract: V4ReencryptionCutoverSnapshotContract,
  pair: V4ReencryptionCutoverCandidatePair,
): Promise<string> {
  return JSON.stringify({
    schemaVersion: 1, phase: "cutover-intent-pending-uncommitted",
    contract,
    receiptCiphertextSha256: await sha256Hex(utf8ToBytes(pair.receiptCiphertext)),
    selectorCiphertextSha256: await sha256Hex(utf8ToBytes(pair.selectorCiphertext)),
  } satisfies PendingIntent)
}

async function assertCandidate(
  contract: V4ReencryptionCutoverSnapshotContract,
  journalKey: Uint8Array,
  pair: V4ReencryptionCutoverCandidatePair,
): Promise<void> {
  if (!pair || (await inspectV4ReencryptionCutoverCandidatePair(
    contract, journalKey, pair,
  )).observation !== "cryptographically-linked-candidate-uncommitted") {
    throw Error("Cutover intent cannot refer to a foreign or torn Candidate.")
  }
}

/**
 * A distinct authenticated, encrypted commitment *intent*, not a Commit.
 * Without a later independently verified active Settings/Index/Selector
 * transaction these bytes cannot authorize any local or remote operation.
 */
export async function sealV4ReencryptionPendingCutoverIntent(
  contract: V4ReencryptionCutoverSnapshotContract,
  journalKey: Uint8Array,
  pair: V4ReencryptionCutoverCandidatePair,
): Promise<string> {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  assertKey(journalKey)
  const beforeContract = JSON.stringify(contract)
  const beforeReceipt = pair?.receiptCiphertext
  const beforeSelector = pair?.selectorCiphertext
  const pinnedKey = journalKey.slice()
  let secret: Uint8Array | null = null
  let plaintext: Uint8Array | null = null
  try {
    await assertCandidate(contract, journalKey, pair)
    const serialized = await canonicalIntent(contract, pair)
    plaintext = utf8ToBytes(serialized)
    if (plaintext.byteLength > MAX_CIPHERTEXT / 2) {
      throw Error("Cutover intent payload is too large.")
    }
    secret = await intentKey(journalKey)
    const encrypted = await encryptV4Payload(secret, plaintext, {
      kind: "journal", aad: aad(contract),
    })
    try {
      const encoded = toBase64(encrypted)
      if (encoded.length > MAX_CIPHERTEXT) throw Error("Cutover intent ciphertext is too large.")
      if (beforeContract !== JSON.stringify(contract)
        || beforeReceipt !== pair.receiptCiphertext
        || beforeSelector !== pair.selectorCiphertext
        || !journalKey.every((value, i) => value === pinnedKey[i])) {
        throw Error("Cutover intent source mutated during encryption.")
      }
      return encoded
    } finally { encrypted.fill(0) }
  } finally { secret?.fill(0); plaintext?.fill(0); pinnedKey.fill(0) }
}

export async function inspectV4ReencryptionPendingCutoverIntent(
  contract: V4ReencryptionCutoverSnapshotContract,
  journalKey: Uint8Array,
  pair: V4ReencryptionCutoverCandidatePair | null,
  encoded: string | null,
): Promise<V4ReencryptionCutoverIntentInspection> {
  let bytes: Uint8Array | null = null
  let secret: Uint8Array | null = null
  let plaintext: Uint8Array | null = null
  let pinnedKey: Uint8Array | null = null
  try {
    assertV4ReencryptionCutoverSnapshotContract(contract)
    assertKey(journalKey)
    if (!pair || typeof encoded !== "string" || encoded.length < 4
      || encoded.length > MAX_CIPHERTEXT || !BASE64.test(encoded)) return MANUAL
    const initialContract = JSON.stringify(contract)
    const receipt = pair.receiptCiphertext
    const selector = pair.selectorCiphertext
    pinnedKey = journalKey.slice()
    await assertCandidate(contract, journalKey, pair)
    bytes = fromBase64(encoded)
    if (bytes.byteLength > MAX_CIPHERTEXT || toBase64(bytes) !== encoded) return MANUAL
    secret = await intentKey(journalKey)
    plaintext = await decryptV4Payload(secret, bytes, {
      kind: "journal", aad: aad(contract),
    })
    if (plaintext.byteLength > MAX_CIPHERTEXT / 2) return MANUAL
    const expected = await canonicalIntent(contract, pair)
    if (bytesToUtf8(plaintext) !== expected
      || initialContract !== JSON.stringify(contract)
      || pair.receiptCiphertext !== receipt || pair.selectorCiphertext !== selector
      || !journalKey.every((value, i) => value === pinnedKey![i])) return MANUAL
    return LINKED
  } catch { return MANUAL }
  finally {
    plaintext?.fill(0); secret?.fill(0); bytes?.fill(0); pinnedKey?.fill(0)
  }
}
