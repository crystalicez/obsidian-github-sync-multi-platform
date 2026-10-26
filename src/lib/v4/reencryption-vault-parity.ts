import { utf8ToBytes } from "../bytes"
import type { V4Keyring } from "./crypto"
import { V4_MIN_NEW_PBKDF2_ITERATIONS, assertV4Pbkdf2Iterations } from "./kdf-policy"
import type { V4IndexFileRecord } from "./local-index"
import type { V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import { inspectV4ReencryptionInventory } from "./reencryption-inventory"
import { assertV4RemoteRecordSet, decodeV4RemoteConfig, type V4RemoteShard } from "./remote-index"
import type { V4RemoteConfig, V4RemoteHead } from "./protocol-types"

/**
 * Metadata-only WHOLE-VAULT parity between a pinned, authenticated V4 source
 * snapshot and every completely finalized candidate destination record.
 *
 * IMPORTANT: Callers must prove that source head/shards come from the exact
 * pinned commit, that output records came from completed transcode streams,
 * and that the eventual destination ciphertext is independently verified.
 * This function has NO GitHub access, publishing authority or cutover power.
 */
export interface V4ReencryptionVaultParityInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly sourceConfig: V4RemoteConfig
  readonly sourceHead: V4RemoteHead
  readonly sourceShards: Readonly<Record<string, V4RemoteShard>>
  readonly sourceKeyring: V4Keyring
  readonly destinationConfig: V4RemoteConfig
  readonly destinationKeyring: V4Keyring
  readonly destinationRecords: readonly V4IndexFileRecord[]
}

export interface V4ReencryptionVaultParityPreview {
  readonly integrityScope: "metadata-parity-only"
  readonly destinationContentVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
  readonly pinnedSourceCommitSha: string
  readonly destinationRepoId: string
  readonly matchedLiveFileCount: number
  readonly totalMatchedPlaintextBytes: string
  readonly destinationObjectCount: number
  readonly sourceTombstoneCount: number
}

function pathsOf(record: V4IndexFileRecord): readonly string[] {
  return record.storage === "chunked" ? record.partPaths ?? [] : [record.remotePath]
}

function identicalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

function requireEncryptedConfig(config: V4RemoteConfig, expectedRepoId: string): V4RemoteConfig {
  const parsed = decodeV4RemoteConfig(utf8ToBytes(JSON.stringify(config)))
  if (parsed.formatVersion !== 4 || parsed.repoId !== expectedRepoId
    || parsed.mode !== "encrypted" || parsed.pathLayout !== "opaque-stable-v1"
    || parsed.algorithm !== "AES-GCM" || parsed.kdf !== "PBKDF2-SHA-256"
    || !parsed.kdfParams) {
    throw new Error("Re-encryption vault parity requires the approved encrypted V4 repository identity.")
  }
  return parsed
}

