import { utf8ToBytes } from "../bytes"
import { createV4IncrementalSha256 } from "./incremental-hash"
import type { V4IndexFileRecord } from "./local-index"
import type { V4PreparedOrphanCommit } from "./reencryption-orphan-publication"
import type { V4RemoteConfig } from "./protocol-types"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"

export interface V4ReencryptionCandidateManifestInput {
  readonly prepared: V4PreparedOrphanCommit
  readonly sourceTreeSha: string
  readonly destinationConfig: V4RemoteConfig
  readonly expectedRecords: readonly V4IndexFileRecord[]
  readonly expectedReceipts: readonly V4ReencryptionObjectReceipt[]
}

/** Stable key order across JSON parsing/restarts. No plaintext note contents,
 * passphrases or keyring material are serialized or written to disk. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const data = value as Record<string, unknown>
    return `{${Object.keys(data).filter(key => data[key] !== undefined)
      .sort().map(key => `${JSON.stringify(key)}:${canonical(data[key])}`).join(",")}}`
  }
  throw new Error("Re-encryption manifest fingerprint contains an unsupported value.")
}

/**
 * D110: domain-separated deterministic SHA-256 of the exact recovery
 * candidate + public encryption config + all planned metadata/objects.
 * Streams record-by-record rather than allocating a serialized whole vault.
 * The DIGEST is stored inside the already AES-GCM encrypted WAL payload.
 *
 * It is run-local consistency evidence, NOT an authentication key,
 * replacement for the remote full-content crypto verifier, or cutover token.
 */
export function computeV4ReencryptionCandidateManifestDigest(
  input: V4ReencryptionCandidateManifestInput,
): string {
  if (!input || !input.prepared || !input.destinationConfig
    || !Array.isArray(input.expectedRecords) || !Array.isArray(input.expectedReceipts)
    || input.prepared.verifiedFileCount !== input.expectedRecords.length
    || input.prepared.stagedCiphertextObjectCount !== input.expectedReceipts.length
    || input.prepared.sourceTreeSha !== input.sourceTreeSha
    || input.prepared.destinationRepoId !== input.destinationConfig.repoId) {
    throw new Error("Re-encryption candidate manifest fingerprint inputs disagree.")
  }
  const sha = createV4IncrementalSha256()
  const feed = (value: unknown) => {
    const bytes = utf8ToBytes(canonical(value))
    sha.update(utf8ToBytes(`${bytes.byteLength}:`))
    sha.update(bytes)
  }
  sha.update(utf8ToBytes("v4-reencryption-candidate-manifest-v1\0"))
  feed(input.prepared)
  feed(input.sourceTreeSha)
  feed(input.destinationConfig)
  const records = [...input.expectedRecords].sort((a, b) =>
    a.pathId.localeCompare(b.pathId) || a.path.localeCompare(b.path))
  const receipts = [...input.expectedReceipts].sort((a, b) => a.path.localeCompare(b.path))
  feed(records.length)
  for (const record of records) feed(record)
  feed(receipts.length)
  for (const receipt of receipts) feed(receipt)
  return sha.digestHex()
}
