import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from "../bytes"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndex } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import {
  assertV4ReencryptionProposedCommitIdentity,
  matchesV4ReencryptionPreparedWal,
  type V4ReencryptionProposedCommitIdentity,
  type V4ReencryptionProposedCommitInspectionInput,
} from "./reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const CONTEXT = "v4-rekey-separated-selector-prototype-v1"
const MAX_BYTES = 8 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

interface SelectorRecord {
  readonly schemaVersion: 1
  readonly phase: "destination-selector-test-vector-uncommitted"
  readonly identity: V4ReencryptionProposedCommitIdentity
}

export interface V4ReencryptionSeparatedSelectorReadbackReport {
  readonly integrityScope: "authenticated-option-a-selector-prototype-uncommitted"
  readonly observation: "authenticated-selector-with-both-indices-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4ReencryptionSeparatedSelectorReadbackReport = Object.freeze({
  integrityScope: "authenticated-option-a-selector-prototype-uncommitted",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const OBSERVED: V4ReencryptionSeparatedSelectorReadbackReport = Object.freeze({
  ...MANUAL, observation: "authenticated-selector-with-both-indices-uncommitted",
})

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("Separated selector prototype requires the V4 journal key.")
  }
}

function record(identity: V4ReencryptionProposedCommitIdentity): SelectorRecord {
  return { schemaVersion: 1, phase: "destination-selector-test-vector-uncommitted", identity }
}

function aad(identity: V4ReencryptionProposedCommitIdentity): string {
  return CONTEXT + ":" + identity.runId + ":" + identity.sourceCommitSha
    + ":" + identity.destinationRepoId + ":" + identity.destinationCommitSha
}

async function derivedKey(journalKey: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", journalKey as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key,
    utf8ToBytes(CONTEXT + ":key") as any))
}

function decode(encoded: string): Uint8Array | null {
  if (typeof encoded !== "string" || encoded.length < 4
    || encoded.length > MAX_BYTES || !BASE64.test(encoded)) return null
  const bytes = fromBase64(encoded)
  if (bytes.length > MAX_BYTES || toBase64(bytes) !== encoded) {
    bytes.fill(0)
    return null
  }
  return bytes
}

