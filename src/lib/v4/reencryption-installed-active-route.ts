import { bytesToUtf8, fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { fitsV4LocalJsonSizeLimit, isV4LocalIndexCacheComplete, loadV4LocalIndex, saveV4LocalIndex, V4_LOCAL_INDEX_HEADER_MAX_BYTES, V4_LOCAL_INDEX_SHARD_MAX_BYTES, type V4LocalIndexAdapter, type V4LocalIndex } from "./local-index"
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
  repairMissing?: (head: string) => Promise<string>
  checkpointIndex?: (head: string) => Promise<string>
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
async function verifyHistorical(scope: Scope, route: Route): Promise<string> {
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
  scope.assertOwner()
  return roots.shadowIndexRoot
}
async function verifyShadow(scope: Scope, route: Route, shadow: V4LocalIndex, initial: boolean): Promise<void> {
  if (shadow.repoId !== scope.repoId || shadow.deviceId !== scope.deviceId || shadow.mode !== "encrypted"
    || shadow.pathLayout !== "opaque-stable-v1" || !shadow.remoteCommitSha || !SHA.test(shadow.remoteCommitSha)
    || !isV4LocalIndexCacheComplete(shadow) || shadow.epoch < route.initialEpoch
    || (shadow.epoch === route.initialEpoch && shadow.generation < route.initialGeneration)
    || (shadow.remoteCommitSha === route.destinationCommitSha && await remoteRecordsDigest(shadow) !== route.initialRemoteRecordsSha256)
    || (initial && (shadow.remoteCommitSha !== route.destinationCommitSha || await digest(JSON.stringify(shadow)) !== route.initialShadowSha256))) {
    throw new V4InstalledActiveIndexRecoveryError()
  }
  scope.assertOwner()
}
async function verifyLocal(scope: Scope, route: Route, initial: boolean): Promise<string> {
  const root = await verifyHistorical(scope, route)
  const shadow = await loadV4LocalIndex(scope.adapter, root).catch(() => { throw new V4InstalledActiveIndexRecoveryError() })
  await verifyShadow(scope, route, shadow, initial)
  return root
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
  const exists = async (p: string): Promise<boolean> => {
    const result = await adapter.exists(p)
    if (result !== true && result !== false) throw Error("Unverifiable activation artifact.")
    input.assertOwner()
    return result
  }
  if (await exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Active route already committed.")
  let text: string
  const parent = roots.selectorPath.slice(0, roots.selectorPath.lastIndexOf("/"))
  if (await exists(roots.selectorPath)) {
    text = await read(adapter, roots.selectorPath)
    if (JSON.stringify(await decode(input, text)) !== JSON.stringify(route)) throw Error("Existing selector differs; Manual Recovery required.")
  } else {
    // An empty/torn selector directory is not permission to overwrite.
    if (await exists(parent)) throw Error("Partial selector requires Manual Recovery.")
    const bytes = utf8ToBytes(JSON.stringify(route))
    try { text = JSON.stringify({ ciphertext: toBase64Url(await encryptV4Payload(input.key, bytes, context(input.repoId))) }) }
    finally { bytes.fill(0) }
    await input.assertProof()
    await verifyLocal(input, route, true)
    if (await exists(parent) || await exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Concurrent selector.")
    await adapter.mkdir(parent)
    // mkdir is an awaited operation: recheck both commit artifacts before
    // writing. Never overwrite evidence that appeared during that operation.
    if (await exists(roots.selectorPath) || await exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Concurrent activation artifact.")
    input.assertOwner()
    await adapter.write(roots.selectorPath, text)
    await input.checkpoint()
  }
  if (await read(adapter, roots.selectorPath) !== text || JSON.stringify(await decode(input, text)) !== JSON.stringify(route)) throw Error("Selector readback failed.")
  await input.assertProof()
  await verifyLocal(input, route, true)
  if (await read(adapter, roots.selectorPath) !== text || await exists(V4_INSTALLED_ACTIVE_ROUTE_PATH)) throw Error("Activation evidence changed.")
  input.assertOwner()
  await adapter.write(V4_INSTALLED_ACTIVE_ROUTE_PATH, text)
  await input.checkpoint()
  const root = await resolveV4InstalledActiveIndexRoot(input)
  if (root !== roots.shadowIndexRoot) throw Error("Active route readback failed.")
  return root
}

// The checkpoint is separate from both Source and the active Index. Its
// sealed digest authenticates the *persisted* baseline (not an in-memory
// result), including local bookkeeping. A torn checkpoint is unusable.
const checkpointContext = (repoId: string) => ({ kind: "journal" as const, aad: "installed-active-index-checkpoint-v1:" + repoId })
const checkpointRoot = (root: string) => root + "-checkpoint"
interface CheckpointSeal {
  schemaVersion: 1
  routeSha256: string
  indexSha256: string
  remoteCommitSha: string
  walEvidenceSha256: string
}
async function readCheckpoint(scope: Scope, route: Route, root: string, routeText: string): Promise<{ index: V4LocalIndex; walEvidenceSha256: string }> {
  const backup = checkpointRoot(root)
  const text = await read(scope.adapter, backup + "/seal.json")
  const envelope = JSON.parse(text) as { ciphertext?: unknown }
  if (typeof envelope.ciphertext !== "string" || JSON.stringify({ ciphertext: envelope.ciphertext }) !== text) throw Error("Invalid Index checkpoint.")
  const bytes = await decryptV4Payload(scope.key, fromBase64Url(envelope.ciphertext), checkpointContext(scope.repoId))
  try {
    const seal = JSON.parse(bytesToUtf8(bytes)) as CheckpointSeal
    const index = await loadV4LocalIndex(scope.adapter, backup)
    await verifyShadow(scope, route, index, false)
    if (seal.schemaVersion !== 1 || !DIGEST.test(seal.walEvidenceSha256) || seal.routeSha256 !== await digest(routeText)
      || seal.remoteCommitSha !== index.remoteCommitSha || seal.indexSha256 !== await digest(JSON.stringify(index))
      || await read(scope.adapter, backup + "/seal.json") !== text) throw Error("Index checkpoint evidence changed.")
    return { index, walEvidenceSha256: seal.walEvidenceSha256 }
  } finally { bytes.fill(0) }
}
async function checkpointActiveIndex(scope: Scope, route: Route, root: string, routeText: string, checkRoute: () => Promise<void>): Promise<void> {
  const backup = checkpointRoot(root)
  const index = await loadV4LocalIndex(scope.adapter, root)
  await verifyShadow(scope, route, index, false)
  const indexSha256 = await digest(JSON.stringify(index))
  const walEvidenceSha256 = await scope.checkpointIndex!(index.remoteCommitSha!)
  if (!DIGEST.test(walEvidenceSha256)) throw Error("Invalid checkpoint WAL evidence.")
  const unchangedShards: Record<string, string> = {}
  try {
    const previous = await readCheckpoint(scope, route, root, routeText)
    if (previous.walEvidenceSha256 === walEvidenceSha256 && await digest(JSON.stringify(previous.index)) === indexSha256) return
    for (const [bucket, shard] of Object.entries(index.shards)) {
      if (JSON.stringify(shard) === JSON.stringify(previous.index.shards[bucket])) unchangedShards[bucket] = shard.hash
    }
  } catch { /* The active Index is verified; replace only the redundant checkpoint. */ }
  await checkRoute()
  await saveV4LocalIndex(scope.adapter, backup, index, unchangedShards)
  const loaded = await loadV4LocalIndex(scope.adapter, backup)
  if (await digest(JSON.stringify(loaded)) !== indexSha256) throw Error("Index checkpoint readback differs.")
  const seal: CheckpointSeal = { schemaVersion: 1, routeSha256: await digest(routeText), indexSha256, remoteCommitSha: index.remoteCommitSha!, walEvidenceSha256 }
  const bytes = utf8ToBytes(JSON.stringify(seal))
  try {
    const text = JSON.stringify({ ciphertext: toBase64Url(await encryptV4Payload(scope.key, bytes, checkpointContext(scope.repoId))) })
    await checkRoute()
    if (await digest(JSON.stringify(await loadV4LocalIndex(scope.adapter, root))) !== indexSha256
      || await scope.checkpointIndex!(index.remoteCommitSha!) !== walEvidenceSha256) throw Error("Active Index or WAL changed before checkpoint.")
    await scope.adapter.write(backup + "/seal.json", text)
    await readCheckpoint(scope, route, root, routeText)
  } finally { bytes.fill(0) }
}
async function restoreMissingCheckpointFiles(scope: Scope, route: Route, root: string, routeText: string, checkRoute: () => Promise<void>): Promise<void> {
  const { adapter } = scope
  const { index, walEvidenceSha256 } = await readCheckpoint(scope, route, root, routeText)
  const indexSha256 = await digest(JSON.stringify(index))
  const head = index.remoteCommitSha!
  const prove = async () => {
    await checkRoute()
    if (await scope.repairMissing!(head) !== walEvidenceSha256) throw Error("Ordinary WAL changed since the Index checkpoint.")
    const current = await readCheckpoint(scope, route, root, routeText)
    if (current.walEvidenceSha256 !== walEvidenceSha256 || await digest(JSON.stringify(current.index)) !== indexSha256) throw Error("Index checkpoint changed.")
    scope.assertOwner()
  }
  const { shards, ...header } = index
  const paths = [...Object.keys(shards).map(bucket => ({ path: "shards/" + bucket + ".json", max: V4_LOCAL_INDEX_SHARD_MAX_BYTES, expected: () => JSON.stringify(shards[bucket]) })),
    { path: "index.json", max: V4_LOCAL_INDEX_HEADER_MAX_BYTES, expected: () => JSON.stringify(header) }]
  const readBounded = async (path: string, max: number) => {
    const stat = await adapter.stat?.(path)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > max)) throw Error("Invalid checkpoint file size.")
    const value = await adapter.read(path)
    if (!fitsV4LocalJsonSizeLimit(value, max)) throw Error("Invalid checkpoint file size.")
    return value
  }
  const inspect = async () => {
    const missing: typeof paths = []
    for (const file of paths) {
      const target = root + "/" + file.path
      if (!await adapter.exists(target)) missing.push(file)
      else if (await readBounded(target, file.max) !== file.expected()) {
        throw Error("Existing Index artifact differs; preserve it for Manual Recovery.")
      }
    }
    return missing
  }
  await prove()
  const missing = await inspect()
  if (!missing.length) throw new V4InstalledActiveIndexRecoveryError()
  if (!await adapter.exists(root)) await adapter.mkdir(root)
  if (!await adapter.exists(root + "/shards")) await adapter.mkdir(root + "/shards")
  // Preflight ALL existing files before writing anything. Only fill absent
  // paths, header last. Never overwrite a malformed or divergent artifact.
  for (const file of missing) {
    const target = root + "/" + file.path
    const value = file.expected()
    if (!fitsV4LocalJsonSizeLimit(value, file.max)) throw Error("Invalid checkpoint file size.")
    if (await adapter.exists(target)) throw Error("Index artifact appeared during repair.")
    scope.assertOwner()
    await adapter.write(target, value)
    if (await readBounded(target, file.max) !== value) throw Error("Index repair readback differs.")
  }
  await prove()
  if ((await inspect()).length || await digest(JSON.stringify(await loadV4LocalIndex(adapter, root))) !== indexSha256) throw Error("Index repair incomplete.")
}

/** Ordinary Sync must authenticate this every attempt, not merely trust a path
 * or a successful activation report. Historical proof remains immutable;
 * the selected Destination cache can evolve through ordinary Sync. */
export async function resolveV4InstalledActiveIndexRoot(input: Scope): Promise<string> {
  const text = await read(input.adapter, V4_INSTALLED_ACTIVE_ROUTE_PATH)
  const route = await decode(input, text)
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, route.runId)
  if (await read(input.adapter, roots.selectorPath) !== text) throw Error("Active selector differs.")
  const root = await verifyHistorical(input, route)
  const checkRoute = async () => {
    if (await read(input.adapter, V4_INSTALLED_ACTIVE_ROUTE_PATH) !== text
      || await read(input.adapter, roots.selectorPath) !== text
      || await verifyHistorical(input, route) !== root) throw Error("Active route changed.")
    input.assertOwner()
  }
  try {
    const index = await loadV4LocalIndex(input.adapter, root).catch(() => { throw new V4InstalledActiveIndexRecoveryError() })
    await verifyShadow(input, route, index, false)
  } catch (error) {
    if (!(error instanceof V4InstalledActiveIndexRecoveryError) || !input.repairMissing) throw error
    await restoreMissingCheckpointFiles(input, route, root, text, checkRoute)
    await verifyLocal(input, route, false)
  }
  if (input.checkpointIndex) await checkpointActiveIndex(input, route, root, text, checkRoute)
  if (await read(input.adapter, V4_INSTALLED_ACTIVE_ROUTE_PATH) !== text
    || await read(input.adapter, roots.selectorPath) !== text
    || await settingsDigest(input, route.schemaVersion) !== route.settingsSha256) throw Error("Active route changed.")
  input.assertOwner()
  return root
}
