import { randomBytes, toBase64Url } from "../bytes"
import { throwIfV4Aborted } from "./cancellation"
import type { V4ContentSource } from "./content-source"
import { decryptV4Payload, type V4Keyring } from "./crypto"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import { maxV4NewWriterPlaintextBytes } from "./large-files"
import type { V4IndexFileRecord } from "./local-index"
import type { V4PreparedObjectStream } from "./object-stream"
import type { V4OrphanReencryptionPlan } from "./reencryption-orphan-branch"
import { assertV4RemoteRecordSet } from "./remote-index"
import type { V4RemoteConfig } from "./protocol-types"
import { V4StorageCodec } from "./storage-codec"

/**
 * Prepares new encrypted remote objects from a single already authenticated,
 * PINNED source record. An untrusted caller MUST NOT publish yielded objects:
 * only the completed stream plus finalize() can attest the full plaintext hash.
 *
 * This module does NOT write GitHub refs, mutate an Obsidian vault, rotate
 * settings, or permit per-device cutover. An independently authenticated whole
 * source inventory, backup and source quiescence remain separate mandatory gates.
 */
export interface V4ReencryptionTranscodeInput {
  readonly plan: V4OrphanReencryptionPlan
  readonly sourceConfig: V4RemoteConfig
  readonly destinationConfig: V4RemoteConfig
  readonly sourceKeyring: V4Keyring
  readonly destinationKeyring: V4Keyring
  readonly sourceRecord: V4IndexFileRecord
  readonly readSourceObject: (path: string, exactCommitSha: string) => Promise<Uint8Array | null>
  readonly verifySourceStillPinned: () => Promise<void>
  readonly targetVersion?: string | undefined
  readonly signal?: AbortSignal | undefined
}

function isSameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export async function createV4ReencryptedObjectStream(
  input: V4ReencryptionTranscodeInput,
): Promise<V4PreparedObjectStream> {
  throwIfV4Aborted(input.signal)
  const { plan, sourceConfig, destinationConfig, sourceRecord } = input
  if (plan.kind !== "same-repository-new-orphan-branch"
    || plan.status !== "blocked-pending-migration-implementation"
    || sourceConfig.repoId !== plan.sourceRepoId || destinationConfig.repoId !== plan.destinationRepoId
    || sourceConfig.repoId === destinationConfig.repoId) {
    throw new Error("Re-encryption source/destination plan or repository identity is invalid.")
  }
  if (sourceConfig.mode !== "encrypted" || destinationConfig.mode !== "encrypted"
    || sourceConfig.pathLayout !== "opaque-stable-v1" || destinationConfig.pathLayout !== "opaque-stable-v1"
    || sourceConfig.algorithm !== "AES-GCM" || destinationConfig.algorithm !== "AES-GCM"
    || sourceConfig.kdf !== "PBKDF2-SHA-256" || destinationConfig.kdf !== "PBKDF2-SHA-256"
    || !sourceConfig.kdfParams || !destinationConfig.kdfParams) {
    throw new Error("Re-encryption source and destination require distinct encrypted V4 KDF configurations.")
  }
  assertV4Pbkdf2Iterations(destinationConfig.kdfParams.iterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
  if (sourceConfig.kdfParams.salt === destinationConfig.kdfParams.salt) {
    throw new Error("Re-encryption destination requires fresh KDF salt.")
  }
  if (isSameKey(input.sourceKeyring.contentKey, input.destinationKeyring.contentKey)
    || isSameKey(input.sourceKeyring.pathKey, input.destinationKeyring.pathKey)) {
    throw new Error("Re-encryption destination keyring must differ from the source keyring.")
  }
  if (sourceRecord.deleted || sourceRecord.dirty) {
    throw new Error("Re-encryption cannot transcode a tombstone or dirty source record.")
  }
  const version = input.targetVersion ?? "rekey-v1"
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(version)) {
    throw new Error("Invalid re-encryption destination object version.")
  }
  // Writer chooses chunking using ciphertext size, not plaintext size.
  // New object payloads must never exceed the fixed 8 MiB REST-safe cap.
  const singleLimit = maxV4NewWriterPlaintextBytes("encrypted")
  await assertV4RemoteRecordSet([sourceRecord], sourceConfig, input.sourceKeyring)
  throwIfV4Aborted(input.signal)
  await input.verifySourceStillPinned()
  throwIfV4Aborted(input.signal)
  const oldCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: input.sourceKeyring, signal: input.signal,
  })
  const newCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: input.destinationKeyring, signal: input.signal,
  })
  const oldReader = async (path: string): Promise<Uint8Array> => {
    throwIfV4Aborted(input.signal)
    const bytes = await input.readSourceObject(path, plan.pinnedSourceCommitSha)
    throwIfV4Aborted(input.signal)
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("Re-encryption source object missing or invalid.")
    }
    return bytes
  }
  const source: V4ContentSource = {
    size: sourceRecord.size,
    async *chunks(chunkBytes: number, signal?: AbortSignal) {
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
        throw new Error("Re-encryption source chunk size must be positive.")
      }
      const check = () => {
        throwIfV4Aborted(signal)
        throwIfV4Aborted(input.signal)
      }
      const emitPieces = async function* (plaintext: Uint8Array) {
        for (let start = 0; start < plaintext.length; start += chunkBytes) {
          check()
          yield plaintext.subarray(start, Math.min(start + chunkBytes, plaintext.length))
        }
      }
      if (sourceRecord.storage === "chunked") {
        const paths = sourceRecord.partPaths
        if (!paths?.length) throw new Error("Re-encryption source multipart record lacks parts.")
        for (let i = 0; i < paths.length; i++) {
          check()
          await input.verifySourceStillPinned()
          const ciphertext = await oldReader(paths[i]!)
          let plaintext: Uint8Array
          try {
            plaintext = await decryptV4Payload(input.sourceKeyring.contentKey, ciphertext, {
              kind: "part", aad: `${sourceRecord.fileId}:${sourceRecord.remoteVersion}:${i}`,
            })
          } catch (cause) {
            throw new Error("Re-encryption source part authentication/integrity failed.", { cause })
          }
          try { yield* emitPieces(plaintext) }
          finally { plaintext.fill(0) }
        }
      } else {
        check()
        await input.verifySourceStillPinned()
        let plaintext: Uint8Array
        try {
          plaintext = await oldCodec.read(sourceRecord, oldReader, signal)
        } catch (cause) {
          throw new Error("Re-encryption source content authentication/integrity failed.", { cause })
        }
        try { yield* emitPieces(plaintext) }
        finally { plaintext.fill(0) }
      }
      check()
      await input.verifySourceStillPinned()
    },
  }
  // Regenerate opaque identity; the source fileId is NOT copied into the
  // destination encrypted index. Source pack content becomes new independent
  // single/chunked objects, never a reference to an old packed blob.
  const newFileId = toBase64Url(randomBytes(24))
  const prepared = await newCodec.prepareFromSource({
    logicalPath: sourceRecord.path,
    source,
    expectedHash: sourceRecord.plaintextSha256,
    version,
    mtime: sourceRecord.mtime,
    fileId: newFileId,
    partBytes: singleLimit,
    checkSourceStable: input.verifySourceStillPinned,
  })
  // Caller MUST stream every object and successfully finalize BEFORE staging
  // any index/head/ref publication. This is a preparation API, not a publisher.
  return prepared
}
