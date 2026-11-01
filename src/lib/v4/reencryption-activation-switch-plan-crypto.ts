import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { inspectV4CutoverActivationDecision, type V4CutoverActivationDecisionSources } from "./reencryption-activation-decision-crypto"
import { assertV4ReencryptionCutoverSnapshotContract, type V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const CONTEXT = "v4-rekey-activation-settings-switch-plan-v1"
const MAX_BYTES = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const SETTINGS_KEYS = "encryptionMode|encryptionPassphraseSecretId|githubBranch|githubOwner|githubRepo|vault"
export interface V4ActivationSwitchPlanSources extends V4CutoverActivationDecisionSources {
  readonly activationDecisionCiphertext: string
}

export interface V4ActivationSettingsSwitchPlan {
  readonly schemaVersion: 1
  readonly phase: "settings-switch-plan-sealed-not-applied"
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly activationDecisionCiphertextSha256: string
  readonly sourceIndexRoot: string
  readonly destinationIndexRoot: string
  readonly sourceSettings: V4LocalCutoverSettings
  readonly destinationSettings: V4LocalCutoverSettings
}

export interface V4ActivationSettingsSwitchPlanInspection {
  readonly integrityScope: "activation-settings-switch-plan-crypto-only"
  readonly observation: "authenticated-settings-switch-plan-not-applied" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "activation-settings-switch-plan-crypto-only" as const,
  localCutoverAuthorized: false as const, commitDecisionAuthorized: false as const,
  resumeSyncAuthorized: false as const, rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const, oldPassphraseCleanupAuthorized: false as const,
})
const LINKED: V4ActivationSettingsSwitchPlanInspection = Object.freeze({
  ...BASE, observation: "authenticated-settings-switch-plan-not-applied",
})
const MANUAL: V4ActivationSettingsSwitchPlanInspection = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
})
const digest = (value: string) => sha256Hex(utf8ToBytes(value))

