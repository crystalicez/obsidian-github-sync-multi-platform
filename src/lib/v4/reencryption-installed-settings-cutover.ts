import { bytesToUtf8, fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import { fitsV4LocalJsonSizeLimit, loadV4LocalIndex, type V4LocalIndexAdapter } from "./local-index"
import { inspectV4InstalledDestinationSecret, type V4InstalledSecretIdentity, type V4InstalledSecretOwner } from "./reencryption-installed-secret"
import { V4_RUNTIME_INDEX_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

export const V4_INSTALLED_CUTOVER_INTENT_PATH = V4_REENCRYPTION_RUNTIME_ROUTE_ROOT + "/installed-settings-intent.json"
const MAX = 64 * 1024
const MAX_SETTINGS = 256 * 1024
const digest = (text: string) => sha256Hex(utf8ToBytes(text))
const context = (runId: string) => ({ kind: "journal" as const, aad: "installed-rekey-settings-cutover-v1:" + runId })
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const active = new WeakSet<V4LocalIndexAdapter>()

export interface V4InstalledSettingsIo {
  readonly read: () => Promise<unknown>
  readonly write: (data: unknown) => Promise<void>
}

function settingsData(value: unknown) {
  if (!plainObject(value) || !plainObject(value["settings"])
    || Object.hasOwn(value["settings"], "githubToken")
    || Object.hasOwn(value["settings"], "encryptionPassphrase")) throw Error("Cutover requires sanitized wrapped plugin Settings.")
  const serialized = JSON.stringify(value)
  if (!fitsV4LocalJsonSizeLimit(serialized, MAX_SETTINGS) || JSON.stringify(JSON.parse(serialized)) !== serialized)
    throw Error("Cutover Settings are not bounded canonical JSON.")
  return { wrapper: value, settings: value["settings"], serialized }
}

/** Only a disk snapshot, never permission to resume Sync. */
export async function captureV4InstalledCutoverSourceSettings(io: V4InstalledSettingsIo): Promise<string> {
  return settingsData(await io.read()).serialized
}

interface Intent {
  readonly schemaVersion: 1
  readonly phase: "installed-destination-settings-intent-fence-held"
  readonly identity: V4InstalledSecretIdentity
  readonly sourceSecretId: string
  readonly destinationSecretId: string
  readonly tokenSecretId: string
  readonly sourceIndexRoot: string
  readonly shadowIndexRoot: string
  readonly sourceDataSha256: string
  readonly destinationDataSha256: string
  readonly sourceIndexSha256: string
  readonly shadowIndexSha256: string
}
function assertSourceSettings(data: ReturnType<typeof settingsData>, identity: V4InstalledSecretIdentity, owner: V4InstalledSecretOwner) {
  const s = data.settings
  if (s["encryptionMode"] !== "encrypted" || s["vault"] !== identity.deviceId
    || typeof s["githubOwner"] !== "string" || typeof s["githubRepo"] !== "string" || typeof s["githubBranch"] !== "string"
    || s["githubOwner"] + "/" + s["githubRepo"] + "#" + s["githubBranch"] !== identity.sourceRepoId
    || s["encryptionPassphraseSecretId"] !== owner.sourcePassphraseSecretId
    || s["githubTokenSecretId"] !== owner.githubTokenSecretId) throw Error("Cutover persisted Source Settings differ.")
}
async function indexDigests(adapter: V4LocalIndexAdapter, identity: V4InstalledSecretIdentity) {
  const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, identity.runId)
  const source = await loadV4LocalIndex(adapter, roots.sourceIndexRoot)
  const shadow = await loadV4LocalIndex(adapter, roots.shadowIndexRoot)
  return { sourceIndexRoot: roots.sourceIndexRoot, shadowIndexRoot: roots.shadowIndexRoot,
    sourceIndexSha256: await digest(JSON.stringify(source)), shadowIndexSha256: await digest(JSON.stringify(shadow)) }
}
async function readIntent(adapter: V4LocalIndexAdapter): Promise<string> {
  const stat = await adapter.stat?.(V4_INSTALLED_CUTOVER_INTENT_PATH)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX)) throw Error("Invalid installed Cutover intent size.")
  const text = await adapter.read(V4_INSTALLED_CUTOVER_INTENT_PATH)
  if (!fitsV4LocalJsonSizeLimit(text, MAX)) throw Error("Invalid installed Cutover intent size.")
  return text
}
async function decodeIntent(text: string, key: Uint8Array, identity: V4InstalledSecretIdentity, sourceId: string): Promise<Intent> {
  const envelope = JSON.parse(text) as { runId?: unknown; sourceSecretId?: unknown; ciphertext?: unknown }
  if (envelope.runId !== identity.runId || envelope.sourceSecretId !== sourceId || typeof envelope.ciphertext !== "string"
    || JSON.stringify({ runId: identity.runId, sourceSecretId: sourceId, ciphertext: envelope.ciphertext }) !== text) throw Error("Foreign installed Cutover locator.")
  const bytes = await decryptV4Payload(key, fromBase64Url(envelope.ciphertext), context(identity.runId))
  try {
    const parsed = JSON.parse(bytesToUtf8(bytes)) as Intent
    if (parsed.schemaVersion !== 1 || parsed.phase !== "installed-destination-settings-intent-fence-held"
      || JSON.stringify(parsed.identity) !== JSON.stringify(identity) || parsed.sourceSecretId !== sourceId)
      throw Error("Foreign installed Cutover intent.")
    return parsed
  } finally { bytes.fill(0) }
}

