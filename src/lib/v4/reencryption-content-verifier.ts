import { throwIfV4Aborted } from "./cancellation"
import type { V4Keyring } from "./crypto"
import type { V4IndexFileRecord } from "./local-index"
import { inspectV4ReencryptionInventory, type V4ReencryptionInventoryInput } from "./reencryption-inventory"
import { V4StorageCodec } from "./storage-codec"
import type { V4StagedSink } from "./staging-store"

/**
 * Read-only content-verification step for a planned Re-encryption Wizard.
 *
 * The transport and head observer MUST be trustworthy and MUST fetch from the
 * exact immutable source commit; never pass a branch-ref reader here.
 * This module cannot publish, rotate keys, or write local vault content.
 */
export interface V4ReencryptionSourceVerificationInput extends V4ReencryptionInventoryInput {
  readonly keyring: V4Keyring
  /** Default preserves legacy fail-closed behavior. The fork mode reads
   * ONLY immutable Git objects at a SHA pinned from an authenticated ref.
   * A later old-branch HEAD advance is not corruption of that snapshot. */
  readonly sourceRefPolicy?: "require-stable-head" | "pinned-immutable-commit" | undefined
  readonly readCurrentSourceHeadSha: () => Promise<string | null>
  readonly readPinnedObject: (path: string, exactCommitSha: string) => Promise<Uint8Array | null>
  readonly signal?: AbortSignal | undefined
}

export interface V4ReencryptionVerifiedSource {
  readonly integrityScope: "all-live-objects"
  readonly pinnedSourceCommitSha: string
  readonly verifiedFileCount: number
  readonly verifiedRemoteObjectCount: number
  readonly totalVerifiedPlaintextBytes: string
}

function assertUnchangedHead(observed: string | null, pinned: string): void {
  if (observed === null || !/^[0-9a-f]{40}$/u.test(observed) || observed !== pinned) {
    throw new Error("Re-encryption source HEAD changed or cannot be verified against pinned source commit.")
  }
}

function pathsOf(record: V4IndexFileRecord): readonly string[] {
  return record.storage === "chunked" ? record.partPaths ?? [] : [record.remotePath]
}

export async function verifyV4ReencryptionSourceObjects(
  input: V4ReencryptionSourceVerificationInput,
): Promise<V4ReencryptionVerifiedSource> {
  throwIfV4Aborted(input.signal)
  // Authorize no object I/O unless all source buckets and per-record HMAC
  // coordinates agree with the authenticated, pinned metadata snapshot.
  const inventory = await inspectV4ReencryptionInventory(input)
  throwIfV4Aborted(input.signal)
  if (input.sourceRefPolicy !== undefined
    && input.sourceRefPolicy !== "require-stable-head"
    && input.sourceRefPolicy !== "pinned-immutable-commit") {
    throw new Error("Invalid re-encryption source ref policy.")
  }
  const requireStableHead = input.sourceRefPolicy !== "pinned-immutable-commit"
  if (requireStableHead) {
    assertUnchangedHead(await input.readCurrentSourceHeadSha(), input.pinnedSourceCommitSha)
  }

  const codec = new V4StorageCodec({
    mode: "encrypted",
    pathLayout: "opaque-stable-v1",
    keyring: input.keyring,
    signal: input.signal,
  })

  // Use the existing production decoding and incremental hash verification,
  // but discard plaintext after each append. No durable stage or vault write.
  const discardSink: V4StagedSink = {
    async append(_bytes: Uint8Array) {},
    async finish() { throw new Error("Read-only verification cannot finish a staged sink.") },
    async abort() {},
  }
  const verifiedObjectPaths = new Set<string>()
  let verifiedFileCount = 0
  let verifiedPlaintextBytes = BigInt(0)
  for (const shard of Object.values(input.shards)) {
    for (const record of Object.values(shard.records)) {
      if (record.deleted) continue
      throwIfV4Aborted(input.signal)
      let verified: { plaintextSha256: string; size: number }
      try {
        verified = await codec.readToSink({
          record,
          sink: discardSink,
          signal: input.signal,
          reader: async path => {
            throwIfV4Aborted(input.signal)
            const bytes = await input.readPinnedObject(path, input.pinnedSourceCommitSha)
            throwIfV4Aborted(input.signal)
            if (!(bytes instanceof Uint8Array)) throw new Error("Re-encryption source encrypted object is missing or invalid.")
            return bytes
          },
        })
      } catch (error) {
        // AES-GCM can reject with platform-dependent OperationError messages.
        // Do not expose logical paths or ciphertext identifiers in UI errors.
        throwIfV4Aborted(input.signal)
        throw new Error("Re-encryption source object integrity or availability verification failed.", { cause: error })
      }
      if (verified.plaintextSha256 !== record.plaintextSha256 || verified.size !== record.size) {
        throw new Error("Re-encryption source plaintext integrity mismatch.")
      }
      verifiedFileCount++
      verifiedPlaintextBytes += BigInt(verified.size)
      for (const path of pathsOf(record)) verifiedObjectPaths.add(path)
    }
  }
  throwIfV4Aborted(input.signal)
  if (requireStableHead) {
    assertUnchangedHead(await input.readCurrentSourceHeadSha(), input.pinnedSourceCommitSha)
  }
  if (verifiedFileCount !== inventory.fileCount
    || verifiedPlaintextBytes.toString() !== inventory.totalLogicalBytes
    || verifiedObjectPaths.size !== inventory.distinctRemoteObjectCount) {
    throw new Error("Re-encryption source verification counters differ from the authenticated inventory.")
  }
  return Object.freeze({
    integrityScope: "all-live-objects",
    pinnedSourceCommitSha: input.pinnedSourceCommitSha,
    verifiedFileCount,
    verifiedRemoteObjectCount: verifiedObjectPaths.size,
    totalVerifiedPlaintextBytes: verifiedPlaintextBytes.toString(),
  })
}
