import { bytesToUtf8, fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndexAdapter, type V4LocalIndex } from "./local-index"
import { V4_RUNTIME_INDEX_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"
import { V4_INSTALLED_CUTOVER_INTENT_PATH } from "./reencryption-installed-settings-cutover"
import type { V4InstalledSecretIdentity } from "./reencryption-installed-secret"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "./reencryption-sync-fence"

export const V4_INSTALLED_ACTIVE_ROUTE_PATH = V4_REENCRYPTION_RUNTIME_ROUTE_ROOT + "/active-destination.json"
export class V4InstalledActiveIndexRecoveryError extends Error {
  constructor() {
    super("Active Destination Index is missing or inconsistent; preserve the cache and use Manual Recovery.")
    this.name = "V4InstalledActiveIndexRecoveryError"
  }
}
export type V4InstalledActiveRouteObservation = "not-present" | "active-route-verified" | "active-index-needs-manual-recovery" | "active-route-unverified"
const MAX = 64 * 1024
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SHA = /^[a-f0-9]{40}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const digest = (text: string) => sha256Hex(utf8ToBytes(text))
const context = (repoId: string) => ({ kind: "journal" as const, aad: "installed-active-destination-route-v1:" + repoId })
const fencePath = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"

interface Route {
  schemaVersion: 1 | 2
  phase: "installed-destination-index-active"
  runId: string
  sourceRepoId: string
  destinationRepoId: string
  deviceId: string
  physicalRepositoryId: number
  destinationSecretId: string
  tokenSecretId: string
  sourceCommitSha: string
  destinationCommitSha: string
  sourceIndexSha256: string
  initialShadowSha256: string
  initialRemoteRecordsSha256: string
  initialEpoch: number
  initialGeneration: number
  settingsSha256: string
  intentSha256: string
  fenceSha256: string
}
interface Scope {
  adapter: V4LocalIndexAdapter
  repoId: string
  deviceId: string
  physicalRepositoryId: number
  destinationSecretId: string
  tokenSecretId: string
  key: Uint8Array
  readSettings: () => Promise<unknown>
  assertOwner: () => void
  proposedSettings?: unknown
  liveSettings?: unknown
}
async function read(adapter: V4LocalIndexAdapter, path: string): Promise<string> {
  const stat = await adapter.stat?.(path)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX)) throw Error("Invalid active route size.")
  const text = await adapter.read(path)
  if (!fitsV4LocalJsonSizeLimit(text, MAX)) throw Error("Invalid active route size.")
  return text
}
// Only operational/UI preferences may change; unknown keys stay bound.
const mutablePreferences = new Set([
  "syncEnabled", "syncOnStartup", "syncOnLocalChange", "scheduledSyncEnabled",
  "scheduledSyncIntervalSeconds", "statusBarStatusEnabled", "consoleLoggingEnabled",
  "clipboardReadTip", "lastSyncTime",
])
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function canonicalFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
export function protectedV4InstalledSettings(value: unknown): string {
  if (!record(value) || !record(value["settings"])) throw Error("Invalid active route Settings.")
  const serialized = JSON.stringify(value)
  if (!fitsV4LocalJsonSizeLimit(serialized, 256 * 1024)) throw Error("Invalid active route Settings size.")
  return JSON.stringify(canonicalFields({ ...value, settings: canonicalFields(Object.fromEntries(
    Object.entries(value["settings"]).filter(([k]) => !mutablePreferences.has(k)),
  )) }))
}
async function settingsDigest(scope: Scope, version: 1 | 2): Promise<string> {
  const raw = await scope.readSettings()
  const data = version === 2 ? protectedV4InstalledSettings(raw) : JSON.stringify(raw)
  if (typeof data !== "string" || !fitsV4LocalJsonSizeLimit(data, 256 * 1024)) throw Error("Invalid active route Settings.")
  return digest(data)
}
async function decode(scope: Scope, text: string): Promise<Route> {
  const envelope = JSON.parse(text) as { ciphertext?: unknown }
  if (typeof envelope.ciphertext !== "string" || JSON.stringify({ ciphertext: envelope.ciphertext }) !== text) throw Error("Invalid active route envelope.")
  const bytes = await decryptV4Payload(scope.key, fromBase64Url(envelope.ciphertext), context(scope.repoId))
  try {
    const r = JSON.parse(bytesToUtf8(bytes)) as Route
    if ((r.schemaVersion !== 1 && r.schemaVersion !== 2) || r.phase !== "installed-destination-index-active" || !RUN.test(r.runId)
      || typeof r.sourceRepoId !== "string" || r.sourceRepoId === r.destinationRepoId
      || r.sourceRepoId.split("#")[0] !== scope.repoId.split("#")[0]
      || r.destinationRepoId !== scope.repoId || r.deviceId !== scope.deviceId
      || r.physicalRepositoryId !== scope.physicalRepositoryId || r.destinationSecretId !== scope.destinationSecretId
      || r.tokenSecretId !== scope.tokenSecretId || r.destinationSecretId === r.tokenSecretId
      || !SHA.test(r.sourceCommitSha) || !SHA.test(r.destinationCommitSha)
      || ![r.sourceIndexSha256, r.initialShadowSha256, r.initialRemoteRecordsSha256, r.settingsSha256, r.intentSha256, r.fenceSha256].every(x => typeof x === "string" && DIGEST.test(x))
      || !Number.isSafeInteger(r.initialEpoch) || r.initialEpoch < 0
      || !Number.isSafeInteger(r.initialGeneration) || r.initialGeneration < 0) throw Error("Foreign active route.")
    return r
  } finally { bytes.fill(0) }
}
// mtime/dirty/contentDigest are mutable local bookkeeping even on no-op
// Sync. Bind the stable baseline remote records while the original commit
// is still selected. Subsequent commits use ordinary V4 cache/WAL checks.
async function remoteRecordsDigest(index: V4LocalIndex): Promise<string> {
  return digest(JSON.stringify({
    epoch: index.epoch, generation: index.generation,
    shardHashes: Object.entries(index.shardHashes).sort(([a], [b]) => a.localeCompare(b)),
    shards: Object.entries(index.shards).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, shard]) =>
      [bucket, shard.hash, Object.entries(shard.records).sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => {
        const { mtime: _mtime, dirty: _dirty, ...stable } = record
        return [id, Object.entries(stable).sort(([a], [b]) => a.localeCompare(b))]
      })]),
  }))
}
async function verifyLocal(scope: Scope, route: Route, initial: boolean): Promise<string> {
  scope.assertOwner()
  const { adapter } = scope
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, route.runId)
  if (!await adapter.exists(V4_REENCRYPTION_SYNC_FENCE_ROOT) || !await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
    || await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
    || await adapter.exists(V4_RUNTIME_INDEX_ROOT + "-rekey-cutover-candidate-" + route.runId)
    || await digest(await read(adapter, fencePath)) !== route.fenceSha256
    || await digest(await read(adapter, V4_INSTALLED_CUTOVER_INTENT_PATH)) !== route.intentSha256
    || await settingsDigest(scope, route.schemaVersion) !== route.settingsSha256
    || (route.schemaVersion === 2 && scope.liveSettings !== undefined
      && await digest(protectedV4InstalledSettings(scope.liveSettings)) !== route.settingsSha256)
    || (scope.proposedSettings !== undefined && (route.schemaVersion !== 2
      || await digest(protectedV4InstalledSettings(scope.proposedSettings)) !== route.settingsSha256))) throw Error("Active route evidence changed.")
  const source = await loadV4LocalIndex(adapter, roots.sourceIndexRoot)
  if (source.repoId !== route.sourceRepoId || source.deviceId !== scope.deviceId || source.remoteCommitSha !== route.sourceCommitSha
    || await digest(JSON.stringify(source)) !== route.sourceIndexSha256) throw Error("Historical Source Index changed.")
  const shadow = await loadV4LocalIndex(adapter, roots.shadowIndexRoot).catch(() => { throw new V4InstalledActiveIndexRecoveryError() })
  if (shadow.repoId !== scope.repoId || shadow.deviceId !== scope.deviceId || shadow.mode !== "encrypted"
    || shadow.pathLayout !== "opaque-stable-v1" || !shadow.remoteCommitSha || !SHA.test(shadow.remoteCommitSha)
    || !isV4LocalIndexCacheComplete(shadow) || shadow.epoch < route.initialEpoch
    || (shadow.epoch === route.initialEpoch && shadow.generation < route.initialGeneration)
    || (shadow.remoteCommitSha === route.destinationCommitSha && await remoteRecordsDigest(shadow) !== route.initialRemoteRecordsSha256)
    || (initial && (shadow.remoteCommitSha !== route.destinationCommitSha || await digest(JSON.stringify(shadow)) !== route.initialShadowSha256))) {
    throw new V4InstalledActiveIndexRecoveryError()
  }
  scope.assertOwner()
  return roots.shadowIndexRoot
}

