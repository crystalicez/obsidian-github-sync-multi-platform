import { sha256Hex, utf8ToBytes } from "../bytes"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndexAdapter } from "./local-index"
import {
  decodeV4ReencryptionCutoverCandidateManifest,
} from "./reencryption-cutover-candidate-manifest"
import { V4_RUNTIME_INDEX_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"
export { V4_REENCRYPTION_RUNTIME_ROUTE_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "./reencryption-sync-fence"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"
import type { V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"

const DOMAIN = "v4-rekey-runtime-index-route-intent-v1"
const SHA = /^[0-9a-f]{64}$/u
const MAX = 4096
const MAX_NATIVE = 256 * 1024

interface RouteBody {
  readonly schemaVersion: 1
  readonly phase: "destination-index-route-fenced-settings-pending"
  readonly runId: string
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly sourceIndexRoot: string
  readonly shadowIndexRoot: string
  readonly selectorCiphertextSha256: string
  readonly settingsIntentSha256: string
  readonly contractSha256: string
}
export interface V4ReencryptionRuntimeRouteRecord extends RouteBody {
  readonly mac: string
}
export interface V4ReencryptionColdStartRouteReport {
  readonly integrityScope: "read-only-persisted-index-route-hint"
  readonly observation: "no-routing-artifact" | "fenced-before-routing-intent"
    | "source-settings-pending" | "destination-shadow-diagnostic-only"
    | "manual-recovery-required"
  /** A diagnostic read location, NEVER an active Sync write location. */
  readonly diagnosticIndexRoot: string | null
  readonly routingHintAuthenticated: boolean
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "read-only-persisted-index-route-hint" as const,
  commitDecisionAuthorized: false as const, localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const, rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const, oldPassphraseCleanupAuthorized: false as const,
})
const report = (
  observation: V4ReencryptionColdStartRouteReport["observation"],
  diagnosticIndexRoot: string | null = null,
  routingHintAuthenticated = false,
): V4ReencryptionColdStartRouteReport =>
  Object.freeze({ ...BASE, observation, diagnosticIndexRoot, routingHintAuthenticated })
const MANUAL = report("manual-recovery-required")
const INACTIVE = report("no-routing-artifact")
const PREPARED = report("fenced-before-routing-intent")
const digest = (value: string) => sha256Hex(utf8ToBytes(value))

async function hmac(key: Uint8Array, payload: string, domain = DOMAIN): Promise<string> {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw Error("D234 invalid journal key.")
  const raw = new Uint8Array(new ArrayBuffer(key.length))
  raw.set(key)
  const encoded = utf8ToBytes(domain + ":" + payload)
  const message = new Uint8Array(new ArrayBuffer(encoded.length))
  message.set(encoded)
  try {
    const imported = await crypto.subtle.importKey(
      "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", imported, message)),
      b => b.toString(16).padStart(2, "0")).join("")
  } finally { raw.fill(0); message.fill(0) }
}
function body(value: unknown): value is RouteBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Partial<RouteBody>
  if (o.schemaVersion !== 1 || o.phase !== "destination-index-route-fenced-settings-pending"
    || typeof o.runId !== "string" || typeof o.sourceRepoId !== "string"
    || typeof o.destinationRepoId !== "string"
    || typeof o.sourceIndexRoot !== "string" || typeof o.shadowIndexRoot !== "string"
    || typeof o.selectorCiphertextSha256 !== "string"
    || typeof o.settingsIntentSha256 !== "string" || typeof o.contractSha256 !== "string"
    || !SHA.test(o.selectorCiphertextSha256) || !SHA.test(o.settingsIntentSha256)
    || !SHA.test(o.contractSha256)) return false
  try {
    const roots = planV4ReencryptionSeparatedRoots(o.sourceIndexRoot, o.runId)
    return o.sourceIndexRoot === V4_RUNTIME_INDEX_ROOT
      && o.shadowIndexRoot === roots.shadowIndexRoot
      && o.sourceRepoId !== o.destinationRepoId
      && o.sourceRepoId.split("#")[0] === o.destinationRepoId.split("#")[0]
  } catch { return false }
}
function routeBody(
  contract: V4ReencryptionCutoverSnapshotContract,
  selectorSha: string, intentSha: string, contractSha: string,
): RouteBody {
  const id = contract.identity
  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  return {
    schemaVersion: 1,
    phase: "destination-index-route-fenced-settings-pending",
    runId: id.runId, sourceRepoId: id.sourceRepoId,
    destinationRepoId: id.destinationRepoId,
    sourceIndexRoot: roots.sourceIndexRoot, shadowIndexRoot: roots.shadowIndexRoot,
    selectorCiphertextSha256: selectorSha, settingsIntentSha256: intentSha,
    contractSha256: contractSha,
  }
}
/** Persist an authenticated *blocker* before native Settings, not a Sync permission. */
export async function sealV4RuntimeIndexRouteIntent(
  contract: V4ReencryptionCutoverSnapshotContract, key: Uint8Array,
  selectorCiphertext: string, settingsWriteIntent: string, serializedContract: string,
): Promise<string> {
  const route = routeBody(
    contract, await digest(selectorCiphertext),
    await digest(settingsWriteIntent), await digest(serializedContract),
  )
  if (!body(route)) throw Error("D234 invalid fenced Runtime route identity.")
  const record: V4ReencryptionRuntimeRouteRecord = {
    ...route, mac: await hmac(key, JSON.stringify(route)),
  }
  const serialized = JSON.stringify(record)
  if (utf8ToBytes(serialized).length > MAX) throw Error("D234 route intent oversized.")
  return serialized
}
/** Verify one HMAC-bound persistent routing hint; it never authorizes Index writes. */
export async function authenticateV4RuntimeIndexRouteIntent(
  serialized: string, key: Uint8Array,
): Promise<V4ReencryptionRuntimeRouteRecord> {
  if (typeof serialized !== "string" || serialized.length > MAX) {
    throw Error("D234 routing hint missing or oversized.")
  }
  const parsed: unknown = JSON.parse(serialized)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Error("D234 malformed routing hint.")
  }
  const record = parsed as Partial<V4ReencryptionRuntimeRouteRecord>
  const { mac, ...fields } = record
  if (!body(fields) || typeof mac !== "string" || !SHA.test(mac)
    || Object.keys(parsed).sort().join("|") !==
    "contractSha256|destinationRepoId|mac|phase|runId|schemaVersion|selectorCiphertextSha256|settingsIntentSha256|shadowIndexRoot|sourceIndexRoot|sourceRepoId"
    || JSON.stringify({ ...fields, mac }) !== serialized
    || await hmac(key, JSON.stringify(fields)) !== mac) {
    throw Error("D234 foreign or tampered routing hint.")
  }
  return record as V4ReencryptionRuntimeRouteRecord
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function settingsIdentity(value: unknown): { repoId: string; secretId: string; deviceId: string; mode: string } | null {
  if (!isRecord(value)) return null
  const nested = isRecord(value["settings"]) ? value["settings"] : value
  const owner = nested["githubOwner"]
  const repo = nested["githubRepo"]
  const branch = nested["githubBranch"]
  const mode = nested["encryptionMode"]
  const secretId = nested["encryptionPassphraseSecretId"]
  const deviceId = nested["vault"]
  return typeof owner === "string" && typeof repo === "string"
    && typeof branch === "string" && typeof mode === "string"
    && typeof secretId === "string" && typeof deviceId === "string"
    ? { repoId: owner + "/" + repo + "#" + branch, mode, secretId, deviceId } : null
}
export interface V4ReencryptionColdStartRouteInput {
  readonly adapter: Pick<V4LocalIndexAdapter, "exists" | "read">
  /** Direct native data.json read, not a mutated in-memory Settings draft. */
  readonly readPersistedPluginData: () => Promise<unknown>
  readonly getSecret?: ((id: string) => string | null) | undefined
  /** Only available after independently rederiving the old key from trusted remote config. */
  readonly journalKey?: Uint8Array | undefined
}

