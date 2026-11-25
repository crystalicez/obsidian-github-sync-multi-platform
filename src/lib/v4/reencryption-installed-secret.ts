import { bytesToUtf8, fromBase64Url, randomBytes, toBase64Url, toHex, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { fitsV4LocalJsonSizeLimit, type V4LocalIndexAdapter } from "./local-index"
import type { SecretStorageLike } from "./secrets"
import { V4_RUNTIME_INDEX_ROOT } from "./reencryption-index-root"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "./reencryption-sync-fence"

export interface V4InstalledSecretIdentity {
  readonly runId: string
  readonly deviceId: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly sourceTreeSha: string
  readonly destinationCommitSha: string
  readonly destinationTreeSha: string
  readonly finalWalGeneration: number
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly physicalRepositoryId: number
  readonly defaultBranch: string
}
export interface V4InstalledSecretOwner {
  readonly storage: SecretStorageLike
  readonly sourcePassphraseSecretId: string
  readonly githubTokenSecretId: string
  readonly oldPassphrase: string
  readonly token: string
  readonly assertOwner: () => void
}
export interface V4InstalledSecretReport {
  readonly status: "destination-secret-staged-uncommitted"
  readonly destinationPassphraseSecretId: string
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const MAX = 16 * 1024
export function installedSecretReceiptRoot(runId: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(runId)) throw Error("Invalid installed SecretStorage run.")
  return V4_RUNTIME_INDEX_ROOT + "-rekey-secret-" + runId
}
const IDENTITY_KEYS = [
  "runId", "deviceId", "sourceRepoId", "backupRepoId", "destinationRepoId",
  "pinnedSourceCommitSha", "sourceTreeSha", "destinationCommitSha", "destinationTreeSha",
  "finalWalGeneration", "verifiedFileCount", "verifiedPlaintextBytes", "physicalRepositoryId", "defaultBranch",
] as const
const SHA = /^[a-f0-9]{40}$/u
function safeBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 512 && /^[A-Za-z0-9_./-]+$/u.test(branch)
    && !branch.includes("..") && branch.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"))
    && !branch.endsWith(".")
}
function validIdentity(value: unknown): value is V4InstalledSecretIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const i = value as Partial<V4InstalledSecretIdentity>
  if (Object.keys(i).length !== IDENTITY_KEYS.length || !IDENTITY_KEYS.every(key => Object.hasOwn(i, key))) return false
  if (typeof i.runId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(i.runId)
    || typeof i.deviceId !== "string" || i.deviceId.length < 1 || i.deviceId.length > 256
    || typeof i.sourceRepoId !== "string" || typeof i.backupRepoId !== "string" || typeof i.destinationRepoId !== "string"
    || typeof i.defaultBranch !== "string" || !safeBranch(i.defaultBranch)) return false
  const source = i.sourceRepoId.split("#")
  if (source.length !== 2 || !source[0] || !source[1] || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source[0])) return false
  const prefix = source[0] + "#"
  const branches = [i.sourceRepoId, i.backupRepoId, i.destinationRepoId]
  if (new Set(branches).size !== 3 || branches.some(ref => !ref.startsWith(prefix) || !safeBranch(ref.slice(prefix.length)))
    || i.backupRepoId === prefix + i.defaultBranch || i.destinationRepoId === prefix + i.defaultBranch) return false
  if (![i.pinnedSourceCommitSha, i.sourceTreeSha, i.destinationCommitSha, i.destinationTreeSha].every(v => typeof v === "string" && SHA.test(v))
    || i.pinnedSourceCommitSha === i.destinationCommitSha) return false
  return Number.isSafeInteger(i.finalWalGeneration) && (i.finalWalGeneration ?? 0) > 0
    && Number.isSafeInteger(i.verifiedFileCount) && (i.verifiedFileCount ?? -1) >= 0
    && typeof i.verifiedPlaintextBytes === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(i.verifiedPlaintextBytes)
    && Number.isSafeInteger(i.physicalRepositoryId) && (i.physicalRepositoryId ?? 0) > 0
}
async function readBoundedText(adapter: V4LocalIndexAdapter, path: string): Promise<string> {
  const stat = await adapter.stat?.(path)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX)) throw Error("Invalid installed recovery metadata size.")
  const text = await adapter.read(path)
  if (!fitsV4LocalJsonSizeLimit(text, MAX)) throw Error("Invalid installed recovery metadata size.")
  return text
}
function locatorBody(identity: V4InstalledSecretIdentity): string {
  if (!validIdentity(identity)) throw Error("Invalid installed migration identity.")
  // Only non-secret Git/run metadata; the encrypted receipt is authoritative.
  return JSON.stringify({ schemaVersion: 1, identity })
}

/** Untrusted locator, scoped to the active local fence and current Source.
 * Never treat this as authentication or permission for any write. */
