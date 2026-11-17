/**
 * D324 test-only CommonJS renderer probe. This file is never part of main.js.
 * It opens a pre-existing synthetic WAL in a disposable Obsidian Vault.
 * The exclusive lock file is created and released; WAL slots are read-only.
 */
import { sha256Hex, utf8ToBytes } from "../src/lib/bytes"
import { openV4DesktopPluginWalForRecovery } from "../src/lib/v4/reencryption-desktop-plugin-wal-recovery"
import { planV4PluginPrivateWalLocation } from "../src/lib/v4/reencryption-plugin-wal-location"

const RUN_ID = "D287NativeWalEvidence"

type DesktopTestAdapter = {
  getFullPath(path: string): string
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

function demand(condition: unknown): asserts condition {
  if (!condition) throw Error("Isolated Desktop WAL Recovery probe refused.")
}

/**
 * D325: negative checks against the actual existing-only recovery API.
 * Every operation is fenced to a disposable WAL created by the native smoke.
 */
export async function verifyNativeDesktopWalRecoveryDenials(
  adapter: DesktopTestAdapter,
  pluginId: string,
  expectedSlotSha256: readonly string[],
) {
  demand(Array.isArray(expectedSlotSha256) && expectedSlotSha256.length === 2
    && expectedSlotSha256.every(sha => /^[0-9a-f]{64}$/u.test(sha)))
  const layout = await planV4PluginPrivateWalLocation({
    configDir: ".obsidian", pluginId, runId: RUN_ID,
  })
  const root = layout.vaultLogicalWalRoot
  const slots = [root + "/slot-0.json", root + "/slot-1.json"]
  const original = await Promise.all(slots.map(slot => adapter.read(slot)))
  demand((await Promise.all(original.map(data => sha256Hex(utf8ToBytes(data)))))
    .every((digest, i) => digest === expectedSlotSha256[i]))

  // A wrong independent readback digest must fail before opening/locking WAL.
  const wrong = expectedSlotSha256[0] === "0".repeat(64)
    ? "f".repeat(64) : "0".repeat(64)
  let wrongDigestRejected = false
  try {
    await verifyNativeDesktopWalRecovery(adapter, pluginId, [wrong, expectedSlotSha256[1]!])
  } catch (error) {
    wrongDigestRejected = error instanceof Error
      && error.message === "Isolated Desktop WAL Recovery probe refused."
  }
  demand(wrongDigestRejected && !(await adapter.exists(root + "/.exclusive.lock")))

  let ownerLive = true
  const owner = {
    adapter, configDir: ".obsidian", pluginId, runId: RUN_ID,
    assertLiveOwner() {
      if (!ownerLive) throw Error("Synthetic Desktop WAL owner revoked.")
    },
  }
  const reader = await openV4DesktopPluginWalForRecovery(owner)
  let otherReaderBlocked = false
  let revokedReadBlocked = false
  let revokedCheckpointBlocked = false
  let revokedLeaseBlocked = false
  try {
    await reader.assertExclusiveStageLease()
    // The same genuine OS lock must refuse a concurrent recovery attempt.
    try {
      const second = await openV4DesktopPluginWalForRecovery({
        ...owner, assertLiveOwner() {},
      })
      await second.release()
    } catch (error) {
      otherReaderBlocked = error instanceof Error
        && error.name === "V4DesktopRekeyWalLockError"
    }
    ownerLive = false
    const deniedWithRevocation = async (action: () => Promise<unknown>) => {
      try { await action(); return false } catch (error) {
        return error instanceof Error
          && error.message === "Synthetic Desktop WAL owner revoked."
      }
    }
    revokedReadBlocked = await deniedWithRevocation(() =>
      reader.adapter.read(layout.journalRoot + "/slot-0.json"))
      && await deniedWithRevocation(() =>
        reader.adapter.exists(layout.journalRoot + "/slot-1.json"))
    revokedCheckpointBlocked = await deniedWithRevocation(() =>
      reader.assertBestEffortCheckpoint())
    revokedLeaseBlocked = await deniedWithRevocation(() =>
      reader.assertExclusiveStageLease())
  } finally {
    await reader.release()
  }
  const after = await Promise.all(slots.map(slot => adapter.read(slot)))
  return {
    wrongPinnedDigestRejected: wrongDigestRejected,
    concurrentRecoveryReaderRejected: otherReaderBlocked,
    revokedOwnerReadRejected: revokedReadBlocked,
    revokedOwnerCheckpointRejected: revokedCheckpointBlocked,
    revokedOwnerLeaseRejected: revokedLeaseBlocked,
    ciphertextSlotsPreserved: original.every((value, i) => value === after[i]),
    lockReleasedAfterRevocation: !(await adapter.exists(root + "/.exclusive.lock")),
    remoteGitHubUsed: false,
    cutoverAuthorized: false,
  }
}

export async function verifyNativeDesktopWalRecovery(
  adapter: DesktopTestAdapter,
  pluginId: string,
  expectedSlotSha256: readonly string[],
) {
  demand(Array.isArray(expectedSlotSha256) && expectedSlotSha256.length === 2
    && expectedSlotSha256.every(sha => /^[0-9a-f]{64}$/u.test(sha)))
  const layout = await planV4PluginPrivateWalLocation({
    configDir: ".obsidian", pluginId, runId: RUN_ID,
  })
  const root = layout.vaultLogicalWalRoot
  const slots = [root + "/slot-0.json", root + "/slot-1.json"]
  const before = await Promise.all(slots.map(slot => adapter.read(slot)))
  const beforeSha256 = await Promise.all(before.map(data =>
    sha256Hex(utf8ToBytes(data))))
  demand(beforeSha256.every((digest, i) => digest === expectedSlotSha256[i]))
  // This no-op owner callback is TEST ONLY, not proof of an installed
  // Sync Fence, migration lease or Cutover permission.
  const reader = await openV4DesktopPluginWalForRecovery({
    adapter, configDir: ".obsidian", pluginId, runId: RUN_ID,
    assertLiveOwner() {},
  })
  let checkpoint = ""
  let slotsPreserved = false
  try {
    await reader.assertExclusiveStageLease()
    const texts: string[] = []
    for (const [i] of slots.entries()) {
      const logical = layout.journalRoot + "/slot-" + i + ".json"
      demand(await reader.adapter.exists(logical))
      const data = await reader.adapter.read(logical)
      demand(await sha256Hex(utf8ToBytes(data)) === expectedSlotSha256[i])
      texts.push(data)
    }
    slotsPreserved = texts.every((text, i) => text === before[i])
    checkpoint = await reader.assertBestEffortCheckpoint()
  } finally {
    await reader.release()
  }
  const after = await Promise.all(slots.map(slot => adapter.read(slot)))
  return {
    existingOnlyOpened: true,
    immutableEncryptedSlots: slotsPreserved && after.every((text, i) => text === before[i]),
    osLeaseReleased: !(await adapter.exists(root + "/.exclusive.lock")),
    bestEffortOnly: checkpoint === "best-effort-readback-only",
    remoteGitHubUsed: false,
    cutoverAuthorized: false,
    powerLossDurabilityProven: false,
  }
}