/** Called only inside the existing authenticated installed recovery session
 * with fresh physical parity, exact three refs, WAL lease and Destination key.
 * Selector first; fixed authenticated route last is the commit point.
 * Keep both historical blockers and keys, even after successful activation. */
export async function activateV4InstalledDestinationIndex(input: Scope & {
  identity: V4InstalledSecretIdentity
  assertProof: () => Promise<void>
  checkpoint: () => Promise<void>
}): Promise<string> {
  const { adapter, identity } = input
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, identity.runId)
  if (input.repoId !== identity.destinationRepoId || input.deviceId !== identity.deviceId
    || input.physicalRepositoryId !== identity.physicalRepositoryId) throw Error("Foreign activation identity.")
  await input.assertProof()
  const source = await loadV4LocalIndex(adapter, roots.sourceIndexRoot)
  const shadow = await loadV4LocalIndex(adapter, roots.shadowIndexRoot)
  const route: Route = {
    schemaVersion: 2, phase: "installed-destination-index-active", runId: identity.runId,
    sourceRepoId: identity.sourceRepoId, destinationRepoId: identity.destinationRepoId,
    deviceId: identity.deviceId, physicalRepositoryId: identity.physicalRepositoryId,
    destinationSecretId: input.destinationSecretId, tokenSecretId: input.tokenSecretId,
    sourceCommitSha: identity.pinnedSourceCommitSha, destinationCommitSha: identity.destinationCommitSha,
    sourceIndexSha256: await digest(JSON.stringify(source)), initialShadowSha256: await digest(JSON.stringify(shadow)),
    initialRemoteRecordsSha256: await remoteRecordsDigest(shadow),
    initialEpoch: shadow.epoch, initialGeneration: shadow.generation,
    settingsSha256: await settingsDigest(input, 2), intentSha256: await digest(await read(adapter, V4_INSTALLED_CUTOVER_INTENT_PATH)),
    fenceSha256: await digest(await read(adapter, fencePath)),
  }
  if (await adapter.exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Active route already committed.")
  let text: string
  const parent = roots.selectorPath.slice(0, roots.selectorPath.lastIndexOf("/"))
  if (await adapter.exists(roots.selectorPath)) {
    text = await read(adapter, roots.selectorPath)
    if (JSON.stringify(await decode(input, text)) !== JSON.stringify(route)) throw Error("Existing selector differs; Manual Recovery required.")
  } else {
    // An empty/torn selector directory is not permission to overwrite.
    if (await adapter.exists(parent)) throw Error("Partial selector requires Manual Recovery.")
    const bytes = utf8ToBytes(JSON.stringify(route))
    try { text = JSON.stringify({ ciphertext: toBase64Url(await encryptV4Payload(input.key, bytes, context(input.repoId))) }) }
    finally { bytes.fill(0) }
    await input.assertProof()
    await verifyLocal(input, route, true)
    if (await adapter.exists(parent) || await adapter.exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Concurrent selector.")
    await adapter.mkdir(parent)
    await adapter.write(roots.selectorPath, text)
    await input.checkpoint()
  }
  if (await read(adapter, roots.selectorPath) !== text || JSON.stringify(await decode(input, text)) !== JSON.stringify(route)) throw Error("Selector readback failed.")
  await input.assertProof()
  await verifyLocal(input, route, true)
  if (await adapter.exists(V4_INSTALLED_ACTIVE_ROUTE_PATH) || await read(adapter, roots.selectorPath) !== text) throw Error("Activation evidence changed.")
  input.assertOwner()
  await adapter.write(V4_INSTALLED_ACTIVE_ROUTE_PATH, text)
  await input.checkpoint()
  const root = await resolveV4InstalledActiveIndexRoot(input)
  if (root !== roots.shadowIndexRoot) throw Error("Active route readback failed.")
  return root
}

/** Ordinary Sync must authenticate this every attempt, not merely trust a path
 * or a successful activation report. Historical proof remains immutable;
 * the selected Destination cache can evolve through ordinary Sync. */
export async function resolveV4InstalledActiveIndexRoot(input: Scope): Promise<string> {
  const text = await read(input.adapter, V4_INSTALLED_ACTIVE_ROUTE_PATH)
  const route = await decode(input, text)
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, route.runId)
  if (await read(input.adapter, roots.selectorPath) !== text) throw Error("Active selector differs.")
  const root = await verifyLocal(input, route, false)
  if (await read(input.adapter, V4_INSTALLED_ACTIVE_ROUTE_PATH) !== text
    || await read(input.adapter, roots.selectorPath) !== text
    || await settingsDigest(input, route.schemaVersion) !== route.settingsSha256) throw Error("Active route changed.")
  input.assertOwner()
  return root
}
