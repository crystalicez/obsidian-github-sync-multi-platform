/**
 * D377 disposable installed-Obsidian authoring probe.
 * Injected only into a verified temporary Vault; never part of released main.js.
 * No actual GitHub receipt is asserted: the WAL deliberately retains a
 * pending ref intent, which must stay recovery-fenced after process restart.
 */
import { sha256Hex, utf8ToBytes } from "../src/lib/bytes"
import type { V4LocalIndexAdapter } from "../src/lib/v4/local-index"
import { createV4ReencryptionRecoveryJournal } from "../src/lib/v4/reencryption-recovery-journal"
import { verifyV4ReencryptionInitiatorLocalParity, type V4InitiatorLocalReader } from "../src/lib/v4/reencryption-initiator-parity"
import type { V4GitHubForkSourceParityInventory } from "../src/lib/v4/reencryption-trusted-loader"
import { planV4PluginPrivateWalLocation } from "../src/lib/v4/reencryption-plugin-wal-location"

export const RUN_ID = "D377InstalledWalProof"
const SOURCE_COMMIT = "a".repeat(40)
const SOURCE_TREE = "b".repeat(40)
const SOURCE = "synthetic/repo#source"
const BACKUP = "synthetic/repo#backup"
const DESTINATION = "synthetic/repo#destination"
const SECRET_BYTE = 0x68

type WalAdapter = Pick<V4LocalIndexAdapter, "read" | "exists" | "write" | "mkdir">

function key() { return new Uint8Array(32).fill(SECRET_BYTE) }
function assertSafe(ok: unknown): asserts ok {
  if (!ok) throw Error("D377 installed WAL test-only proof refused.")
}

const slotPaths = (root: string) => [root + "/slot-0.json", root + "/slot-1.json"]
async function hashes(adapter: Pick<WalAdapter, "read">, root: string) {
  return Promise.all(slotPaths(root).map(async file =>
    sha256Hex(utf8ToBytes(await adapter.read(file)))))
}

/** D389 test-only independent physical read. Never use the revoked lease to
 * bypass a production write guard; the genuine Obsidian DataAdapter reads only. */
export async function assertPhysicalWalHashesUnchanged(
  adapter: Pick<WalAdapter, "read">, journalRoot: string,
  expected: readonly string[],
): Promise<boolean> {
  assertSafe(expected.length === 2 && expected.every(sha => /^[a-f0-9]{64}$/u.test(sha)))
  const actual = await hashes(adapter, journalRoot)
  return actual.every((sha, index) => sha === expected[index])
}

/**
 * D390 installed synthetic Source/physical Vault parity. The source record,
 * hash and pinned Source SHA below are test fixtures only: they have NOT been
 * authenticated against GitHub. The reader MUST come from the actual installed
 * plugin runtime, with its live lease, editor, Source and Sync guards.
 */
export async function verifySyntheticInstalledSourceParity(
  reader: V4InitiatorLocalReader, noteText: string,
) {
  const bytes = utf8ToBytes(noteText)
  const report = await verifyV4ReencryptionInitiatorLocalParity({
    pinnedSourceCommitSha: SOURCE_COMMIT,
    verifiedSource: {
      integrityScope: "all-live-objects",
      pinnedSourceCommitSha: SOURCE_COMMIT,
      verifiedFileCount: 1,
      verifiedRemoteObjectCount: 1,
      totalVerifiedPlaintextBytes: String(bytes.byteLength),
    },
    sourceRecords: [{
      path: "D377-synthetic-note.md",
      plaintextSha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      deleted: false,
    }],
    reader,
  })
  assertSafe(report.integrityScope === "initiator-live-vault-exact-pinned-source-parity"
    && report.checkedFileCount === 1
    && report.checkedPlaintextBytes === String(bytes.byteLength)
    && report.initiatorLocalCutoverAuthorized === false)
  return {
    syntheticSourceParityVerified: true,
    physicalFilesVerified: report.checkedFileCount,
    physicalBytesVerified: report.checkedPlaintextBytes,
    sourceCommitSha: report.pinnedSourceCommitSha,
    remoteGitHubSourceAuthenticated: false,
    cutoverAuthorized: false,
  }
}

/**
 * D391: The disposable GitHub E2E parent independently authenticates the
 * exact immutable-commit inventory before handing it to the installed client.
 * The installed client only consumes the token-free fixture, using the real
 * production two-pass physical parity engine with its runtime-owned reader.
 * A JSON input by itself is NOT trustworthy remote provenance outside this
 * strictly controlled test pipeline.
 */
