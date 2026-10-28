import { sha256Hex, utf8ToBytes } from "../bytes"
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import {
  isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndex, type V4LocalIndexAdapter,
} from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"

const SHA = /^[a-f0-9]{40}$/u
const RUN = /^[A-Za-z0-9_-]{8,128}$/u
const SEGMENT = /^[A-Za-z0-9_.-]+$/u
const activeIntents = new WeakMap<V4LocalIndexAdapter, Set<string>>()

export interface V4ReencryptionLocalCutoverIntentInput {
  readonly adapter: V4LocalIndexAdapter
  readonly activeIndexRoot: string
  readonly runId: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly destinationCommitSha: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
  readonly deviceId: string
  readonly walGeneration: number
  /** Genuine platform lease must exclude other cooperating local cutover writers. */
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  /** Genuine crash-persistence barrier supplied by an independently verified adapter. */
  readonly assertCrashDurable: () => Promise<void>
}

export interface V4ReencryptionLocalCutoverIntentRecord {
  readonly schemaVersion: 1
  readonly phase: "prepared-uncommitted"
  readonly runId: string
  readonly walGeneration: number
  readonly sourceIndexRoot: string
  readonly destinationIndexRoot: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly destinationCommitSha: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
  readonly deviceId: string
  /** An unkeyed corruption checksum, NOT authentication or a commit receipt. */
  readonly recordSha256: string
}

export interface V4ReencryptionLocalCutoverIntentResult {
  readonly status: "local-cutover-intent-prepared-uncommitted"
  readonly intentPath: string
  readonly recordSha256: string
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

type PinnedIntent = Omit<V4ReencryptionLocalCutoverIntentInput,
  "adapter" | "assertExclusiveInitiatorLease" | "assertCrashDurable">

function validIdentity(repoId: string): { owner: string; repo: string; branch: string } {
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(repoId)
  if (!match) throw new Error("Invalid cutover intent GitHub repository identity.")
  const owner = match[1]!
  const repo = match[2]!
  const branch = match[3]!
  assertSafeGitHubRepositoryCoordinates(owner, repo)
  assertSafeGitHubBranch(branch)
  return { owner, repo, branch }
}

function validate(input: V4ReencryptionLocalCutoverIntentInput): PinnedIntent {
  if (!input || typeof input.activeIndexRoot !== "string"
    || input.activeIndexRoot.split("/").length < 2
    || !input.activeIndexRoot.split("/").every(segment => SEGMENT.test(segment)
      && segment !== "." && segment !== "..")
    || typeof input.runId !== "string" || !RUN.test(input.runId)
    || !SHA.test(input.sourceCommitSha) || !SHA.test(input.destinationCommitSha)
    || input.sourceCommitSha === input.destinationCommitSha
    || !Number.isSafeInteger(input.walGeneration) || input.walGeneration <= 0
    || !input.deviceId || typeof input.deviceId !== "string"
    || typeof input.sourcePassphraseSecretId !== "string"
    || typeof input.destinationPassphraseSecretId !== "string"
    || !input.sourcePassphraseSecretId || !input.destinationPassphraseSecretId
    || input.sourcePassphraseSecretId === input.destinationPassphraseSecretId
    || [input.sourcePassphraseSecretId, input.destinationPassphraseSecretId].some(id =>
      id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id))
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.assertCrashDurable !== "function"
    || typeof input.adapter?.exists !== "function"
    || typeof input.adapter.read !== "function"
    || typeof input.adapter.write !== "function"
    || typeof input.adapter.mkdir !== "function") {
    throw new Error("Invalid strictly gated Re-encryption local cutover intent.")
  }
  const source = validIdentity(input.sourceRepoId)
  const backup = validIdentity(input.backupRepoId)
  const destination = validIdentity(input.destinationRepoId)
  if (source.owner !== backup.owner || source.owner !== destination.owner
    || source.repo !== backup.repo || source.repo !== destination.repo
    || new Set([source.branch, backup.branch, destination.branch]).size !== 3) {
    throw new Error("Cutover intent requires three distinct branches in one repository.")
  }
  return Object.freeze({
    activeIndexRoot: input.activeIndexRoot,
    runId: input.runId,
    sourceRepoId: input.sourceRepoId,
    backupRepoId: input.backupRepoId,
    destinationRepoId: input.destinationRepoId,
    sourceCommitSha: input.sourceCommitSha,
    destinationCommitSha: input.destinationCommitSha,
    sourcePassphraseSecretId: input.sourcePassphraseSecretId,
    destinationPassphraseSecretId: input.destinationPassphraseSecretId,
    deviceId: input.deviceId,
    walGeneration: input.walGeneration,
  })
}

function checkIndex(index: V4LocalIndex, pinned: PinnedIntent, role: "source" | "destination"): void {
  const repoId = role === "source" ? pinned.sourceRepoId : pinned.destinationRepoId
  const sha = role === "source" ? pinned.sourceCommitSha : pinned.destinationCommitSha
  if (index.repoId !== repoId || index.remoteCommitSha !== sha
    || index.deviceId !== pinned.deviceId || index.mode !== "encrypted"
    || index.pathLayout !== expectedV4PathLayout("encrypted")
    || !isV4LocalIndexCacheComplete(index)
    || Object.values(index.shards).some(shard =>
      Object.values(shard.records).some(record => record.dirty === true || record.deleted === true))) {
    throw new Error("Re-encryption " + role + " index is incomplete, dirty or mismatched.")
  }
}

