import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { inspectV4ActivationSettingsSwitchPlan, type V4ActivationSwitchPlanSources } from "./reencryption-activation-switch-plan-crypto"
import { assertV4ReencryptionCutoverSnapshotContract, type V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RECEIPT_DOMAIN = "v4-rekey-selector-commit-receipt-v1"
const SELECTOR_DOMAIN = "v4-rekey-selector-write-v1"
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MAX = 8 * 1024

/** The D231 plan and D230 decision must independently authenticate first. */
export interface V4SelectorCommitSources extends V4ActivationSwitchPlanSources {
  readonly settingsSwitchPlanCiphertext: string
}

export interface V4ActiveSelectorCommitPair {
  readonly receiptCiphertext: string
  readonly selectorCiphertext: string
}

interface CommitReceipt {
  readonly schemaVersion: 1
  readonly phase: "selector-commit-receipt-settings-pending"
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly settingsPlanCiphertextSha256: string
  readonly sourceIndexRoot: string
  readonly destinationIndexRoot: string
}
interface ActiveSelector {
  readonly schemaVersion: 1
  readonly phase: "destination-selector-written-settings-pending"
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly receiptCiphertextSha256: string
  readonly selectedIndexRoot: string
}

export interface V4ActiveSelectorCommitInspection {
  readonly integrityScope: "local-cryptographic-selector-commit-pair"
  readonly observation: "authenticated-destination-selector-settings-pending" | "manual-recovery-required"
  readonly artifactWindow: "both-linked" | "both-absent" | "receipt-only" | "selector-only" | "foreign-or-torn"
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "local-cryptographic-selector-commit-pair" as const,
  commitDecisionAuthorized: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const result = (
  observation: V4ActiveSelectorCommitInspection["observation"],
  artifactWindow: V4ActiveSelectorCommitInspection["artifactWindow"],
): V4ActiveSelectorCommitInspection => Object.freeze({ ...BASE, observation, artifactWindow })
const LINKED = result("authenticated-destination-selector-settings-pending", "both-linked")
const NONE = result("manual-recovery-required", "both-absent")
const RECEIPT = result("manual-recovery-required", "receipt-only")
const SELECTOR = result("manual-recovery-required", "selector-only")
const FOREIGN = result("manual-recovery-required", "foreign-or-torn")

const digest = (value: string) => sha256Hex(utf8ToBytes(value))
function aad(domain: string, contract: V4ReencryptionCutoverSnapshotContract): string {
  const id = contract.identity
  return domain + ":" + contract.transactionId + ":" + id.runId
    + ":" + id.sourceRepoId + ":" + id.destinationRepoId + ":" + id.destinationCommitSha
}
async function derivedKey(key: Uint8Array, domain: string): Promise<Uint8Array> {
  const raw = new Uint8Array(new ArrayBuffer(key.length))
  raw.set(key)
  const bytes = utf8ToBytes(domain + ":key")
  const message = new Uint8Array(new ArrayBuffer(bytes.length))
  message.set(bytes)
  try {
    const hmac = await crypto.subtle.importKey("raw", raw, {
      name: "HMAC", hash: "SHA-256",
    }, false, ["sign"])
    return new Uint8Array(await crypto.subtle.sign("HMAC", hmac, message))
  } finally { raw.fill(0); message.fill(0) }
}
async function linkedPlan(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4SelectorCommitSources,
  settings: V4LocalCutoverSettings,
): Promise<void> {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  if (!(key instanceof Uint8Array) || key.length !== 32
    || !sources || typeof sources.settingsSwitchPlanCiphertext !== "string"
    || sources.settingsSwitchPlanCiphertext.length > MAX
    || (await inspectV4ActivationSettingsSwitchPlan(
      contract, key, sources, settings, sources.settingsSwitchPlanCiphertext,
    )).observation !== "authenticated-settings-switch-plan-not-applied") {
    throw Error("D232 Selector requires the exact independently authenticated D231 Switch Plan.")
  }
}
async function receiptPayload(
  contract: V4ReencryptionCutoverSnapshotContract, sources: V4SelectorCommitSources,
): Promise<CommitReceipt> {
  const roots = planV4ReencryptionSeparatedRoots(contract.identity.indexRoot, contract.identity.runId)
  return {
    schemaVersion: 1, phase: "selector-commit-receipt-settings-pending",
    contract, settingsPlanCiphertextSha256: await digest(sources.settingsSwitchPlanCiphertext),
    sourceIndexRoot: roots.sourceIndexRoot, destinationIndexRoot: roots.shadowIndexRoot,
  }
}
async function selectorPayload(
  contract: V4ReencryptionCutoverSnapshotContract, receiptCiphertext: string,
): Promise<ActiveSelector> {
  const roots = planV4ReencryptionSeparatedRoots(contract.identity.indexRoot, contract.identity.runId)
  return {
    schemaVersion: 1, phase: "destination-selector-written-settings-pending",
    contract, receiptCiphertextSha256: await digest(receiptCiphertext),
    selectedIndexRoot: roots.shadowIndexRoot,
  }
}
async function seal(
  key: Uint8Array, domain: string,
  contract: V4ReencryptionCutoverSnapshotContract, payload: CommitReceipt | ActiveSelector,
): Promise<string> {
  let secret: Uint8Array | null = null
  const plain = utf8ToBytes(JSON.stringify(payload))
  try {
    if (plain.length > MAX / 2) throw Error("D232 Selector Commit payload exceeds byte limit.")
    secret = await derivedKey(key, domain)
    const sealed = await encryptV4Payload(secret, plain, {
      kind: "journal", aad: aad(domain, contract),
    })
    try {
      const encoded = toBase64(sealed)
      if (encoded.length > MAX) throw Error("D232 Selector Commit ciphertext exceeds byte limit.")
      return encoded
    } finally { sealed.fill(0) }
  } finally { secret?.fill(0); plain.fill(0) }
}
async function authenticate(
  key: Uint8Array, domain: string,
  contract: V4ReencryptionCutoverSnapshotContract,
  ciphertext: string, expected: CommitReceipt | ActiveSelector,
): Promise<boolean> {
  let secret: Uint8Array | null = null
  let decoded: Uint8Array | null = null
  let plain: Uint8Array | null = null
  try {
    if (ciphertext.length < 4 || ciphertext.length > MAX || !BASE64.test(ciphertext)) return false
    decoded = fromBase64(ciphertext)
    if (decoded.length > MAX || toBase64(decoded) !== ciphertext) return false
    secret = await derivedKey(key, domain)
    plain = await decryptV4Payload(secret, decoded, {
      kind: "journal", aad: aad(domain, contract),
    })
    return plain.length <= MAX / 2 && bytesToUtf8(plain) === JSON.stringify(expected)
  } catch { return false }
  finally { secret?.fill(0); decoded?.fill(0); plain?.fill(0) }
}

/** Seal linked first-Receipt, then selected-Destination bytes, never apply them. */
export async function sealV4ActiveSelectorCommitPair(
  contract: V4ReencryptionCutoverSnapshotContract, key: Uint8Array,
  sources: V4SelectorCommitSources, sourceSettings: V4LocalCutoverSettings,
): Promise<V4ActiveSelectorCommitPair> {
  const before = JSON.stringify({ contract, sources, sourceSettings })
  const pinnedKey = key.slice()
  try {
    await linkedPlan(contract, key, sources, sourceSettings)
    const receiptCiphertext = await seal(key, RECEIPT_DOMAIN, contract,
      await receiptPayload(contract, sources))
    const selectorCiphertext = await seal(key, SELECTOR_DOMAIN, contract,
      await selectorPayload(contract, receiptCiphertext))
    if (JSON.stringify({ contract, sources, sourceSettings }) !== before
      || !key.every((value, i) => value === pinnedKey[i])) {
      throw Error("D232 Selector Commit inputs mutated during sealing.")
    }
    return { receiptCiphertext, selectorCiphertext }
  } finally { pinnedKey.fill(0) }
}

/**
 * Crypto-only: an authentic pair proves a Destination selector was recorded,
 * not that Obsidian Settings changed or the currently frozen Git refs remain valid.
 */
export async function inspectV4ActiveSelectorCommitPair(
  contract: V4ReencryptionCutoverSnapshotContract, key: Uint8Array,
  sources: V4SelectorCommitSources, sourceSettings: V4LocalCutoverSettings,
  pair: { receiptCiphertext: string | null; selectorCiphertext: string | null },
): Promise<V4ActiveSelectorCommitInspection> {
  if (!pair || typeof pair !== "object") return FOREIGN
  if (pair.receiptCiphertext === null && pair.selectorCiphertext === null) return NONE
  if (pair.receiptCiphertext === null && typeof pair.selectorCiphertext === "string") return SELECTOR
  if (pair.selectorCiphertext === null && typeof pair.receiptCiphertext === "string") return RECEIPT
  if (typeof pair.receiptCiphertext !== "string"
    || typeof pair.selectorCiphertext !== "string"
    || !pair.receiptCiphertext || !pair.selectorCiphertext) return FOREIGN
  const before = JSON.stringify({ contract, sources, sourceSettings, pair })
  const pinned = key instanceof Uint8Array ? key.slice() : null
  try {
    await linkedPlan(contract, key, sources, sourceSettings)
    if (!await authenticate(key, RECEIPT_DOMAIN, contract, pair.receiptCiphertext,
      await receiptPayload(contract, sources))) return FOREIGN
    if (!await authenticate(key, SELECTOR_DOMAIN, contract, pair.selectorCiphertext,
      await selectorPayload(contract, pair.receiptCiphertext))) return FOREIGN
    if (before !== JSON.stringify({ contract, sources, sourceSettings, pair })
      || !key.every((value, i) => value === pinned![i])) return FOREIGN
    return LINKED
  } catch { return FOREIGN }
  finally { pinned?.fill(0) }
}