export async function verifyTransferredAuthenticatedSourceParity(
  reader: V4InitiatorLocalReader,
  inventory: V4GitHubForkSourceParityInventory,
) {
  assertSafe(inventory.verifiedSource.integrityScope === "all-live-objects"
    && inventory.verifiedSource.pinnedSourceCommitSha === inventory.pinnedSourceCommitSha
    && inventory.sourceRecords.length === inventory.verifiedSource.verifiedFileCount
    && inventory.initiatorLocalParityVerified === false
    && inventory.permissionToPublish === false
    && inventory.cutoverAuthorized === false)
  const report = await verifyV4ReencryptionInitiatorLocalParity({
    pinnedSourceCommitSha: inventory.pinnedSourceCommitSha,
    verifiedSource: inventory.verifiedSource,
    sourceRecords: inventory.sourceRecords,
    reader,
  })
  assertSafe(report.integrityScope === "initiator-live-vault-exact-pinned-source-parity"
    && report.pinnedSourceCommitSha === inventory.pinnedSourceCommitSha
    && report.checkedFileCount === inventory.verifiedSource.verifiedFileCount
    && report.checkedPlaintextBytes === inventory.verifiedSource.totalVerifiedPlaintextBytes
    && report.initiatorLocalCutoverAuthorized === false)
  return {
    transferredGitHubInventoryParityVerified: true,
    checkedFileCount: report.checkedFileCount,
    checkedPlaintextBytes: report.checkedPlaintextBytes,
    checkedSourceCommitSha: report.pinnedSourceCommitSha,
    permissionToPublish: false,
    cutoverAuthorized: false,
  }
}

export interface TestOnlyWalSourceBinding {
  readonly sourceCommitSha: string
  readonly sourceTreeSha: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
}

function requireTestOnlyBinding(binding?: TestOnlyWalSourceBinding) {
  const record = binding ?? {
    sourceCommitSha: SOURCE_COMMIT, sourceTreeSha: SOURCE_TREE,
    backupRepoId: BACKUP, destinationRepoId: DESTINATION,
  }
  assertSafe(/^[0-9a-f]{40}$/u.test(record.sourceCommitSha)
    && /^[0-9a-f]{40}$/u.test(record.sourceTreeSha)
    && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+#[^#]+$/u.test(record.backupRepoId)
    && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+#[^#]+$/u.test(record.destinationRepoId)
    && record.backupRepoId !== record.destinationRepoId)
  return record
}

export async function authorUnpublishedPendingBackup(
  adapter: WalAdapter, journalRoot: string, binding?: TestOnlyWalSourceBinding,
) {
  const secret = key()
  try {
    const selected = requireTestOnlyBinding(binding)
    const journal = createV4ReencryptionRecoveryJournal({
      adapter, root: journalRoot, runId: RUN_ID,
      sourceCommitSha: selected.sourceCommitSha,
      destinationRepoId: selected.destinationRepoId,
      journalKey: secret,
    })
    const started = await journal.begin()
    const pending = await journal.recordRefIntent({
      role: "backup",
      repoId: selected.backupRepoId,
      commitSha: selected.sourceCommitSha,
      treeSha: selected.sourceTreeSha,
    }, started.generation)
    assertSafe(pending.generation === started.generation + 1
      && pending.pendingRefIntents.length === 1
      && pending.verifiedRefObservations.length === 0
      && pending.permissionToPublish === false
      && pending.cutoverAuthorized === false)
    assertSafe((await journal.assertHealthySnapshot(pending.generation)).generation
      === pending.generation)
    return {
      generation: pending.generation,
      ciphertextSlotSha256: await hashes(adapter, journalRoot),
      pendingBackupIntentOnly: true,
      noGitHubUsed: true,
      noCutover: true,
    }
  } finally { secret.fill(0) }
}

export interface D397ParentVerifiedBackup {
  readonly repoId: string
  readonly pinnedSourceCommitSha: string
  readonly pinnedSourceTreeSha: string
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly backupContentsReadbackVerified: true
  readonly creationProven: false
  readonly cutoverAuthorized: false
}

/**
 * D397 test-only integration: the parent E2E has independently decrypted a
 * real disposable GitHub frozen Backup. This native child does NOT authenticate
 * GitHub itself and must never use this external attestation in production.
 * Only the installed Vault adapter, after physical Source parity under the
 * same live lease, advances its actual encrypted WAL to Staging handoff.
 */