export async function discoverV4InstalledSecretIdentity(input: {
  adapter: V4LocalIndexAdapter; sourceRepoId: string; deviceId: string
}): Promise<V4InstalledSecretIdentity> {
  const { adapter, sourceRepoId, deviceId } = input
  const fencePath = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
  const fenceText = await readBoundedText(adapter, fencePath)
  const fence = JSON.parse(fenceText) as { runId?: unknown; destinationRepoId?: unknown }
  if (typeof fence.runId !== "string" || typeof fence.destinationRepoId !== "string") throw Error("Invalid installed migration fence.")
  const expectedFence = JSON.stringify({ schemaVersion: 1, phase: "migration-fenced-uncommitted", runId: fence.runId,
    sourceRepoId, destinationRepoId: fence.destinationRepoId })
  if (fenceText !== expectedFence) throw Error("Foreign installed migration fence.")
  const path = installedSecretReceiptRoot(fence.runId) + "/locator.json"
  const text = await readBoundedText(adapter, path)
  const parsed = JSON.parse(text) as { identity?: unknown }
  if (!validIdentity(parsed.identity)) throw Error("Invalid installed migration locator.")
  const identity = parsed.identity
  if (identity.runId !== fence.runId || identity.sourceRepoId !== sourceRepoId || identity.deviceId !== deviceId
    || identity.destinationRepoId !== fence.destinationRepoId || text !== locatorBody(identity)) throw Error("Foreign installed migration locator.")
  if (await readBoundedText(adapter, fencePath) !== fenceText || await readBoundedText(adapter, path) !== text) throw Error("Installed migration locator changed.")
  return Object.freeze(identity)
}

function assertActive(owner: V4InstalledSecretOwner): void {
  owner.assertOwner()
  const { storage, sourcePassphraseSecretId: old, githubTokenSecretId: token } = owner
  if (!old || !token || old === token || !owner.oldPassphrase || !owner.token
    || storage.getSecret(old) !== owner.oldPassphrase || storage.getSecret(token) !== owner.token) {
    throw Error("Installed Re-encryption Source SecretStorage custody is unavailable.")
  }
}
function body(identity: V4InstalledSecretIdentity, owner: V4InstalledSecretOwner, destinationId: string): string {
  return JSON.stringify({ schemaVersion: 1, phase: "destination-secret-prepared-uncommitted",
    identity, sourcePassphraseSecretId: owner.sourcePassphraseSecretId, githubTokenSecretId: owner.githubTokenSecretId,
    destinationPassphraseSecretId: destinationId })
}
function context(runId: string) {
  return { kind: "journal" as const, aad: "installed-rekey-secret-v1:" + runId }
}
async function readReceipt(adapter: V4LocalIndexAdapter, identity: V4InstalledSecretIdentity,
  owner: V4InstalledSecretOwner, key: Uint8Array): Promise<string> {
  const root = installedSecretReceiptRoot(identity.runId)
  const locatorPath = root + "/locator.json"
  // Legacy internal rehearsal receipts lacked a locator; if present it must match.
  if (await adapter.exists(locatorPath) && await readBoundedText(adapter, locatorPath) !== locatorBody(identity)) throw Error("Foreign installed migration locator.")
  const path = root + "/receipt.enc"
  const stat = await adapter.stat?.(path)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX)) throw Error("Invalid staged secret receipt size.")
  const encoded = await adapter.read(path)
  if (!fitsV4LocalJsonSizeLimit(encoded, MAX)) throw Error("Invalid staged secret receipt size.")
  const plain = await decryptV4Payload(key, fromBase64Url(encoded), context(identity.runId))
  try {
    const serialized = bytesToUtf8(plain)
    const parsed = JSON.parse(serialized) as { destinationPassphraseSecretId?: unknown }
    const id = parsed.destinationPassphraseSecretId
    if (typeof id !== "string" || !/^rekey-passphrase-[a-f0-9]{32}$/u.test(id)
      || id === owner.sourcePassphraseSecretId || id === owner.githubTokenSecretId
      || serialized !== body(identity, owner, id)) throw Error("Foreign staged secret receipt.")
    return id
  } finally { plain.fill(0) }
}

/** Called only after independent Destination/Shadow verification under a live
 * WAL lease. Receipt first; no retry/overwrite/scrub of uncertain writes. */
