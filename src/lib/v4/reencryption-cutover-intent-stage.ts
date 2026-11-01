import type { V4LocalIndexAdapter } from "./local-index"
import {
  inspectV4ReencryptionCutoverCandidatePair,
} from "./reencryption-cutover-candidate-crypto"
import {
  decodeV4ReencryptionCutoverCandidateManifest,
} from "./reencryption-cutover-candidate-manifest"
import {
  inspectV4ReencryptionPendingCutoverIntent,
  sealV4ReencryptionPendingCutoverIntent,
} from "./reencryption-cutover-intent-crypto"
import type { V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import type { V4ReencryptionCutoverCandidateStageReport } from "./reencryption-cutover-candidate-stage"
import { fitsV4LocalJsonSizeLimit } from "./local-index"

const MAX_CIPHERTEXT = 8 * 1024

export interface V4ReencryptionCutoverIntentStageReport {
  readonly status: "production-namespace-intent-staged-uncommitted"
  readonly intentPath: string
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

/**
 * Called ONLY while D224 holds its single fenced WAL lease and repeats full
 * independent old/new Git proofs around these writes. This helper checks
 * bytes, not provenance, and never selects a live runtime or clears a key.
 */
export async function stageV4ReencryptionPendingCutoverIntent(input: {
  readonly adapter: V4LocalIndexAdapter
  readonly candidate: V4ReencryptionCutoverCandidateStageReport
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly journalKey: Uint8Array
  readonly assertHeld: () => Promise<void>
}): Promise<V4ReencryptionCutoverIntentStageReport> {
  const { adapter, candidate, contract, journalKey, assertHeld } = input
  if (!adapter || !candidate || typeof adapter.read !== "function"
    || typeof adapter.write !== "function" || typeof adapter.exists !== "function"
    || typeof assertHeld !== "function"
    || candidate.status !== "production-namespace-pair-staged-uncommitted") {
    throw Error("D227 intent requires a fenced authenticated Candidate.")
  }
  const root = contract.identity.indexRoot + "-rekey-cutover-candidate-" + contract.identity.runId
  const paths = [root + "/contract.json", root + "/receipt.json", root + "/selector.json"] as const
  if (candidate.manifestPath !== paths[0] || candidate.receiptPath !== paths[1]
    || candidate.selectorPath !== paths[2]) {
    throw Error("D227 Candidate storage root mismatch.")
  }
  const intentPath = root + "/intent.json"
  const initial = JSON.stringify(contract)
  const initialKey = journalKey.slice()
  const methods = { read: adapter.read, write: adapter.write, exists: adapter.exists }
  const unchanged = () => input.adapter === adapter && input.candidate === candidate
    && input.contract === contract && input.journalKey === journalKey
    && input.assertHeld === assertHeld
    && JSON.stringify(contract) === initial
    && journalKey.every((v, i) => v === initialKey[i])
    && adapter.read === methods.read && adapter.write === methods.write
    && adapter.exists === methods.exists
  const check = async () => {
    if (!unchanged()) throw Error("D227 intent dependencies changed.")
    await assertHeld()
    if (!unchanged()) throw Error("D227 intent lease or contract changed.")
  }
  try {
    await check()
    if (!await methods.exists.call(adapter, root)
      || await methods.exists.call(adapter, intentPath)) {
      throw Error("D227 missing Candidate or pre-existing intent requires Manual Recovery.")
    }
    const readCandidate = async () => {
      const [manifest, receiptCiphertext, selectorCiphertext] = await Promise.all([
        methods.read.call(adapter, paths[0]),
        methods.read.call(adapter, paths[1]),
        methods.read.call(adapter, paths[2]),
      ])
      if (!fitsV4LocalJsonSizeLimit(manifest, MAX_CIPHERTEXT)
        || !fitsV4LocalJsonSizeLimit(receiptCiphertext, MAX_CIPHERTEXT)
        || !fitsV4LocalJsonSizeLimit(selectorCiphertext, MAX_CIPHERTEXT)
        || JSON.stringify(decodeV4ReencryptionCutoverCandidateManifest(manifest)) !== initial
        || (await inspectV4ReencryptionCutoverCandidatePair(
          contract, journalKey, { receiptCiphertext, selectorCiphertext },
        )).observation !== "cryptographically-linked-candidate-uncommitted") {
        throw Error("D227 Candidate ciphertext or manifest failed authentication.")
      }
      return { manifest, receiptCiphertext, selectorCiphertext }
    }
    const original = await readCandidate()
    const ciphertext = await sealV4ReencryptionPendingCutoverIntent(
      contract, journalKey, original,
    )
    await check()
    if (await methods.exists.call(adapter, intentPath)
      || JSON.stringify(await readCandidate()) !== JSON.stringify(original)) {
      throw Error("D227 competing writer or Candidate drift before intent.")
    }
    await methods.write.call(adapter, intentPath, ciphertext)
    await check()
    if (await methods.read.call(adapter, intentPath) !== ciphertext
      || (await inspectV4ReencryptionPendingCutoverIntent(
        contract, journalKey, original, ciphertext,
      )).observation !== "authenticated-intent-uncommitted"
      || JSON.stringify(await readCandidate()) !== JSON.stringify(original)) {
      throw Error("D227 intent or Candidate changed after write.")
    }
    await check()
    return Object.freeze({
      status: "production-namespace-intent-staged-uncommitted",
      intentPath, evidence: "best-effort-wal-readback-not-power-loss-durable",
      localCutoverAuthorized: false, resumeSyncAuthorized: false,
      rollbackAuthorized: false, remoteWritesAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
    })
  } finally { initialKey.fill(0) }
}
