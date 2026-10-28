import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from "../bytes"
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import type { V4ReencryptionRecoveryJournal, V4ReencryptionJournalSnapshot } from "./reencryption-recovery-journal"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"

const SHA = /^[0-9a-f]{40}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SECRET = /^[^\u0000-\u001f\u007f]{1,256}$/u
const MAX_RECEIPT_BYTES = 8 * 1024
const CONTEXT = "v4-rekey-proposed-local-commit-v1"
const IDENTITY_KEYS = Object.freeze([
  "runId", "walGeneration", "indexRoot", "deviceId",
  "sourceRepoId", "backupRepoId", "destinationRepoId",
  "sourceCommitSha", "sourceTreeSha", "destinationCommitSha",
  "destinationTreeSha", "manifestSha256",
  "sourcePassphraseSecretId", "destinationPassphraseSecretId",
].sort())

/**
 * A hypothetical future receipt: the exact identity must be pinned from
 * independent D138 evidence, never inferred from saved device Settings.
 * A valid AES-GCM payload is NOT a durable or authorized cutover commit.
 */
export interface V4ReencryptionProposedCommitIdentity {
  readonly runId: string
  readonly walGeneration: number
  readonly indexRoot: string
  readonly deviceId: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly sourceTreeSha: string
  readonly destinationCommitSha: string
  readonly destinationTreeSha: string
  readonly manifestSha256: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
}

interface Marker {
  readonly schemaVersion: 1
  readonly phase: "hypothetical-commit-marker-uncommitted"
  readonly identity: V4ReencryptionProposedCommitIdentity
}

