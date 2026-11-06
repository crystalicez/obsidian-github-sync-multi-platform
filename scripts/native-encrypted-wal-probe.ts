/**
 * Test-only browser bundle injected exclusively into a verified disposable
 * Windows Obsidian Vault. Uses the real V4 WAL journal and D237 cryptographic
 * inspector, but does NOT invoke installed Complete Recovery, GitHub or Cutover.
 * Never bundle this file into the released plugin.
 */
import { sha256Hex, utf8ToBytes } from "../src/lib/bytes"
import type { V4LocalIndexAdapter } from "../src/lib/v4/local-index"
import { inspectV4ColdStartWalSnapshot } from "../src/lib/v4/reencryption-cold-start-wal-snapshot"
import type { V4ReencryptionCutoverSnapshotContract } from "../src/lib/v4/reencryption-cutover-snapshot-contract"
import { createV4ReencryptionRecoveryJournal } from "../src/lib/v4/reencryption-recovery-journal"
import { planV4PluginPrivateWalLocation } from "../src/lib/v4/reencryption-plugin-wal-location"

const RUN_ID = "D287NativeWalEvidence"
const SOURCE_COMMIT = "a".repeat(40)
const SOURCE_TREE = "b".repeat(40)
const DEST_COMMIT = "c".repeat(40)
const DEST_TREE = "d".repeat(40)
const MANIFEST_SHA = "e".repeat(64)
const SOURCE_REPO = "synthetic/repo#main"
const BACKUP_REPO = "synthetic/repo#backup"
const DEST_REPO = "synthetic/repo#destination"
const KEY_BYTE = 0x47
const SOURCE_INDEX_ROOT = "github-sync-v4-index"

type NativeAdapter = Pick<V4LocalIndexAdapter, "read" | "exists" | "write" | "mkdir">

function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("D287 native WAL test failed: " + message)
}

function readOnly(adapter: NativeAdapter): Pick<V4LocalIndexAdapter, "read" | "exists"> {
  return {
    read: (name: string) => adapter.read(name),
    exists: (name: string) => adapter.exists(name),
  }
}

async function location(pluginId: string): Promise<string> {
  const plan = await planV4PluginPrivateWalLocation({
    configDir: ".obsidian", pluginId, runId: RUN_ID,
  })
  return plan.vaultLogicalWalRoot
}

function key(): Uint8Array {
  // A fixed test vector, never an actual passphrase or user key.
  return new Uint8Array(32).fill(KEY_BYTE)
}

function snapshotInput(
  adapter: NativeAdapter, root: string, contract: V4ReencryptionCutoverSnapshotContract,
  secret: Uint8Array,
) {
  return {
    adapter: readOnly(adapter), root, contract,
    originalJournalKey: secret,
    assertLiveOwner() {},
  }
}

export async function verifyExisting(
  adapter: NativeAdapter,
  pluginId: string,
  contract: V4ReencryptionCutoverSnapshotContract,
) {
  const root = await location(pluginId)
  const secret = key()
  const zeroized = () => secret.every(byte => byte === 0)
  try {
    const paths = [root + "/slot-0.json", root + "/slot-1.json"]
    const before = await Promise.all(paths.map(path => adapter.read(path)))
    const report = await inspectV4ColdStartWalSnapshot(
      snapshotInput(adapter, root, contract, secret),
    )
    const after = await Promise.all(paths.map(path => adapter.read(path)))
    return {
      authenticated: report.observation === "authenticated-current-wal-still-fenced"
        && report.walSnapshotAuthenticated === true
        && report.walMatchesCutoverContract === true,
      readOnly: before.every((value, index) => value === after[index]),
      noCutover: report.localCutoverAuthorized === false
        && report.resumeSyncAuthorized === false
        && report.remoteWritesAuthorized === false
        && report.oldPassphraseCleanupAuthorized === false,
      realObsidianAdapter: true,
      noGitHubUsed: true,
      completeRecoveryProven: false,
      crashedPowerProven: false,
    }
  } finally {
    secret.fill(0)
    demand(zeroized(), "ephemeral reader key not zeroized")
  }
}