export async function assertV4ReencryptionVaultParity(
  input: V4ReencryptionVaultParityInput,
): Promise<V4ReencryptionVaultParityPreview> {
  const { plan, sourceShards, sourceKeyring, destinationKeyring } = input
  if (plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || plan.sourceRepoId === plan.destinationRepoId
    || !/^[0-9a-f]{40}$/u.test(plan.pinnedSourceCommitSha)) {
    throw new Error("Re-encryption vault parity requires a valid pinned orphan-branch migration plan.")
  }
  const sourceConfig = requireEncryptedConfig(input.sourceConfig, plan.sourceRepoId)
  const destinationConfig = requireEncryptedConfig(input.destinationConfig, plan.destinationRepoId)
  assertV4Pbkdf2Iterations(destinationConfig.kdfParams!.iterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
  if (sourceConfig.kdfParams!.salt === destinationConfig.kdfParams!.salt
    || identicalBytes(sourceKeyring.contentKey, destinationKeyring.contentKey)
    || identicalBytes(sourceKeyring.pathKey, destinationKeyring.pathKey)) {
    throw new Error("Re-encryption vault parity requires new destination KDF salt and independent keys.")
  }

  // Check the complete authenticated source shard set before comparing a
  // single destination record. This also rejects unsafe logical path aliases.
  const sourcePreview = await inspectV4ReencryptionInventory({
    config: sourceConfig, head: input.sourceHead, shards: sourceShards,
    keyring: sourceKeyring, pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
  })
  if (!Array.isArray(input.destinationRecords)) {
    throw new Error("Re-encryption destination records must be a finalized complete list.")
  }
  const destination = Array.from(input.destinationRecords)
  if (destination.some(record => !record || record.deleted || record.dirty)) {
    throw new Error("Re-encryption destination cannot contain deleted or dirty records.")
  }
  // Enforce the destination's independently keyed opaque coordinates and
  // logical paths, including collision/file-as-directory protection.
  await assertV4RemoteRecordSet(destination, destinationConfig, destinationKeyring)
  const byPath = new Map<string, V4IndexFileRecord>()
  for (const record of destination) {
    if (byPath.has(record.path)) throw new Error("Re-encryption destination has a duplicate logical file.")
    byPath.set(record.path, record)
  }
  const sourceFiles = new Map<string, V4IndexFileRecord>()
  const oldFileIds = new Set<string>()
  const oldObjects = new Set<string>()
  let sourceTombstoneCount = 0
  for (const shard of Object.values(sourceShards)) {
    for (const record of Object.values(shard.records)) {
      oldFileIds.add(record.fileId)
      if (record.deleted) { sourceTombstoneCount++; continue }
      sourceFiles.set(record.path, record)
      for (const path of pathsOf(record)) oldObjects.add(path)
    }
  }
  if (sourceFiles.size !== sourcePreview.fileCount
    || byPath.size !== sourcePreview.fileCount) {
    throw new Error("Re-encryption whole-vault parity has missing or unexpected live files.")
  }

  let matched = 0
  let logicalBytes = BigInt(0)
  const occupied = new Map<string, { storage: V4IndexFileRecord["storage"]; packId?: string }>()
  for (const [path, source] of sourceFiles) {
    const target = byPath.get(path)
    if (!target) throw new Error("Re-encryption whole-vault parity has a missing live file.")
    if (target.plaintextSha256 !== source.plaintextSha256
      || target.size !== source.size || target.mtime !== source.mtime) {
      throw new Error("Re-encryption whole-vault plaintext hash, size or mtime mismatch.")
    }
    if (oldFileIds.has(target.fileId) || target.pathId === source.pathId) {
      throw new Error("Re-encryption destination reused source file or opaque path identity.")
    }
    for (const objectPath of pathsOf(target)) {
      if (oldObjects.has(objectPath)) {
        throw new Error("Re-encryption destination referenced a source encrypted object.")
      }
      const previous = occupied.get(objectPath)
      if (previous && !(target.storage === "pack" && previous.storage === "pack"
        && target.packId === previous.packId)) {
        throw new Error("Re-encryption destination contains unsafe shared object paths.")
      }
      occupied.set(objectPath, {
        storage: target.storage, ...(target.packId ? { packId: target.packId } : {}),
      })
    }
    matched++
    logicalBytes += BigInt(target.size)
  }
  if (matched !== sourcePreview.fileCount
    || logicalBytes.toString() !== sourcePreview.totalLogicalBytes) {
    throw new Error("Re-encryption whole-vault inventory totals do not match.")
  }
  // This is a non-authorizing METADATA parity report. Tombstones/history
  // remain in the old branch, and second-device complete-content proof,
  // Backup integrity, durable WAL and safe initiating-device cutover are
  // separate gates. D90 does NOT fence old-branch clients.
  return Object.freeze({
    integrityScope: "metadata-parity-only",
    destinationContentVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
    pinnedSourceCommitSha: plan.pinnedSourceCommitSha,
    destinationRepoId: plan.destinationRepoId,
    matchedLiveFileCount: matched,
    totalMatchedPlaintextBytes: logicalBytes.toString(),
    destinationObjectCount: occupied.size,
    sourceTombstoneCount,
  })
}