export interface V4ReencryptionProposedCommitReport {
  readonly integrityScope: "authenticated-hypothetical-local-marker-read-only"
  readonly observation: "authenticated-marker-with-destination-observed-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

export interface V4ReencryptionProposedCommitInspectionInput {
  readonly identity: V4ReencryptionProposedCommitIdentity
  readonly journalKey: Uint8Array
  readonly adapter: V4LocalIndexAdapter
  readonly settings: V4LocalCutoverSettings
  readonly journal: Pick<V4ReencryptionRecoveryJournal,
    "sourceCommitSha" | "destinationRepoId" | "assertHealthySnapshot">
  readonly getSecret: (id: string) => string | null
  /** The holder must really exclude cooperating writers across ALL readbacks. */
  readonly withExclusiveInitiatorLease: <T>(body: () => Promise<T>) => Promise<T>
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  /** A caller callback cannot by itself qualify physical durability. */
  readonly assertCrashDurable: () => Promise<void>
}

const MANUAL: V4ReencryptionProposedCommitReport = Object.freeze({
  integrityScope: "authenticated-hypothetical-local-marker-read-only",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const OBSERVED: V4ReencryptionProposedCommitReport = Object.freeze({
  ...MANUAL,
  observation: "authenticated-marker-with-destination-observed-uncommitted",
})

function parseRepo(value: string): { owner: string; repo: string; branch: string } {
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(value)
  if (!match) throw new Error("Invalid proposed cutover repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { owner, repo, branch }
}

export function assertV4ReencryptionProposedCommitIdentity(identity: V4ReencryptionProposedCommitIdentity): void {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).sort().join("|") !== IDENTITY_KEYS.join("|")
    || !RUN.test(identity.runId)
    || !RUN.test(identity.deviceId)
    || typeof identity.indexRoot !== "string"
    || identity.indexRoot.split("/").length < 2
    || !identity.indexRoot.split("/").every(part =>
      /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..")
    || !Number.isSafeInteger(identity.walGeneration) || identity.walGeneration < 1
    || !SHA.test(identity.sourceCommitSha) || !SHA.test(identity.sourceTreeSha)
    || !SHA.test(identity.destinationCommitSha) || !SHA.test(identity.destinationTreeSha)
    || identity.sourceCommitSha === identity.destinationCommitSha
    || !DIGEST.test(identity.manifestSha256)
    || !SECRET.test(identity.sourcePassphraseSecretId)
    || !SECRET.test(identity.destinationPassphraseSecretId)
    || identity.sourcePassphraseSecretId === identity.destinationPassphraseSecretId) {
    throw new Error("Invalid proposed cutover receipt identity.")
  }
  const source = parseRepo(identity.sourceRepoId)
  const backup = parseRepo(identity.backupRepoId)
  const destination = parseRepo(identity.destinationRepoId)
  if (source.owner !== backup.owner || source.owner !== destination.owner
    || source.repo !== backup.repo || source.repo !== destination.repo
    || new Set([source.branch, backup.branch, destination.branch]).size !== 3) {
    throw new Error("Proposed receipt requires three distinct refs in one GitHub repository.")
  }
}

function validateKey(journalKey: Uint8Array): void {
  if (!(journalKey instanceof Uint8Array) || journalKey.length !== 32) {
    throw new Error("Proposed cutover marker needs the independently derived V4 journal key.")
  }
}

function marker(identity: V4ReencryptionProposedCommitIdentity): Marker {
  return { schemaVersion: 1, phase: "hypothetical-commit-marker-uncommitted", identity }
}

function aad(identity: V4ReencryptionProposedCommitIdentity): string {
  return CONTEXT + ":" + identity.runId + ":" + identity.sourceCommitSha
    + ":" + identity.destinationRepoId + ":" + identity.destinationCommitSha
}

/** Derive a distinct receipt-specific AES key; the WAL journal key is never serialized. */
async function receiptKey(journalKey: Uint8Array): Promise<Uint8Array> {
  const hmac = await crypto.subtle.importKey("raw", journalKey as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmac,
    utf8ToBytes(CONTEXT + ":key") as any))
}

/**
 * Compose isolated test vectors ONLY. Returns bytes, never writes a receipt.
 * Neither this function nor its output can authorize production commit.
 */
export async function sealV4ReencryptionProposedCommitTestVector(
  identity: V4ReencryptionProposedCommitIdentity,
  journalKey: Uint8Array,
): Promise<string> {
  assertV4ReencryptionProposedCommitIdentity(identity)
  validateKey(journalKey)
  const plaintext = utf8ToBytes(JSON.stringify(marker(identity)))
  if (plaintext.byteLength > MAX_RECEIPT_BYTES / 2) throw new Error("Proposed cutover marker exceeds size limit.")
  const key = await receiptKey(journalKey)
  try {
    const encrypted = await encryptV4Payload(key, plaintext, { kind: "journal", aad: aad(identity) })
    try { return toBase64(encrypted) }
    finally { encrypted.fill(0) }
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

function canonicalEncoded(encoded: string): Uint8Array | null {
  if (typeof encoded !== "string"
    || encoded.length === 0 || encoded.length > MAX_RECEIPT_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return null
  const bytes = fromBase64(encoded)
  if (toBase64(bytes) !== encoded || bytes.byteLength > MAX_RECEIPT_BYTES) return null
  return bytes
}

async function authenticated(
  expected: V4ReencryptionProposedCommitIdentity,
  journalKey: Uint8Array,
  encoded: string,
): Promise<boolean> {
  const bytes = canonicalEncoded(encoded)
  if (!bytes) return false
  const key = await receiptKey(journalKey)
  try {
    let plaintext: Uint8Array
    try {
      plaintext = await decryptV4Payload(key, bytes, { kind: "journal", aad: aad(expected) })
    } catch { return false }
    try {
      // Canonical record and exact field set: reject same-key extra fields and
      // replayed identities even when their AES-GCM tag is valid.
      return plaintext.byteLength <= MAX_RECEIPT_BYTES / 2
        && bytesToUtf8(plaintext) === JSON.stringify(marker(expected))
    } finally { plaintext.fill(0) }
  } finally {
    key.fill(0)
    bytes.fill(0)
  }
}

function matchesIndex(index: V4LocalIndex, identity: V4ReencryptionProposedCommitIdentity): boolean {
  return index.repoId === identity.destinationRepoId
    && index.remoteCommitSha === identity.destinationCommitSha
    && index.deviceId === identity.deviceId
    && index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && isV4LocalIndexCacheComplete(index)
    && Object.values(index.shards).every(shard =>
      Object.values(shard.records).every(record => record.dirty !== true && record.deleted !== true))
}

export function matchesV4ReencryptionPreparedWal(wal: V4ReencryptionJournalSnapshot, identity: V4ReencryptionProposedCommitIdentity): boolean {
  const backup = wal.verifiedRefObservations.find(r => r.role === "backup")
  const dest = wal.verifiedRefObservations.find(r => r.role === "destination")
  const prepared = wal.preparedCandidateReceipt
  return wal.generation === identity.walGeneration
    && wal.requiresRemoteRevalidation === true
    && wal.cutoverAuthorized === false && wal.permissionToPublish === false
    && wal.stageHandoffStarted === true
    && typeof wal.candidatePreparationSha256 === "string"
    && DIGEST.test(wal.candidatePreparationSha256)
    && wal.pendingIntents.length === 0 && wal.pendingRefIntents.length === 0
    && wal.verifiedRefObservations.length === 2
    && !!prepared && !!backup && !!dest
    && prepared.commitSha === identity.destinationCommitSha
    && prepared.treeSha === identity.destinationTreeSha
    && prepared.manifestSha256 === identity.manifestSha256
    && backup.repoId === identity.backupRepoId
    && backup.commitSha === identity.sourceCommitSha
    && backup.treeSha === identity.sourceTreeSha
    && backup.manifestSha256 === undefined
    && dest.repoId === identity.destinationRepoId
    && dest.commitSha === identity.destinationCommitSha
    && dest.treeSha === identity.destinationTreeSha
    && dest.manifestSha256 === identity.manifestSha256
}

function matchingSettings(settings: V4LocalCutoverSettings, identity: V4ReencryptionProposedCommitIdentity): boolean {
  const dest = parseRepo(identity.destinationRepoId)
  return settings.githubOwner === dest.owner
    && settings.githubRepo === dest.repo && settings.githubBranch === dest.branch
    && settings.encryptionMode === "encrypted"
    && settings.encryptionPassphraseSecretId === identity.destinationPassphraseSecretId
    && settings.vault === identity.deviceId
}

async function readMarker(adapter: V4LocalIndexAdapter, path: string): Promise<string | null> {
  if (!await adapter.exists(path)) return null
  const stat = await adapter.stat?.(path)
  if (stat && (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_RECEIPT_BYTES)) return null
  const encoded = await adapter.read(path)
  return canonicalEncoded(encoded) ? encoded : null
}

/**
 * D142: authenticates a *hypothetical* local marker and brackets mutable
 * Settings / Index / Shadow / WAL / SecretStorage under one supplied lease.
 *
 * Does not inspect live Git refs, original Source cache, real OS fsync state,
 * editor/vault writers or native SecretStorage disk. ALL results non-authorizing.
 */
export async function inspectV4ReencryptionProposedCommitAfterRestart(
  input: V4ReencryptionProposedCommitInspectionInput,
): Promise<V4ReencryptionProposedCommitReport> {
  if (!input) throw new Error("Missing proposed cutover inspection input.")
  assertV4ReencryptionProposedCommitIdentity(input.identity)
  validateKey(input.journalKey)
  if (typeof input.adapter?.read !== "function"
    || typeof input.adapter.exists !== "function"
    || typeof input.journal?.assertHealthySnapshot !== "function"
    || typeof input.getSecret !== "function"
    || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || input.journal.sourceCommitSha !== input.identity.sourceCommitSha
    || input.journal.destinationRepoId !== input.identity.destinationRepoId) {
    throw new Error("Incomplete proposed cutover restart reader contract.")
  }
  const captured = {
    adapter: input.adapter, read: input.adapter.read, exists: input.adapter.exists, stat: input.adapter.stat,
    journal: input.journal, walRead: input.journal.assertHealthySnapshot,
    holder: input.withExclusiveInitiatorLease, lease: input.assertExclusiveInitiatorLease,
    durable: input.assertCrashDurable, secret: input.getSecret,
    journalKey: input.journalKey, journalKeyHex: toBase64(input.journalKey),
    identity: JSON.stringify(input.identity), settings: JSON.stringify(input.settings),
  }
  const unchanged = (): boolean => input.adapter === captured.adapter
    && input.adapter.read === captured.read && input.adapter.exists === captured.exists
    && input.adapter.stat === captured.stat
    && input.journal === captured.journal && input.journal.assertHealthySnapshot === captured.walRead
    && input.withExclusiveInitiatorLease === captured.holder
    && input.assertExclusiveInitiatorLease === captured.lease && input.assertCrashDurable === captured.durable
    && input.getSecret === captured.secret && input.journalKey === captured.journalKey
    && toBase64(input.journalKey) === captured.journalKeyHex
    && JSON.stringify(input.identity) === captured.identity
    && JSON.stringify(input.settings) === captured.settings
    && input.journal.sourceCommitSha === input.identity.sourceCommitSha
    && input.journal.destinationRepoId === input.identity.destinationRepoId

  const identity = input.identity
  const path = identity.indexRoot + "-rekey-proposed-" + identity.runId + "/marker.json"
  const shadowRoot = identity.indexRoot + "-rekey-" + identity.runId
  let invoked = false
  const result = await captured.holder(async () => {
    if (invoked) throw new Error("Proposed cutover lease body invoked repeatedly.")
    invoked = true
    await captured.lease()
    await captured.durable()
    if (!unchanged() || !matchingSettings(input.settings, identity)) return MANUAL
    const first = await readMarker(captured.adapter, path)
    if (!first || !await authenticated(identity, captured.journalKey, first) || !unchanged()) return MANUAL
    const firstActive = JSON.stringify(await loadV4LocalIndex(captured.adapter, identity.indexRoot))
    const firstShadow = JSON.stringify(await loadV4LocalIndex(captured.adapter, shadowRoot))
    if (!matchesIndex(JSON.parse(firstActive) as V4LocalIndex, identity)
      || !matchesIndex(JSON.parse(firstShadow) as V4LocalIndex, identity)
      || !unchanged()) return MANUAL
    const oldSecret = captured.secret(identity.sourcePassphraseSecretId)
    const newSecret = captured.secret(identity.destinationPassphraseSecretId)
    if (!oldSecret || !newSecret || !unchanged()) return MANUAL
    const firstWal = await captured.walRead.call(captured.journal, identity.walGeneration)
    const walBytes = JSON.stringify(firstWal)
    if (!matchesV4ReencryptionPreparedWal(firstWal, identity) || !unchanged()) return MANUAL
    await captured.lease()
    await captured.durable()
    const second = await readMarker(captured.adapter, path)
    const secondActive = JSON.stringify(await loadV4LocalIndex(captured.adapter, identity.indexRoot))
    const secondShadow = JSON.stringify(await loadV4LocalIndex(captured.adapter, shadowRoot))
    const secondWal = await captured.walRead.call(captured.journal, identity.walGeneration)
    if (!unchanged() || second !== first
      || firstActive !== secondActive || firstShadow !== secondShadow
      || walBytes !== JSON.stringify(secondWal) || !matchesV4ReencryptionPreparedWal(secondWal, identity)
      || !matchingSettings(input.settings, identity)
      || captured.secret(identity.sourcePassphraseSecretId) !== oldSecret
      || captured.secret(identity.destinationPassphraseSecretId) !== newSecret
      || !unchanged()) return MANUAL
    return OBSERVED
  })
  if (!invoked || !unchanged()) return MANUAL
  return result === OBSERVED ? OBSERVED : MANUAL
}