/**
 * Scan one *fixed* routing pointer on a freshly started client, no previous
 * initiating-device object graph. It is untrusted until the journal MAC can
 * be verified; even with the MAC, independent Git+WAL proof is still missing.
 *
 * Never choose the diagnostic root as a Sync writer. An incomplete or erased
 * physical fence remains Manual Recovery rather than a rollback hint.
 */
export async function inspectV4ReencryptionColdStartIndexRoute(
  input: V4ReencryptionColdStartRouteInput,
): Promise<V4ReencryptionColdStartRouteReport> {
  try {
    const { adapter } = input
    const hasRoute = await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
    const hasMarker = await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
    const fenced = await adapter.exists(V4_REENCRYPTION_SYNC_FENCE_ROOT)
    if (!hasRoute && !hasMarker) return fenced ? PREPARED : INACTIVE
    if (!hasRoute || !hasMarker || !fenced) return MANUAL

    const serialized = await adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
    if (serialized.length > MAX) return MANUAL
    const parsed: unknown = JSON.parse(serialized)
    if (!isRecord(parsed)) return MANUAL
    const { mac, ...fields } = parsed
    if (!body(fields) || typeof mac !== "string" || !SHA.test(mac)
      || JSON.stringify({ ...fields, mac }) !== serialized) return MANUAL
    const route = fields
    const fenceText = await adapter.read(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json")
    const fence = JSON.stringify({
      schemaVersion: 1,
      phase: "migration-fenced-uncommitted",
      runId: route.runId, sourceRepoId: route.sourceRepoId,
      destinationRepoId: route.destinationRepoId,
    })
    if (fenceText !== fence) return MANUAL
    const candidateRoot = route.sourceIndexRoot + "-rekey-cutover-candidate-" + route.runId
    const contractText = await adapter.read(candidateRoot + "/contract.json")
    if (await digest(contractText) !== route.contractSha256) return MANUAL
    const contract = decodeV4ReencryptionCutoverCandidateManifest(contractText)
    const id = contract.identity
    if (id.runId !== route.runId || id.indexRoot !== route.sourceIndexRoot
      || id.sourceRepoId !== route.sourceRepoId
      || id.destinationRepoId !== route.destinationRepoId) return MANUAL

    const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
    const receiptPath = candidateRoot + "/selector-commit-receipt.json"
    const selectorCiphertext = await adapter.read(roots.selectorPath)
    const receiptCiphertext = await adapter.read(receiptPath)
    const settingsIntentText = await adapter.read(candidateRoot + "/persisted-settings-write-intent.json")
    if (!receiptCiphertext.length
      || await digest(selectorCiphertext) !== route.selectorCiphertextSha256
      || await digest(settingsIntentText) !== route.settingsIntentSha256) return MANUAL
    if (settingsIntentText.length > MAX) return MANUAL
    const intentRaw: unknown = JSON.parse(settingsIntentText)
    if (!isRecord(intentRaw)) return MANUAL
    const { mac: intentMac, ...intentFields } = intentRaw
    if (Object.keys(intentRaw).sort().join("|") !==
      "destinationDataSha256|mac|phase|receiptCiphertextSha256|schemaVersion|selectorCiphertextSha256|sourceDataSha256|transactionId"
      || intentRaw["schemaVersion"] !== 1
      || intentRaw["phase"] !== "plugin-settings-write-intent-fence-held"
      || intentRaw["transactionId"] !== contract.transactionId
      || intentRaw["selectorCiphertextSha256"] !== route.selectorCiphertextSha256
      || intentRaw["receiptCiphertextSha256"] !== await digest(receiptCiphertext)
      || typeof intentMac !== "string" || !SHA.test(intentMac)
      || typeof intentRaw["sourceDataSha256"] !== "string"
      || !SHA.test(intentRaw["sourceDataSha256"])
      || typeof intentRaw["destinationDataSha256"] !== "string"
      || !SHA.test(intentRaw["destinationDataSha256"])
      || JSON.stringify({ ...intentFields, mac: intentMac }) !== settingsIntentText) return MANUAL
    if (input.journalKey) {
      await authenticateV4RuntimeIndexRouteIntent(serialized, input.journalKey)
      if (await hmac(
        input.journalKey, JSON.stringify(intentFields),
        "v4-rekey-plugin-settings-write-intent-v1",
      ) !== intentMac) return MANUAL
    }

    const [source, shadow, persistedData] = await Promise.all([
      loadV4LocalIndex(adapter as V4LocalIndexAdapter, roots.sourceIndexRoot),
      loadV4LocalIndex(adapter as V4LocalIndexAdapter, roots.shadowIndexRoot),
      input.readPersistedPluginData(),
    ])
    const stored = JSON.stringify(persistedData)
    if (typeof stored !== "string" || utf8ToBytes(stored).length > MAX_NATIVE
      || (await digest(stored) !== intentRaw["sourceDataSha256"]
        && await digest(stored) !== intentRaw["destinationDataSha256"])
      || !isV4LocalIndexCacheComplete(source) || !isV4LocalIndexCacheComplete(shadow)
      || source.repoId !== id.sourceRepoId || shadow.repoId !== id.destinationRepoId
      || source.mode !== "encrypted" || shadow.mode !== "encrypted"
      || source.remoteCommitSha !== id.sourceCommitSha
      || shadow.remoteCommitSha !== id.destinationCommitSha
      || source.deviceId !== id.deviceId || shadow.deviceId !== id.deviceId
      || await digest(JSON.stringify(source)) !== contract.sourceIndexSha256
      || await digest(JSON.stringify(shadow)) !== contract.destinationShadowSha256) return MANUAL

    const settings = settingsIdentity(persistedData)
    if (!settings || settings.deviceId !== id.deviceId || settings.mode !== "encrypted") return MANUAL
    if (input.getSecret && (!input.getSecret(id.sourcePassphraseSecretId)
      || !input.getSecret(id.destinationPassphraseSecretId))) return MANUAL
    // The persisted pointer, native Settings and both physical Index roots
    // must survive a second independent read after the awaited verification.
    const [afterSource, afterShadow, afterData] = await Promise.all([
      loadV4LocalIndex(adapter as V4LocalIndexAdapter, roots.sourceIndexRoot),
      loadV4LocalIndex(adapter as V4LocalIndexAdapter, roots.shadowIndexRoot),
      input.readPersistedPluginData(),
    ])
    if (JSON.stringify(afterSource) !== JSON.stringify(source)
      || JSON.stringify(afterShadow) !== JSON.stringify(shadow)
      || JSON.stringify(afterData) !== stored
      || await adapter.read(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== serialized
      || await adapter.read(V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json") !== fenceText
      || await adapter.read(roots.selectorPath) !== selectorCiphertext
      || await adapter.read(candidateRoot + "/persisted-settings-write-intent.json") !== settingsIntentText) {
      return MANUAL
    }
    const authenticated = !!input.journalKey
    if (settings.repoId === id.sourceRepoId
      && settings.secretId === id.sourcePassphraseSecretId) {
      return report("source-settings-pending", null, authenticated)
    }
    if (settings.repoId === id.destinationRepoId
      && settings.secretId === id.destinationPassphraseSecretId) {
      return report("destination-shadow-diagnostic-only", roots.shadowIndexRoot, authenticated)
    }
    return MANUAL
  } catch { return MANUAL }
}