export async function authorParentVerifiedBackupHandoff(
  adapter: WalAdapter, journalRoot: string,
  binding: TestOnlyWalSourceBinding, verified: D397ParentVerifiedBackup,
) {
  const selected = requireTestOnlyBinding(binding)
  assertSafe(verified.backupContentsReadbackVerified === true
    && verified.creationProven === false
    && verified.cutoverAuthorized === false
    && verified.repoId === selected.backupRepoId
    && verified.pinnedSourceCommitSha === selected.sourceCommitSha
    && verified.pinnedSourceTreeSha === selected.sourceTreeSha
    && verified.verifiedFileCount === 1
    && /^[1-9][0-9]*$/u.test(verified.verifiedPlaintextBytes))
  const secret = key()
  try {
    const journal = createV4ReencryptionRecoveryJournal({
      adapter, root: journalRoot, runId: RUN_ID,
      sourceCommitSha: selected.sourceCommitSha,
      destinationRepoId: selected.destinationRepoId,
      journalKey: secret,
    })
    const started = await journal.begin()
    const ref = {
      role: "backup" as const,
      repoId: selected.backupRepoId,
      commitSha: selected.sourceCommitSha,
      treeSha: selected.sourceTreeSha,
    }
    const pending = await journal.recordRefIntent(ref, started.generation)
    const verifiedRef = await journal.markRefReadbackObserved(ref, pending.generation)
    const handoff = await journal.recordStagingHandoff(ref, verifiedRef.generation)
    const current = await journal.assertHealthySnapshot(handoff.generation)
    assertSafe(current.generation === 4
      && current.pendingRefIntents.length === 0
      && current.verifiedRefObservations.length === 1
      && current.verifiedRefObservations[0]?.repoId === ref.repoId
      && current.stageHandoffStarted === true
      && current.receipts.length === 0
      && current.pendingIntents.length === 0
      && current.permissionToPublish === false
      && current.cutoverAuthorized === false)
    return {
      generation: current.generation,
      ciphertextSlotSha256: await hashes(adapter, journalRoot),
      verifiedBackupHandoff: true,
      pendingBackupIntentOnly: false,
      noGitHubUsed: true,
      noCutover: true,
    }
  } finally { secret.fill(0) }
}

export async function inspectAfterRealProcessRestart(
  adapter: Pick<WalAdapter, "read" | "exists">,
  pluginId: string,
  expectedHashes: readonly string[],
  expectedGeneration: number,
  binding?: TestOnlyWalSourceBinding,
) {
  const selected = requireTestOnlyBinding(binding)
  assertSafe(expectedHashes.length === 2
    && expectedHashes.every(value => /^[a-f0-9]{64}$/u.test(value))
    && Number.isSafeInteger(expectedGeneration) && (expectedGeneration === 2 || expectedGeneration === 4))
  const layout = await planV4PluginPrivateWalLocation({
    configDir: ".obsidian", pluginId, runId: RUN_ID,
  })
  const root = layout.vaultLogicalWalRoot
  const before = await hashes(adapter, root)
  assertSafe(before.every((sha, i) => sha === expectedHashes[i]))
  const secret = key()
  try {
    const readOnly: V4LocalIndexAdapter = {
      read: path => adapter.read(path),
      exists: path => adapter.exists(path),
      async write() { throw Error("D377 read-only WAL: write forbidden") },
      async mkdir() { throw Error("D377 read-only WAL: mkdir forbidden") },
    }
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: readOnly, root, runId: RUN_ID,
      sourceCommitSha: selected.sourceCommitSha,
      destinationRepoId: selected.destinationRepoId,
      journalKey: secret,
    })
    const pending = await journal.assertHealthySnapshot(expectedGeneration)
    const backupRef = expectedGeneration === 4
      ? pending.verifiedRefObservations[0] : pending.pendingRefIntents[0]
    assertSafe(pending.generation === expectedGeneration
      && pending.pendingRefIntents.length === (expectedGeneration === 4 ? 0 : 1)
      && pending.verifiedRefObservations.length === (expectedGeneration === 4 ? 1 : 0)
      && pending.stageHandoffStarted === (expectedGeneration === 4)
      && backupRef?.repoId === selected.backupRepoId
      && backupRef.commitSha === selected.sourceCommitSha
      && backupRef.treeSha === selected.sourceTreeSha
      && pending.receipts.length === 0
      && pending.pendingIntents.length === 0
      && pending.requiresRemoteRevalidation === true
      && pending.permissionToPublish === false
      && pending.cutoverAuthorized === false)
    const after = await hashes(adapter, root)
    assertSafe(after.every((sha, i) => sha === expectedHashes[i]))
    return {
      authenticated: true,
      WALUnchanged: true,
      pendingRefRequiresManualRevalidation: expectedGeneration === 2,
      verifiedBackupHandoffSurvived: expectedGeneration === 4,
      remoteWritesAuthorized: false,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      noGitHubUsed: true,
      physicalPowerLossProven: false,
    }
  } finally { secret.fill(0) }
}