export type V4InstalledSettingsCutoverObservation = "source-settings-intent-pending" | "destination-settings-observed-fenced" | "manual-recovery-required"

/** Authenticated disk observation under a caller-owned recovery key/lease.
 * Still never permits Sync, old-key cleanup or rollback. */
export async function inspectV4InstalledSettingsCutover(input: {
  adapter: V4LocalIndexAdapter; identity: V4InstalledSecretIdentity; key: Uint8Array; sourceSecretId: string; io: Pick<V4InstalledSettingsIo, "read">
}): Promise<V4InstalledSettingsCutoverObservation> {
  try {
    const text = await readIntent(input.adapter)
    const intent = await decodeIntent(text, input.key, input.identity, input.sourceSecretId)
    const idx = await indexDigests(input.adapter, input.identity)
    if (Object.entries(idx).some(([k, v]) => intent[k as keyof Intent] !== v)) return "manual-recovery-required"
    const data = settingsData(await input.io.read())
    const hash = await digest(data.serialized)
    if (await readIntent(input.adapter) !== text || settingsData(await input.io.read()).serialized !== data.serialized) return "manual-recovery-required"
    return hash === intent.sourceDataSha256 ? "source-settings-intent-pending"
      : hash === intent.destinationDataSha256 ? "destination-settings-observed-fenced" : "manual-recovery-required"
  } catch { return "manual-recovery-required" }
}

/** Internal installed transaction after complete authenticated remote/physical
 * proof. The caller keeps the real WAL lease; the root is a second blocker
 * even if the primary fence disappears. Never retry an ambiguous native save.
 * Source/Shadow remain untouched and both keys retained. */
export async function writeV4InstalledDestinationSettings(input: {
  adapter: V4LocalIndexAdapter; identity: V4InstalledSecretIdentity; owner: V4InstalledSecretOwner
  key: Uint8Array; io: V4InstalledSettingsIo; originalData: string; destinationIterations: number
  assertProof: () => Promise<void>; checkpoint: () => Promise<void>
}): Promise<void> {
  const { adapter, identity, owner, key, io, originalData, assertProof, checkpoint } = input
  if (active.has(adapter)) throw Error("Concurrent installed Cutover.")
  active.add(adapter)
  try {
    assertV4Pbkdf2Iterations(input.destinationIterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
    const original = settingsData(JSON.parse(originalData))
    assertSourceSettings(original, identity, owner)
    await assertProof()
    const staged = await inspectV4InstalledDestinationSecret({ adapter, identity, owner, key })
    if (!staged.passphrase) throw Error("Missing staged Cutover key.")
    const prefix = identity.sourceRepoId.slice(0, identity.sourceRepoId.indexOf("#") + 1)
    if (!identity.destinationRepoId.startsWith(prefix) || identity.destinationRepoId === identity.sourceRepoId) throw Error("Foreign Cutover destination.")
    const target = settingsData({ ...original.wrapper, settings: { ...original.settings,
      githubBranch: identity.destinationRepoId.slice(prefix.length),
      encryptionPassphraseSecretId: staged.id, pbkdf2Iterations: input.destinationIterations,
    } })
    const indexes = await indexDigests(adapter, identity)
    const intent: Intent = { schemaVersion: 1, phase: "installed-destination-settings-intent-fence-held",
      identity, sourceSecretId: owner.sourcePassphraseSecretId, destinationSecretId: staged.id,
      tokenSecretId: owner.githubTokenSecretId, ...indexes,
      sourceDataSha256: await digest(original.serialized), destinationDataSha256: await digest(target.serialized) }
    const bytes = utf8ToBytes(JSON.stringify(intent))
    let ciphertext: string
    try { ciphertext = toBase64Url(await encryptV4Payload(key, bytes, context(identity.runId))) }
    finally { bytes.fill(0) }
    const text = JSON.stringify({ runId: identity.runId, sourceSecretId: owner.sourcePassphraseSecretId, ciphertext })
    if (!fitsV4LocalJsonSizeLimit(text, MAX)) throw Error("Oversized installed Cutover intent.")
    const check = async (expected: string) => {
      await assertProof()
      if (settingsData(await io.read()).serialized !== expected
        || JSON.stringify(await indexDigests(adapter, identity)) !== JSON.stringify(indexes)) throw Error("Cutover Settings or Index drifted.")
      const secret = await inspectV4InstalledDestinationSecret({ adapter, identity, owner, key })
      if (secret.id !== staged.id || secret.passphrase !== staged.passphrase) throw Error("Cutover secret custody changed.")
      owner.assertOwner()
    }
    await check(originalData)
    if (await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT) || await adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_PATH)) throw Error("Existing Cutover intent requires Manual Recovery.")
    await adapter.mkdir(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
    await adapter.write(V4_INSTALLED_CUTOVER_INTENT_PATH, text)
    await checkpoint()
    if (await readIntent(adapter) !== text || JSON.stringify(await decodeIntent(text, key, identity, owner.sourcePassphraseSecretId)) !== JSON.stringify(intent))
      throw Error("Installed Cutover intent readback failed.")
    await check(originalData)
    if (await readIntent(adapter) !== text) throw Error("Installed Cutover intent changed.")
    owner.assertOwner()
    // An exception can mean the write committed. Leave every recovery artifact
    // intact and never blindly repeat, even if the old Settings are observed.
    await io.write(JSON.parse(target.serialized))
    await checkpoint()
    await check(target.serialized)
    if (await readIntent(adapter) !== text) throw Error("Installed Cutover intent changed after Settings write.")
    owner.assertOwner()
  } finally { active.delete(adapter) }
}