/** Creates only an in-memory test vector. No disk, Settings, Index or GitHub writes. */
export async function sealV4ReencryptionSeparatedSelectorTestVector(
  identity: V4ReencryptionProposedCommitIdentity, journalKey: Uint8Array,
): Promise<string> {
  assertV4ReencryptionProposedCommitIdentity(identity)
  assertKey(journalKey)
  const plaintext = utf8ToBytes(JSON.stringify(record(identity)))
  if (plaintext.length > MAX_BYTES / 2) {
    plaintext.fill(0)
    throw new Error("Separated selector test vector exceeds its size limit.")
  }
  const key = await derivedKey(journalKey)
  try {
    const bytes = await encryptV4Payload(key, plaintext, { kind: "journal", aad: aad(identity) })
    try { return toBase64(bytes) } finally { bytes.fill(0) }
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

async function authentic(encoded: string, identity: V4ReencryptionProposedCommitIdentity,
  journalKey: Uint8Array): Promise<boolean> {
  const bytes = decode(encoded)
  if (!bytes) return false
  const key = await derivedKey(journalKey)
  try {
    let plaintext: Uint8Array
    try {
      plaintext = await decryptV4Payload(key, bytes, { kind: "journal", aad: aad(identity) })
    } catch { return false }
    try {
      return plaintext.length <= MAX_BYTES / 2
        && bytesToUtf8(plaintext) === JSON.stringify(record(identity))
    } finally { plaintext.fill(0) }
  } finally {
    key.fill(0)
    bytes.fill(0)
  }
}

function matchesIndex(index: V4LocalIndex, repoId: string, sha: string, deviceId: string): boolean {
  return index.repoId === repoId && index.remoteCommitSha === sha
    && index.deviceId === deviceId && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(item => item.dirty !== true && item.deleted !== true))
}

function matchingSettings(input: V4ReencryptionProposedCommitInspectionInput): boolean {
  const id = input.identity
  const settings = input.settings
  return settings.githubOwner + "/" + settings.githubRepo + "#" + settings.githubBranch
    === id.destinationRepoId
    && settings.encryptionMode === "encrypted"
    && settings.encryptionPassphraseSecretId === id.destinationPassphraseSecretId
    && settings.vault === id.deviceId
}

/**
 * Diagnostic-only restart reader. It reads an independently stored selector
 * and both immutable Source and Shadow Index roots twice under an external
 * exclusive lease, bracketing the independently authenticated WAL. Readback
 * and a caller-provided durability callback do NOT establish crash durability.
 */
export async function inspectV4ReencryptionSeparatedSelectorAfterRestart(
  input: V4ReencryptionProposedCommitInspectionInput,
): Promise<V4ReencryptionSeparatedSelectorReadbackReport> {
  if (!input) throw new Error("Missing separated selector input.")
  assertV4ReencryptionProposedCommitIdentity(input.identity)
  assertKey(input.journalKey)
  if (typeof input.adapter?.read !== "function" || typeof input.adapter.exists !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || typeof input.getSecret !== "function"
    || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || input.journal.sourceCommitSha !== input.identity.sourceCommitSha
    || input.journal.destinationRepoId !== input.identity.destinationRepoId) {
    throw new Error("Incomplete separated selector readback contract.")
  }
  const pinned = {
    adapter: input.adapter, read: input.adapter.read, exists: input.adapter.exists,
    stat: input.adapter.stat, journal: input.journal,
    walRead: input.journal.assertHealthySnapshot,
    secret: input.getSecret, holder: input.withExclusiveInitiatorLease,
    lease: input.assertExclusiveInitiatorLease, durable: input.assertCrashDurable,
    key: input.journalKey, keyCopy: Uint8Array.from(input.journalKey),
    identity: JSON.stringify(input.identity), settings: JSON.stringify(input.settings),
  }
  const unchanged = (): boolean => input.adapter === pinned.adapter
    && input.adapter.read === pinned.read && input.adapter.exists === pinned.exists
    && input.adapter.stat === pinned.stat
    && input.journal === pinned.journal
    && input.journal.assertHealthySnapshot === pinned.walRead
    && input.withExclusiveInitiatorLease === pinned.holder
    && input.assertExclusiveInitiatorLease === pinned.lease
    && input.assertCrashDurable === pinned.durable && input.getSecret === pinned.secret
    && input.journalKey === pinned.key
    && input.journalKey.every((byte, i) => byte === pinned.keyCopy[i])
    && JSON.stringify(input.identity) === pinned.identity
    && JSON.stringify(input.settings) === pinned.settings
    && input.journal.sourceCommitSha === input.identity.sourceCommitSha
    && input.journal.destinationRepoId === input.identity.destinationRepoId
  const identity = Object.freeze({ ...input.identity })
  const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
  const read = async () => {
    if (!await pinned.exists.call(pinned.adapter, roots.selectorPath)) return null
    const stat = await pinned.stat?.call(pinned.adapter, roots.selectorPath)
    if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES)) return null
    const value = await pinned.read.call(pinned.adapter, roots.selectorPath)
    const bytes = decode(value)
    if (!bytes) return null
    bytes.fill(0)
    return value
  }
  let invoked = false
  try {
    const result = await pinned.holder(async () => {
      if (invoked) throw new Error("Separated selector lease body invoked repeatedly.")
      invoked = true
      await pinned.lease()
      await pinned.durable()
      if (!unchanged() || !matchingSettings(input)) return MANUAL
      const selector = await read()
      if (!selector || !await authentic(selector, identity, pinned.key) || !unchanged()) return MANUAL
      const source = JSON.stringify(await loadV4LocalIndex(pinned.adapter, roots.sourceIndexRoot))
      const shadow = JSON.stringify(await loadV4LocalIndex(pinned.adapter, roots.shadowIndexRoot))
      if (!matchesIndex(JSON.parse(source) as V4LocalIndex, identity.sourceRepoId,
        identity.sourceCommitSha, identity.deviceId)
        || !matchesIndex(JSON.parse(shadow) as V4LocalIndex, identity.destinationRepoId,
          identity.destinationCommitSha, identity.deviceId)
        || !unchanged()) return MANUAL
      const oldSecret = pinned.secret(identity.sourcePassphraseSecretId)
      const newSecret = pinned.secret(identity.destinationPassphraseSecretId)
      if (!oldSecret || !newSecret || !unchanged()) return MANUAL
      const wal = await pinned.walRead.call(pinned.journal, identity.walGeneration)
      const walBytes = JSON.stringify(wal)
      if (!matchesV4ReencryptionPreparedWal(wal, identity) || !unchanged()) return MANUAL
      await pinned.lease()
      await pinned.durable()
      const secondSelector = await read()
      const secondSource = JSON.stringify(await loadV4LocalIndex(pinned.adapter, roots.sourceIndexRoot))
      const secondShadow = JSON.stringify(await loadV4LocalIndex(pinned.adapter, roots.shadowIndexRoot))
      const secondWal = await pinned.walRead.call(pinned.journal, identity.walGeneration)
      await pinned.lease()
      await pinned.durable()
      if (!unchanged() || selector !== secondSelector || source !== secondSource
        || shadow !== secondShadow || walBytes !== JSON.stringify(secondWal)
        || !matchesV4ReencryptionPreparedWal(secondWal, identity)
        || !matchingSettings(input)
        || pinned.secret(identity.sourcePassphraseSecretId) !== oldSecret
        || pinned.secret(identity.destinationPassphraseSecretId) !== newSecret
        || !unchanged()) return MANUAL
      return OBSERVED
    })
    return invoked && unchanged() && result === OBSERVED ? OBSERVED : MANUAL
  } finally {
    pinned.keyCopy.fill(0)
  }
}
