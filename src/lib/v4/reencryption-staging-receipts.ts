import { throwIfV4Aborted } from "./cancellation"
import { computeV4GitBlobSha1 } from "./git-blob-identity"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"
import type { V4IndexFileRecord } from "./local-index"
import { inspectV4ReencryptionInventory } from "./reencryption-inventory"
import { createV4ReencryptedObjectStream } from "./reencryption-stream-transcode"
import {
  assertV4ReencryptionVaultParity, type V4ReencryptionVaultParityInput,
} from "./reencryption-vault-parity"
import type { V4RemoteShard } from "./remote-index"

/**
 * Stages immutable NEW ciphertext object blobs, checks each Git SHA-1 receipt,
 * fully finalizes every D76 stream, then establishes D78 whole-vault parity.
 *
 * IMPORTANT: The injected stageImmutableObject may write otherwise unreachable
 * Git blobs. NO refs, heads, indexes, active vault data or settings are changed
 * by this module. This is NOT a durable upload journal or a publication token.
 */
export interface V4ReencryptionStageInput extends Omit<V4ReencryptionVaultParityInput, "destinationRecords"> {
  readonly readSourceObject: (path: string, pinnedSha: string) => Promise<Uint8Array | null>
  readonly verifySourceStillPinned: () => Promise<void>
  readonly stageImmutableObject: (opaquePath: string, bytes: Uint8Array) => Promise<string>
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionObjectReceipt {
  readonly path: string
  readonly sha: string
  readonly byteLength: number
}

export interface V4ReencryptionStagingPreview {
  readonly integrityScope: "staged-immutable-blobs-only"
  readonly backupVerified: false
  readonly destinationReadbackVerified: false
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
  readonly pinnedSourceCommitSha: string
  readonly destinationRepoId: string
  readonly finalizedFileCount: number
  readonly validatedReceiptCount: number
  readonly totalPlaintextBytes: string
}

export interface V4ReencryptionStagingResult {
  /** INTERNAL ONLY: contains plaintext logical paths; never log or show it. */
  readonly records: readonly V4IndexFileRecord[]
  /** INTERNAL ONLY: authenticated receipt paths; must not be published. */
  readonly receipts: readonly V4ReencryptionObjectReceipt[]
  /** Sanitized; never acts as an authorization token. */
  readonly preview: V4ReencryptionStagingPreview
}

function liveSourceRecords(shards: Readonly<Record<string, V4RemoteShard>>): V4IndexFileRecord[] {
  return Object.values(shards).flatMap(shard =>
    Object.values(shard.records).filter(record => !record.deleted))
    .sort((a, b) => a.pathId.localeCompare(b.pathId))
}

export async function stageV4ReencryptionVaultObjects(
  input: V4ReencryptionStageInput,
): Promise<V4ReencryptionStagingResult> {
  throwIfV4Aborted(input.signal)
  // Fail before any staged writes if source index/shards are incomplete.
  const sourceSummary = await inspectV4ReencryptionInventory({
    config: input.sourceConfig, head: input.sourceHead, shards: input.sourceShards,
    keyring: input.sourceKeyring, pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
  })
  if (input.sourceConfig.repoId !== input.plan.sourceRepoId) {
    throw new Error("Re-encryption staging source repository identity mismatch.")
  }
  throwIfV4Aborted(input.signal)
  await input.verifySourceStillPinned()
  throwIfV4Aborted(input.signal)
  const destinationRecords: V4IndexFileRecord[] = []
  const receipts: V4ReencryptionObjectReceipt[] = []
  const seenObjectPaths = new Set<string>()
  let totalPlaintextBytes = BigInt(0)
  for (const record of liveSourceRecords(input.sourceShards)) {
    throwIfV4Aborted(input.signal)
    await input.verifySourceStillPinned()
    throwIfV4Aborted(input.signal)
    const prepared = await createV4ReencryptedObjectStream({
      plan: input.plan,
      sourceConfig: input.sourceConfig,
      destinationConfig: input.destinationConfig,
      sourceKeyring: input.sourceKeyring,
      destinationKeyring: input.destinationKeyring,
      sourceRecord: record,
      readSourceObject: input.readSourceObject,
      verifySourceStillPinned: input.verifySourceStillPinned,
      signal: input.signal,
    })
    if (prepared.objectCount < 1
      || !Number.isSafeInteger(prepared.objectCount)
      || prepared.objectPaths.length !== prepared.objectCount
      || new Set(prepared.objectPaths).size !== prepared.objectCount) {
      throw new Error("Re-encryption staging prepared an incomplete or duplicate object list.")
    }
    let actualObjects = 0
    for await (const object of prepared.objects(input.signal)) {
      try {
        throwIfV4Aborted(input.signal)
        const expectedPath = prepared.objectPaths[actualObjects]
        if (expectedPath === undefined || object.path !== expectedPath
          || seenObjectPaths.has(object.path)
          || !(object.bytes instanceof Uint8Array)
          || object.bytes.byteLength < 1
          || object.bytes.byteLength > V4_GITHUB_REST_SAFE_WRITER_BYTES) {
          throw new Error("Re-encryption staged object path/size/identity is invalid.")
        }
        const expectedSha = computeV4GitBlobSha1(object.bytes)
        const suppliedSha = await input.stageImmutableObject(object.path, object.bytes)
        throwIfV4Aborted(input.signal)
        // A mutable byte array can be modified by an untrusted/staging
        // callback during its awaited upload. Rehash after the callback to
        // fail closed without allocating a second full-size ciphertext copy.
        if (suppliedSha !== expectedSha || computeV4GitBlobSha1(object.bytes) !== expectedSha) {
          throw new Error("Re-encryption immutable Git blob receipt SHA identity mismatch.")
        }
        seenObjectPaths.add(object.path)
        receipts.push(Object.freeze({
          path: object.path, sha: suppliedSha, byteLength: object.bytes.byteLength,
        }))
        actualObjects++
      } finally {
        object.release?.()
      }
    }
    if (actualObjects !== prepared.objectCount) {
      throw new Error("Re-encryption staged incomplete immutable object receipts.")
    }
    throwIfV4Aborted(input.signal)
    // No finalize on an incomplete object stream. A successful finalize
    // recomputes the entire plaintext SHA-256 and checks declared byte size.
    const output = await prepared.finalize()
    throwIfV4Aborted(input.signal)
    const completed = { ...output, path: record.path }
    destinationRecords.push(completed)
    totalPlaintextBytes += BigInt(output.size)
  }
  throwIfV4Aborted(input.signal)
  await input.verifySourceStillPinned()
  throwIfV4Aborted(input.signal)
  const parity = await assertV4ReencryptionVaultParity({
    plan: input.plan,
    sourceConfig: input.sourceConfig,
    sourceHead: input.sourceHead,
    sourceShards: input.sourceShards,
    sourceKeyring: input.sourceKeyring,
    destinationConfig: input.destinationConfig,
    destinationKeyring: input.destinationKeyring,
    destinationRecords,
  })
  if (destinationRecords.length !== sourceSummary.fileCount
    || destinationRecords.length !== parity.matchedLiveFileCount
    || receipts.length !== seenObjectPaths.size
    || receipts.length !== parity.destinationObjectCount
    || totalPlaintextBytes.toString() !== sourceSummary.totalLogicalBytes) {
    throw new Error("Re-encryption staging failed whole-vault object receipt parity.")
  }
  return Object.freeze({
    records: Object.freeze(destinationRecords.map(record => Object.freeze({
      ...record,
      ...(record.partPaths ? {
        // Detach and freeze the nested path list as well. A later caller must
        // not be able to mutate a formerly validated multipart manifest.
        partPaths: Object.freeze([...record.partPaths]) as unknown as string[],
      } : {}),
    }))),
    receipts: Object.freeze(receipts),
    preview: Object.freeze({
      integrityScope: "staged-immutable-blobs-only",
      backupVerified: false,
      destinationReadbackVerified: false,
      permissionToPublish: false,
      cutoverAuthorized: false,
      pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
      destinationRepoId: input.plan.destinationRepoId,
      finalizedFileCount: destinationRecords.length,
      validatedReceiptCount: receipts.length,
      totalPlaintextBytes: totalPlaintextBytes.toString(),
    }),
  })
}