function sameInput(
  input: V4ReencryptionLocalCutoverIntentInput,
  pinned: PinnedIntent,
  adapter: V4LocalIndexAdapter,
  lease: () => Promise<void>,
  durable: () => Promise<void>,
): boolean {
  return input.adapter === adapter
    && input.assertExclusiveInitiatorLease === lease
    && input.assertCrashDurable === durable
    && (Object.keys(pinned) as Array<keyof PinnedIntent>)
      .every(key => input[key] === pinned[key])
}

/**
 * Prepare ONLY the independent, nonsecret intent for a future restart-safe
 * transaction. Never write either index root, Settings or SecretStorage.
 *
 * A partial or completed intent directory is never reused automatically.
 * The caller must separately authenticate the remote fork and WAL and supply
 * platform-backed exclusive writer and crash-durability assertions.
 * This checksum cannot authenticate a malicious or forged local record.
 */
export async function prepareV4ReencryptionLocalCutoverIntent(
  input: V4ReencryptionLocalCutoverIntentInput,
): Promise<V4ReencryptionLocalCutoverIntentResult> {
  const pinned = validate(input)
  const adapter = input.adapter
  const lease = input.assertExclusiveInitiatorLease
  const durable = input.assertCrashDurable
  const intentRoot = pinned.activeIndexRoot + "-rekey-intent-" + pinned.runId
  const shadowRoot = pinned.activeIndexRoot + "-rekey-" + pinned.runId
  const intentPath = intentRoot + "/intent.json"
  const claim = activeIntents.get(adapter) ?? new Set<string>()
  if (claim.has(intentRoot)) throw new Error("Concurrent local cutover intent preparation requires manual recovery.")
  claim.add(intentRoot)
  activeIntents.set(adapter, claim)
  try {
    await lease()
    if (!sameInput(input, pinned, adapter, lease, durable)) {
      throw new Error("Local cutover intent storage contract changed before staging.")
    }
    await durable()
    const sourceIndex = await loadV4LocalIndex(adapter, pinned.activeIndexRoot)
    const destinationIndex = await loadV4LocalIndex(adapter, shadowRoot)
    checkIndex(sourceIndex, pinned, "source")
    checkIndex(destinationIndex, pinned, "destination")
    if (!sameInput(input, pinned, adapter, lease, durable)) {
      throw new Error("Local cutover intent input changed before staging.")
    }
    await lease()
    if (await adapter.exists(intentRoot)) {
      throw new Error("Existing local cutover intent requires manual recovery; never overwrite or reuse.")
    }
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      phase: "prepared-uncommitted" as const,
      runId: pinned.runId,
      walGeneration: pinned.walGeneration,
      sourceIndexRoot: pinned.activeIndexRoot,
      destinationIndexRoot: shadowRoot,
      sourceRepoId: pinned.sourceRepoId,
      backupRepoId: pinned.backupRepoId,
      destinationRepoId: pinned.destinationRepoId,
      sourceCommitSha: pinned.sourceCommitSha,
      destinationCommitSha: pinned.destinationCommitSha,
      sourcePassphraseSecretId: pinned.sourcePassphraseSecretId,
      destinationPassphraseSecretId: pinned.destinationPassphraseSecretId,
      deviceId: pinned.deviceId,
    })
    const recordSha256 = await sha256Hex(utf8ToBytes(JSON.stringify(payload)))
    const record: V4ReencryptionLocalCutoverIntentRecord = { ...payload, recordSha256 }
    const serialized = JSON.stringify(record)
    if (!sameInput(input, pinned, adapter, lease, durable)) {
      throw new Error("Local cutover intent storage contract changed before write.")
    }
    await adapter.mkdir(intentRoot)
    await adapter.write(intentPath, serialized)
    await durable()
    await lease()
    const actual = await adapter.read(intentPath)
    if (actual !== serialized) throw new Error("Local cutover intent readback mismatch; manual recovery required.")
    await durable()
    await lease()
    if (!sameInput(input, pinned, adapter, lease, durable)) {
      throw new Error("Local cutover intent identity changed during preparation.")
    }
    checkIndex(await loadV4LocalIndex(adapter, pinned.activeIndexRoot), pinned, "source")
    checkIndex(await loadV4LocalIndex(adapter, shadowRoot), pinned, "destination")
    if (!sameInput(input, pinned, adapter, lease, durable)) {
      throw new Error("Local cutover intent storage contract changed after readback.")
    }
    return Object.freeze({
      status: "local-cutover-intent-prepared-uncommitted",
      intentPath, recordSha256,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
    })
  } finally {
    claim.delete(intentRoot)
    if (claim.size === 0) activeIntents.delete(adapter)
  }
}
