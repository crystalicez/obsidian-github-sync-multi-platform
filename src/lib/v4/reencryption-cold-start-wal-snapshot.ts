import { sha256Hex, utf8ToBytes } from "../bytes"
import type { V4LocalIndexAdapter } from "./local-index"
import { createV4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"
import { matchesV4ReencryptionPreparedWal } from "./reencryption-proposed-commit-receipt"

const MAX_SLOT_TEXT = 2 * 1024 * 1024

/** The WAL's physical location is supplied explicitly by a trusted owner. */
export interface V4ColdStartWalSnapshotInput {
  readonly adapter: Pick<V4LocalIndexAdapter, "exists" | "read">
  readonly root: string
  readonly contract: V4ReencryptionCutoverSnapshotContract
  /** Already recovered from the original pinned Backup, not from Destination. */
  readonly originalJournalKey: Uint8Array
  /** Validates the current plugin/vault owner at every awaited boundary. */
  readonly assertLiveOwner: () => void
}

export interface V4ColdStartWalSnapshotReport {
  readonly integrityScope: "read-only-encrypted-wal-and-exact-cutover-contract"
  readonly observation: "authenticated-current-wal-still-fenced" | "manual-recovery-required"
  readonly walSnapshotAuthenticated: boolean
  readonly walMatchesCutoverContract: boolean
  readonly bestEffortReadbackOnly: true
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const BASE = Object.freeze({
  integrityScope: "read-only-encrypted-wal-and-exact-cutover-contract" as const,
  bestEffortReadbackOnly: true as const,
  commitDecisionAuthorized: false as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ColdStartWalSnapshotReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  walSnapshotAuthenticated: false, walMatchesCutoverContract: false,
})
const OBSERVED: V4ColdStartWalSnapshotReport = Object.freeze({
  ...BASE, observation: "authenticated-current-wal-still-fenced",
  walSnapshotAuthenticated: true, walMatchesCutoverContract: true,
})

/**
 * Inspect an existing encrypted two-slot WAL with a freshly reconstructed
 * journal instance. The only adapter operations exposed to the decoder are
 * read and exists. This does not acquire an OS lease or grant write authority.
 */
export async function inspectV4ColdStartWalSnapshot(
  input: V4ColdStartWalSnapshotInput,
): Promise<V4ColdStartWalSnapshotReport> {
  let key: Uint8Array | undefined
  let originalKey: Uint8Array | undefined
  try {
    const { adapter, root, contract, originalJournalKey, assertLiveOwner } = input
    if (!adapter || typeof adapter.exists !== "function" || typeof adapter.read !== "function"
      || typeof assertLiveOwner !== "function"
      || !(originalJournalKey instanceof Uint8Array)
      || originalJournalKey.length !== 32) return MANUAL
    assertV4ReencryptionCutoverSnapshotContract(contract)
    const contractText = JSON.stringify(contract)
    const read = adapter.read
    const exists = adapter.exists
    key = Uint8Array.from(originalJournalKey)
    const expectedKey = Uint8Array.from(originalJournalKey)
    originalKey = expectedKey
    const check = () => {
      assertLiveOwner()
      if (input.adapter !== adapter || input.root !== root || input.contract !== contract
        || input.originalJournalKey !== originalJournalKey
        || input.assertLiveOwner !== assertLiveOwner
        || adapter.read !== read || adapter.exists !== exists
        || JSON.stringify(contract) !== contractText
        || originalJournalKey.some((byte, i) => byte !== expectedKey[i])) {
        throw Error("D237 cold-start WAL reader, key or contract changed.")
      }
    }
    const safeRead = async (path: string): Promise<string> => {
      check()
      const value = await read.call(adapter, path)
      check()
      if (typeof value !== "string" || value.length > MAX_SLOT_TEXT) {
        throw Error("D237 WAL slot is malformed or oversized.")
      }
      return value
    }
    const safeExists = async (path: string): Promise<boolean> => {
      check()
      const value = await exists.call(adapter, path)
      check()
      if (typeof value !== "boolean") throw Error("D237 invalid WAL existence result.")
      return value
    }
    const readonlyAdapter: V4LocalIndexAdapter = {
      exists: safeExists,
      read: safeRead,
      async write() { throw Error("D237 inspection cannot write WAL.") },
      async mkdir() { throw Error("D237 inspection cannot create WAL directories.") },
    }
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: readonlyAdapter, root, runId: contract.identity.runId,
      sourceCommitSha: contract.identity.sourceCommitSha,
      destinationRepoId: contract.identity.destinationRepoId, journalKey: key,
    })
    const paths = [root + "/slot-0.json", root + "/slot-1.json"]
    const capture = async () => {
      const values: Array<string | null> = []
      for (const path of paths) {
        values.push(await safeExists(path) ? await safeRead(path) : null)
      }
      return values
    }
    const before = await capture()
    check()
    const first = await journal.assertHealthySnapshot(contract.identity.walGeneration)
    check()
    if (!matchesV4ReencryptionPreparedWal(first, contract.identity)
      || await sha256Hex(utf8ToBytes(JSON.stringify(first))) !== contract.walSnapshotSha256) {
      return MANUAL
    }
    const second = await journal.assertHealthySnapshot(contract.identity.walGeneration)
    check()
    if (JSON.stringify(first) !== JSON.stringify(second)
      || !matchesV4ReencryptionPreparedWal(second, contract.identity)
      || await sha256Hex(utf8ToBytes(JSON.stringify(second))) !== contract.walSnapshotSha256
      || JSON.stringify(await capture()) !== JSON.stringify(before)) return MANUAL
    check()
    return OBSERVED
  } catch {
    return MANUAL
  } finally {
    key?.fill(0)
    originalKey?.fill(0)
  }
}