function aad(contract: V4ReencryptionCutoverSnapshotContract): string {
  const id = contract.identity
  return CONTEXT + ":" + contract.transactionId + ":" + id.runId
    + ":" + id.sourceRepoId + ":" + id.destinationRepoId
    + ":" + id.destinationCommitSha
}
async function deriveKey(key: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(new ArrayBuffer(key.length))
  raw.set(key)
  const context = utf8ToBytes(CONTEXT + ":key")
  const message = new Uint8Array(new ArrayBuffer(context.length))
  message.set(context)
  try {
    const hmac = await crypto.subtle.importKey(
      "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    return new Uint8Array(await crypto.subtle.sign("HMAC", hmac, message))
  } finally { raw.fill(0); message.fill(0) }
}

function exactSettingsShape(settings: V4LocalCutoverSettings): boolean {
  return !!settings && typeof settings === "object" && !Array.isArray(settings)
    && Object.keys(settings).sort().join("|") === SETTINGS_KEYS
    && Object.values(settings).every(value => typeof value === "string")
}

async function buildPlan(
  contract: V4ReencryptionCutoverSnapshotContract,
  sourceSettings: V4LocalCutoverSettings,
  decisionCiphertext: string,
): Promise<V4ActivationSettingsSwitchPlan> {
  assertV4ReencryptionCutoverSnapshotContract(contract)
  if (!exactSettingsShape(sourceSettings) || typeof decisionCiphertext !== "string"
    || decisionCiphertext.length > MAX_BYTES) {
    throw Error("D231 Settings switch plan needs exact persisted source Settings and encrypted decision.")
  }
  const id = contract.identity
  const oldRepo = sourceSettings.githubOwner + "/" + sourceSettings.githubRepo
    + "#" + sourceSettings.githubBranch
  const newBranch = id.destinationRepoId.split("#")[1]
  if (!newBranch || oldRepo !== id.sourceRepoId
    || sourceSettings.encryptionMode !== "encrypted"
    || sourceSettings.vault !== id.deviceId
    || sourceSettings.encryptionPassphraseSecretId !== id.sourcePassphraseSecretId) {
    throw Error("D231 persisted Settings do not select the original Source.")
  }
  const destinationSettings = {
    ...sourceSettings, githubBranch: newBranch,
    encryptionPassphraseSecretId: id.destinationPassphraseSecretId,
  }
  if (sourceSettings.githubOwner + "/" + sourceSettings.githubRepo
    + "#" + destinationSettings.githubBranch !== id.destinationRepoId
    || await digest(JSON.stringify(sourceSettings)) !== contract.sourceSettingsSha256
    || await digest(JSON.stringify(destinationSettings)) !== contract.destinationSettingsSha256) {
    throw Error("D231 Settings switch is not the authenticated D183 transition.")
  }
  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  return {
    schemaVersion: 1, phase: "settings-switch-plan-sealed-not-applied", contract,
    activationDecisionCiphertextSha256: await digest(decisionCiphertext),
    sourceIndexRoot: roots.sourceIndexRoot,
    destinationIndexRoot: roots.shadowIndexRoot,
    sourceSettings, destinationSettings,
  }
}

async function authenticateInputs(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4ActivationSwitchPlanSources,
): Promise<void> {
  if (!(key instanceof Uint8Array) || key.length !== 32
    || !sources || (await inspectV4CutoverActivationDecision(
      contract, key, sources, sources.activationDecisionCiphertext,
    )).observation !== "authenticated-decision-activation-pending") {
    throw Error("D231 Settings switch cannot refer to foreign pending activation decision.")
  }
}

/**
 * Canonical encrypted record binds the exact persisted Source Settings,
 * derived Destination Settings, immutable Source/Shadow roots and D230
 * encrypted decision. No actual active root is changed by this codec.
 */
export async function sealV4ActivationSettingsSwitchPlan(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4ActivationSwitchPlanSources,
  sourceSettings: V4LocalCutoverSettings,
): Promise<string> {
  const before = JSON.stringify({ contract, sources, sourceSettings })
  const keyBefore = key.slice()
  let secret: Uint8Array | null = null
  let plain: Uint8Array | null = null
  try {
    await authenticateInputs(contract, key, sources)
    const plan = await buildPlan(contract, sourceSettings, sources.activationDecisionCiphertext)
    plain = utf8ToBytes(JSON.stringify(plan))
    if (plain.length > MAX_BYTES / 2) throw Error("D231 encrypted Settings plan exceeds size limit.")
    secret = await deriveKey(key)
    const bytes = await encryptV4Payload(secret, plain, { kind: "journal", aad: aad(contract) })
    try {
      const ciphertext = toBase64(bytes)
      if (ciphertext.length > MAX_BYTES
        || JSON.stringify({ contract, sources, sourceSettings }) !== before
        || !key.every((value, i) => value === keyBefore[i])) {
        throw Error("D231 Settings plan inputs drifted during sealing.")
      }
      return ciphertext
    } finally { bytes.fill(0) }
  } finally { plain?.fill(0); secret?.fill(0); keyBefore.fill(0) }
}

export async function inspectV4ActivationSettingsSwitchPlan(
  contract: V4ReencryptionCutoverSnapshotContract,
  key: Uint8Array,
  sources: V4ActivationSwitchPlanSources,
  sourceSettings: V4LocalCutoverSettings,
  ciphertext: string | null,
): Promise<V4ActivationSettingsSwitchPlanInspection> {
  let bytes: Uint8Array | null = null
  let secret: Uint8Array | null = null
  let plain: Uint8Array | null = null
  let keyBefore: Uint8Array | null = null
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32
      || typeof ciphertext !== "string" || ciphertext.length < 4
      || ciphertext.length > MAX_BYTES || !BASE64.test(ciphertext)) return MANUAL
    const before = JSON.stringify({ contract, sources, sourceSettings })
    keyBefore = key.slice()
    await authenticateInputs(contract, key, sources)
    const expected = await buildPlan(contract, sourceSettings, sources.activationDecisionCiphertext)
    bytes = fromBase64(ciphertext)
    if (toBase64(bytes) !== ciphertext || bytes.length > MAX_BYTES) return MANUAL
    secret = await deriveKey(key)
    plain = await decryptV4Payload(secret, bytes, { kind: "journal", aad: aad(contract) })
    if (plain.length > MAX_BYTES / 2
      || bytesToUtf8(plain) !== JSON.stringify(expected)
      || before !== JSON.stringify({ contract, sources, sourceSettings })
      || !key.every((value, i) => value === keyBefore![i])) return MANUAL
    return LINKED
  } catch { return MANUAL }
  finally { bytes?.fill(0); secret?.fill(0); plain?.fill(0); keyBefore?.fill(0) }
}