export async function stageV4InstalledDestinationSecret(input: {
  adapter: V4LocalIndexAdapter; identity: V4InstalledSecretIdentity; owner: V4InstalledSecretOwner
  key: Uint8Array; newPassphrase: string; assertLease: () => Promise<void>; checkpoint: () => Promise<void>
}): Promise<V4InstalledSecretReport> {
  const { adapter, identity, owner, key, newPassphrase, assertLease, checkpoint } = input
  const root = installedSecretReceiptRoot(identity.runId)
  const locator = locatorBody(identity)
  await assertLease()
  assertActive(owner)
  if (!newPassphrase || newPassphrase === owner.oldPassphrase || await adapter.exists(root)) throw Error("Existing or invalid staged secret requires Manual Recovery.")
  const id = "rekey-passphrase-" + toHex(randomBytes(16))
  if (id === owner.sourcePassphraseSecretId || id === owner.githubTokenSecretId || owner.storage.getSecret(id) !== null) throw Error("Destination SecretStorage ID is not fresh.")
  const plain = utf8ToBytes(body(identity, owner, id))
  let encoded: string
  try { encoded = toBase64Url(await encryptV4Payload(key, plain, context(identity.runId))) }
  finally { plain.fill(0) }
  if (!fitsV4LocalJsonSizeLimit(encoded, MAX)) throw Error("Staged secret receipt too large.")
  await assertLease()
  assertActive(owner)
  if (await adapter.exists(root)) throw Error("Existing staged secret receipt requires Manual Recovery.")
  await adapter.mkdir(root)
  await adapter.write(root + "/receipt.enc", encoded)
  await adapter.write(root + "/locator.json", locator)
  await checkpoint()
  if (await readBoundedText(adapter, root + "/locator.json") !== locator) throw Error("Staged secret locator readback failed.")
  if (await readReceipt(adapter, identity, owner, key) !== id) throw Error("Staged secret receipt readback failed.")
  await assertLease()
  assertActive(owner)
  if (owner.storage.getSecret(id) !== null) throw Error("Destination SecretStorage ID changed.")
  owner.storage.setSecret(id, newPassphrase)
  if (owner.storage.getSecret(id) !== newPassphrase) throw Error("Destination SecretStorage readback failed.")
  await checkpoint()
  if (await readReceipt(adapter, identity, owner, key) !== id
    || await readBoundedText(adapter, root + "/locator.json") !== locator) throw Error("Staged secret receipt or locator changed.")
  await assertLease()
  assertActive(owner)
  if (owner.storage.getSecret(id) !== newPassphrase) throw Error("Destination SecretStorage changed.")
  return Object.freeze({ status: "destination-secret-staged-uncommitted", destinationPassphraseSecretId: id,
    localCutoverAuthorized: false, resumeSyncAuthorized: false, oldPassphraseCleanupAuthorized: false })
}

interface StagedSecretInput {
  adapter: V4LocalIndexAdapter; identity: V4InstalledSecretIdentity; owner: V4InstalledSecretOwner; key: Uint8Array
}

/** Authenticate the receipt even if the platform lost the secret on restart.
 * Empty/absent is the only repairable state; a nonempty value must be verified. */
export async function inspectV4InstalledDestinationSecret(input: StagedSecretInput): Promise<{ id: string; passphrase: string | null }> {
  const { adapter, identity, owner, key } = input
  assertActive(owner)
  const id = await readReceipt(adapter, identity, owner, key)
  assertActive(owner)
  const passphrase = owner.storage.getSecret(id)
  if (passphrase === owner.oldPassphrase) throw Error("Staged Destination SecretStorage aliases Source.")
  return { id, passphrase: passphrase || null }
}

/** Read-only custody check. Caller must independently verify Git. */
export async function readV4InstalledDestinationSecret(input: StagedSecretInput): Promise<{ id: string; passphrase: string }> {
  const staged = await inspectV4InstalledDestinationSecret(input)
  if (!staged.passphrase) throw Error("Staged Destination SecretStorage unavailable.")
  return { id: staged.id, passphrase: staged.passphrase }
}

/** Explicit repair of an authenticated missing slot, only after full
 * Destination verification by the owner-bound recovery transaction.
 * Never overwrite a nonempty slot, create a new receipt, or remove old keys.
 * SecretStorage readback proves process-local custody, not crash durability. */
export async function restoreV4InstalledMissingDestinationSecret(input: StagedSecretInput & {
  expectedId: string; verifiedPassphrase: string; assertLease: () => Promise<void>; checkpoint: () => Promise<void>
}): Promise<void> {
  const { owner, expectedId, verifiedPassphrase, assertLease, checkpoint } = input
  if (!verifiedPassphrase || verifiedPassphrase === owner.oldPassphrase) throw Error("Invalid Destination recovery passphrase.")
  await assertLease()
  const first = await inspectV4InstalledDestinationSecret(input)
  if (first.id !== expectedId || first.passphrase !== null) throw Error("Staged SecretStorage is not missing.")
  await checkpoint()
  const second = await inspectV4InstalledDestinationSecret(input)
  if (second.id !== expectedId || second.passphrase !== null) throw Error("Staged SecretStorage changed.")
  await assertLease()
  assertActive(owner)
  if (owner.storage.getSecret(expectedId)) throw Error("Staged SecretStorage became occupied.")
  owner.storage.setSecret(expectedId, verifiedPassphrase)
  if (owner.storage.getSecret(expectedId) !== verifiedPassphrase) throw Error("Restored SecretStorage readback failed.")
  await checkpoint()
  const final = await inspectV4InstalledDestinationSecret(input)
  if (final.id !== expectedId || final.passphrase !== verifiedPassphrase) throw Error("Restored SecretStorage changed.")
  await assertLease()
  assertActive(owner)
}
