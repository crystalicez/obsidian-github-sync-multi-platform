import { bytesToUtf8, fromBase64Url, randomBytes, toBase64Url, toHex, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { fitsV4LocalJsonSizeLimit, type V4LocalIndexAdapter } from "./local-index"
import type { SecretStorageLike } from "./secrets"
import { V4_RUNTIME_INDEX_ROOT } from "./reencryption-index-root"

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
  const path = installedSecretReceiptRoot(identity.runId) + "/receipt.enc"
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
  await checkpoint()
  if (await readReceipt(adapter, identity, owner, key) !== id) throw Error("Staged secret receipt readback failed.")
  await assertLease()
  assertActive(owner)
  if (owner.storage.getSecret(id) !== null) throw Error("Destination SecretStorage ID changed.")
  owner.storage.setSecret(id, newPassphrase)
  if (owner.storage.getSecret(id) !== newPassphrase) throw Error("Destination SecretStorage readback failed.")
  await checkpoint()
  if (await readReceipt(adapter, identity, owner, key) !== id) throw Error("Staged secret receipt changed.")
  await assertLease()
  assertActive(owner)
  if (owner.storage.getSecret(id) !== newPassphrase) throw Error("Destination SecretStorage changed.")
  return Object.freeze({ status: "destination-secret-staged-uncommitted", destinationPassphraseSecretId: id,
    localCutoverAuthorized: false, resumeSyncAuthorized: false, oldPassphraseCleanupAuthorized: false })
}

/** Recover the staged new secret only after authenticating its exact receipt
 * with the original Source WAL key. Caller must independently verify Git. */
export async function readV4InstalledDestinationSecret(input: {
  adapter: V4LocalIndexAdapter; identity: V4InstalledSecretIdentity; owner: V4InstalledSecretOwner; key: Uint8Array
}): Promise<{ id: string; passphrase: string }> {
  const { adapter, identity, owner, key } = input
  assertActive(owner)
  const id = await readReceipt(adapter, identity, owner, key)
  assertActive(owner)
  const passphrase = owner.storage.getSecret(id)
  if (!passphrase || passphrase === owner.oldPassphrase) throw Error("Staged Destination SecretStorage unavailable.")
  return { id, passphrase }
}