export async function seedAndVerify(
  adapter: NativeAdapter,
  pluginId: string,
) {
  const root = await location(pluginId)
  demand(!await adapter.exists(root), "existing probe WAL root must never be reused")
  const secret = key()
  try {
    // Only test synthetic directory creation. Actual Re-encryption authoring
    // needs the persisted fence and Desktop OS-exclusive writer lease.
    const writeAdapter: V4LocalIndexAdapter = {
      read: (name: string) => adapter.read(name),
      exists: (name: string) => adapter.exists(name),
      write: (name: string, value: string) => adapter.write(name, value),
      mkdir: async (name: string) => {
        if (!await adapter.exists(name)) await adapter.mkdir(name)
      },
    }
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writeAdapter, root, runId: RUN_ID,
      sourceCommitSha: SOURCE_COMMIT,
      destinationRepoId: DEST_REPO, journalKey: secret,
    })
    const backup = {
      role: "backup" as const, repoId: BACKUP_REPO,
      commitSha: SOURCE_COMMIT, treeSha: SOURCE_TREE,
    }
    const destination = {
      role: "destination" as const, repoId: DEST_REPO,
      commitSha: DEST_COMMIT, treeSha: DEST_TREE,
      manifestSha256: MANIFEST_SHA,
    }
    const receipt = {
      path: ".obsidian-github-sync-v4/data/aa/" + "b".repeat(64) + ".enc",
      sha: "b".repeat(40), byteLength: 512,
    }
    let state = await journal.begin()
    state = await journal.recordRefIntent(backup, state.generation)
    state = await journal.markRefReadbackObserved(backup, state.generation)
    state = await journal.recordStagingHandoff(backup, state.generation)
    state = await journal.recordUploadIntent(receipt, state.generation)
    state = await journal.appendReceipt(receipt, state.generation)
    state = await journal.recordCandidatePreparationIntent("f".repeat(64), state.generation)
    state = await journal.recordPreparedCandidateReceipt({
      commitSha: DEST_COMMIT, treeSha: DEST_TREE, manifestSha256: MANIFEST_SHA,
    }, state.generation)
    state = await journal.recordRefIntent(destination, state.generation)
    state = await journal.markRefReadbackObserved(destination, state.generation)

    const contract: V4ReencryptionCutoverSnapshotContract = {
      transactionId: "a".repeat(32),
      identity: {
        runId: RUN_ID, walGeneration: state.generation,
        indexRoot: SOURCE_INDEX_ROOT, deviceId: "device_d287",
        sourceRepoId: SOURCE_REPO, backupRepoId: BACKUP_REPO,
        destinationRepoId: DEST_REPO, sourceCommitSha: SOURCE_COMMIT,
        sourceTreeSha: SOURCE_TREE, destinationCommitSha: DEST_COMMIT,
        destinationTreeSha: DEST_TREE, manifestSha256: MANIFEST_SHA,
        sourcePassphraseSecretId: "test-old-key",
        destinationPassphraseSecretId: "test-new-key",
      },
      walSnapshotSha256: await sha256Hex(utf8ToBytes(JSON.stringify(state))),
      sourceIndexSha256: "1".repeat(64),
      destinationShadowSha256: "2".repeat(64),
      preparedEvidenceSha256: "3".repeat(64),
      sourceSettingsSha256: "4".repeat(64),
      destinationSettingsSha256: "5".repeat(64),
    }
    const first = await verifyExisting(adapter, pluginId, contract)
    demand(first.authenticated && first.readOnly && first.noCutover,
      "valid encrypted WAL failed authenticated inspection")

    const wrongKey = new Uint8Array(32).fill(0x24)
    try {
      const denied = await inspectV4ColdStartWalSnapshot(
        snapshotInput(adapter, root, contract, wrongKey),
      )
      demand(denied.observation === "manual-recovery-required",
        "incorrect AES-GCM key unexpectedly authenticated")
    } finally { wrongKey.fill(0) }

    const wrongContract = await inspectV4ColdStartWalSnapshot(
      snapshotInput(adapter, root, { ...contract, walSnapshotSha256: "0".repeat(64) }, secret),
    )
    demand(wrongContract.observation === "manual-recovery-required",
      "foreign immutable WAL digest unexpectedly authenticated")

    const slot = root + "/slot-0.json"
    const originalSlot = await adapter.read(slot)
    const original = JSON.parse(originalSlot) as {
      schemaVersion: 1; generation: number; runId: string; sourceCommitSha: string;
      destinationRepoId: string; ciphertext: string; digest: string
    }
    const middle = Math.floor(original.ciphertext.length / 2)
    const changed = original.ciphertext.charAt(middle) === "A" ? "B" : "A"
    const tampered = { ...original, ciphertext:
      original.ciphertext.slice(0, middle) + changed + original.ciphertext.slice(middle + 1),
    }
    const { digest: _previousDigest, ...signedBody } = tampered
    const counterfeit = JSON.stringify({
      ...signedBody, digest: await sha256Hex(utf8ToBytes(JSON.stringify(signedBody))),
    })
    let tamperRejected = false
    try {
      await adapter.write(slot, counterfeit)
      const denied = await inspectV4ColdStartWalSnapshot(
        snapshotInput(adapter, root, contract, secret),
      )
      tamperRejected = denied.observation === "manual-recovery-required"
    } finally {
      // Restore ONLY our verified disposable synthetic file, regardless of
      // diagnostic outcome; no automatic recovery is enabled.
      await adapter.write(slot, originalSlot)
    }
    demand(tamperRejected, "ciphertext change with recomputed plain SHA-256 was accepted")
    const restored = await verifyExisting(adapter, pluginId, contract)
    demand(restored.authenticated && restored.readOnly,
      "restored synthetic WAL no longer authenticates")
    demand(await adapter.read(slot) === originalSlot,
      "restored WAL bytes differ from pre-tamper bytes")
    return {
      authenticatedTwoSlots: true,
      exactContractBound: true,
      wrongKeyRejected: true,
      tamperedCiphertextWithRehashedHeaderRejected: true,
      restoredAuthenticates: true,
      noCutoverOrSync: first.noCutover && restored.noCutover,
      realObsidianAdapter: true,
      noGitHubUsed: true,
      completeRecoveryProven: false,
      crashedPowerProven: false,
      slotSha256: await Promise.all([0, 1].map(async i =>
        sha256Hex(utf8ToBytes(await adapter.read(root + "/slot-" + i + ".json"))))),
      contract,
    }
  } finally { secret.fill(0) }
}
