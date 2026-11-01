import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import { inspectV4ReencryptionPendingCutoverIntent } from "./reencryption-cutover-intent-crypto"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"

const CONTEXT = "v4-rekey-cutover-activation-decision-v1"
const MAX = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export interface V4CutoverActivationDecisionSources {
  readonly manifest: string
  readonly receiptCiphertext: string
  readonly selectorCiphertext: string
  readonly intentCiphertext: string
}

interface ActivationDecision {
  readonly schemaVersion: 1
  readonly phase: "cutover-decision-recorded-activation-not-applied"
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly manifestSha256: string
  readonly intentCiphertextSha256: string
}

export interface V4CutoverActivationDecisionInspection {
  readonly integrityScope: "cutover-activation-decision-crypto-only"
  readonly observation: "authenticated-decision-activation-pending" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "cutover-activation-decision-crypto-only" as const,
  localCutoverAuthorized: false as const,
  commitDecisionAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const LINKED: V4CutoverActivationDecisionInspection =
  Object.freeze({ ...BASE, observation: "authenticated-decision-activation-pending" })
const MANUAL: V4CutoverActivationDecisionInspection =
  Object.freeze({ ...BASE, observation: "manual-recovery-required" })

function aad(contract: V4ReencryptionCutoverSnapshotContract): string {
  const id = contract.identity
  return CONTEXT + ":" + contract.transactionId + ":" + id.runId
    + ":" + id.sourceRepoId + ":" + id.sourceCommitSha
    + ":" + id.destinationRepoId + ":" + id.destinationCommitSha
}

async function deriveKey(key: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(new ArrayBuffer(key.byteLength))
  raw.set(key)
  const context = utf8ToBytes(CONTEXT + ":key")
  const message = new Uint8Array(new ArrayBuffer(context.byteLength))
  message.set(context)
  try {
    const hmac = await crypto.subtle.importKey(
      "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    return new Uint8Array(await crypto.subtle.sign("HMAC", hmac, message))
  } finally { raw.fill(0); message.fill(0) }
}

async function canonical(
  contract: V4ReencryptionCutoverSnapshotContract,
  sources: V4CutoverActivationDecisionSources,
): Promise<string> {
  return JSON.stringify({
    schemaVersion: 1,
    phase: "cutover-decision-recorded-activation-not-applied",
    contract,
    manifestSha256: await sha256Hex(utf8ToBytes(sources.manifest)),
    intentCiphertextSha256: await sha256Hex(utf8ToBytes(sources.intentCiphertext)),
  } satisfies ActivationDecision)
}

async function authenticateSources(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4CutoverActivationDecisionSources,
): Promise<void> {
  if (!(key instanceof Uint8Array) || key.length !== 32
    || !sources || Object.values(sources).some(v => typeof v !== "string" || v.length > MAX)
    || JSON.stringify(decodeV4ReencryptionCutoverCandidateManifest(sources.manifest))
      !== JSON.stringify(contract)
    || (await inspectV4ReencryptionPendingCutoverIntent(
      contract, key, {
        receiptCiphertext: sources.receiptCiphertext,
        selectorCiphertext: sources.selectorCiphertext,
      }, sources.intentCiphertext,
    )).observation !== "authenticated-intent-uncommitted") {
    throw Error("D230 source Candidate or pending Intent does not authenticate.")
  }
}

export async function sealV4CutoverActivationDecision(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4CutoverActivationDecisionSources,
): Promise<string> {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  const original = JSON.stringify(contract)
  const sourcesOriginal = JSON.stringify(sources)
  const keyOriginal = key.slice()
  let secret: Uint8Array | null = null
  let plain: Uint8Array | null = null
  try {
    await authenticateSources(contract, key, sources)
    plain = utf8ToBytes(await canonical(contract, sources))
    if (plain.byteLength > MAX / 2) throw Error("D230 decision plaintext exceeds byte limit.")
    secret = await deriveKey(key)
    const ciphertext = await encryptV4Payload(secret, plain, {
      kind: "journal", aad: aad(contract),
    })
    try {
      const encoded = toBase64(ciphertext)
      if (encoded.length > MAX || JSON.stringify(contract) !== original
        || JSON.stringify(sources) !== sourcesOriginal
        || !key.every((value, i) => value === keyOriginal[i])) {
        throw Error("D230 decision inputs changed during sealing.")
      }
      return encoded
    } finally { ciphertext.fill(0) }
  } finally {
    plain?.fill(0); secret?.fill(0); keyOriginal.fill(0)
  }
}

export async function inspectV4CutoverActivationDecision(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4CutoverActivationDecisionSources,
  encoded: string | null,
): Promise<V4CutoverActivationDecisionInspection> {
  let bytes: Uint8Array | null = null
  let secret: Uint8Array | null = null
  let plain: Uint8Array | null = null
  let pinnedKey: Uint8Array | null = null
  try {
    assertV4ReencryptionCutoverSnapshotContract(contract)
    if (!(key instanceof Uint8Array) || key.length !== 32
      || typeof encoded !== "string" || encoded.length < 4
      || encoded.length > MAX || !BASE64.test(encoded)) return MANUAL
    const original = JSON.stringify(contract)
    const inputs = JSON.stringify(sources)
    pinnedKey = key.slice()
    await authenticateSources(contract, key, sources)
    bytes = fromBase64(encoded)
    if (bytes.length > MAX || toBase64(bytes) !== encoded) return MANUAL
    secret = await deriveKey(key)
    plain = await decryptV4Payload(secret, bytes, {
      kind: "journal", aad: aad(contract),
    })
    if (plain.length > MAX / 2
      || bytesToUtf8(plain) !== await canonical(contract, sources)
      || JSON.stringify(contract) !== original
      || JSON.stringify(sources) !== inputs
      || !key.every((value, i) => value === pinnedKey![i])) return MANUAL
    return LINKED
  } catch { return MANUAL }
  finally {
    bytes?.fill(0); secret?.fill(0); plain?.fill(0); pinnedKey?.fill(0)
  }
}
