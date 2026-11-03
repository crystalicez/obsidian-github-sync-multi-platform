import type { V4ColdStartCompleteRecoveryInput, V4ColdStartCompleteRecoveryReport } from "./reencryption-cold-start-complete-recovery"
import { inspectV4ColdStartCompleteRecovery } from "./reencryption-cold-start-complete-recovery"
import { openV4DesktopPluginWalForRecovery, type V4DesktopPluginWalOwner } from "./reencryption-desktop-plugin-wal-recovery"
import { openV4MobilePluginWalForRecovery, type V4MobilePluginWalOwner } from "./reencryption-mobile-wal-recovery"
import { planV4PluginPrivateWalLocation } from "./reencryption-plugin-wal-location"

type Backup = V4ColdStartCompleteRecoveryInput["backup"]
type Current = V4ColdStartCompleteRecoveryInput["current"]

// Mobile offers no OS WAL lock. Deny overlapping read-only Recovery attempts
// in this JavaScript process even if an injected cooperative holder is faulty.
// Key by the actual vault adapter, not a cloneable owner/run wrapper.
const activeMobileRecoveryAdapters = new WeakSet<object>()

interface V4PluginRecoveryEvidence {
  /** Must be the installed plugin's actual Index and persisted Settings. */
  readonly backup: Backup
  readonly contract: Current["contract"]
  readonly destination: Current["destination"]
  /** D240 candidate. Independently verified by D236, NEVER returned. */
  readonly originalJournalKey: Uint8Array
}

export interface V4DesktopPluginCompleteRecoveryInput extends V4PluginRecoveryEvidence {
  readonly owner: V4DesktopPluginWalOwner
}

export interface V4MobilePluginCompleteRecoveryInput extends V4PluginRecoveryEvidence {
  readonly owner: V4MobilePluginWalOwner
  /**
   * Must be provided by the CURRENT installed device owner. This is only
   * cooperative exclusion; no cross-process OS lock can be claimed on Mobile.
   */
  readonly withExclusiveCooperativeRecoveryLease: <T>(body: () => Promise<T>) => Promise<T>
  readonly assertCooperativeRecoveryLease: () => Promise<void>
}

export interface V4PluginCompleteRecoveryReport extends V4ColdStartCompleteRecoveryReport {
  readonly isolation: "desktop-os-cooperative-wal-lock" | "mobile-cooperative-best-effort-only"
  readonly mobileOsLockProven: false
  readonly installedObsidianAcceptanceProven: false
}

function manual(isolation: V4PluginCompleteRecoveryReport["isolation"]): V4PluginCompleteRecoveryReport {
  return Object.freeze({
    integrityScope: "read-only-original-backup-encrypted-wal-complete-destination",
    observation: "manual-recovery-required",
    originalKeyAuthenticated: false,
    completeOldBackupReverified: false,
    walReceiptsBoundToDestination: false,
    completeDestinationContentsReverified: false,
    verifiedFileCount: 0,
    verifiedPlaintextBytes: "0",
    powerLossDurabilityProven: false,
    commitDecisionAuthorized: false,
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    rollbackAuthorized: false,
    remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
    isolation,
    mobileOsLockProven: false,
    installedObsidianAcceptanceProven: false,
  })
}

function checkEvidence(input: V4PluginRecoveryEvidence, owner: {
  readonly runId: string
  readonly assertLiveOwner: () => void
}): void {
  owner.assertLiveOwner()
  if (!input.backup || !input.destination || !input.contract
    || input.backup.assertLiveOwner !== owner.assertLiveOwner
    || input.destination.assertLiveOwner !== owner.assertLiveOwner
    || input.backup.adapter !== input.destination.adapter
    || input.backup.getSecret !== input.destination.getSecret
    || input.contract.identity.runId !== owner.runId
    || !(input.originalJournalKey instanceof Uint8Array)
    || input.originalJournalKey.length !== 32) {
    throw Error("Re-encryption Recovery must use one live owner, saved contract and Index/SecretStorage.")
  }
}

function compose(
  input: V4PluginRecoveryEvidence,
  wal: {
    readonly root: string
    readonly adapter: Current["wal"]["adapter"]
  },
  assertLiveOwner: () => void,
): Pick<V4ColdStartCompleteRecoveryInput, "backup" | "current"> {
  return {
    backup: input.backup,
    current: {
      contract: input.contract,
      destination: input.destination,
      wal: {
        root: wal.root,
        adapter: wal.adapter,
        originalJournalKey: input.originalJournalKey,
        assertLiveOwner,
      },
    },
  }
}

function observation(
  report: V4ColdStartCompleteRecoveryReport,
  isolation: V4PluginCompleteRecoveryReport["isolation"],
): V4PluginCompleteRecoveryReport {
  return Object.freeze({
    ...report,
    isolation,
    mobileOsLockProven: false as const,
    installedObsidianAcceptanceProven: false as const,
  })
}

/**
 * D248: read-only Desktop cold-start proof on the actual plugin-private WAL
 * path derived from the Obsidian Vault Adapter. Opening takes only the
 * temporary D164 OS lock; no WAL slots are created, overwritten or removed.
 */
export async function inspectV4DesktopPluginCompleteRecovery(
  input: V4DesktopPluginCompleteRecoveryInput,
): Promise<V4PluginCompleteRecoveryReport> {
  const isolation = "desktop-os-cooperative-wal-lock"
  let opened: Awaited<ReturnType<typeof openV4DesktopPluginWalForRecovery>> | undefined
  try {
    const { owner, backup, contract, destination, originalJournalKey } = input
    checkEvidence(input, owner)
    const openedReader = await openV4DesktopPluginWalForRecovery(owner)
    opened = openedReader
    const pinned = () => {
      checkEvidence(input, owner)
      if (input.owner !== owner || input.backup !== backup || input.contract !== contract
        || input.destination !== destination || input.originalJournalKey !== originalJournalKey) {
        throw Error("Re-encryption Desktop diagnostic evidence changed.")
      }
    }
    pinned()
    // The D242 owner opener validates the actual physical path. D237 uses
    // the same derived relative root when it parses the encrypted slots.
    const layout = await planV4PluginPrivateWalLocation(owner)
    const joined = compose(input, {
      root: layout.journalRoot,
      adapter: openedReader.adapter,
    }, owner.assertLiveOwner)
    pinned()
    const lease = async () => { pinned(); await openedReader.assertExclusiveStageLease(); pinned() }
    const report = await inspectV4ColdStartCompleteRecovery({
      ...joined,
      withExclusiveRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
        await lease()
        return body()
      },
      assertExclusiveRecoveryLease: lease,
      assertBestEffortWalCheckpoint: async () => {
        pinned()
        const value = await openedReader.assertBestEffortCheckpoint()
        pinned()
        return value
      },
    })
    pinned()
    return observation(report, isolation)
  } catch {
    return manual(isolation)
  } finally {
    await opened?.release()
  }
}

/**
 * D248: Mobile can re-read the same two encrypted slots via Obsidian Adapter.
 * The caller must hold its own cooperating device lease; no OS lock or
 * power-loss durability is inferred, and neither report can authorize Cutover.
 */
export async function inspectV4MobilePluginCompleteRecovery(
  input: V4MobilePluginCompleteRecoveryInput,
): Promise<V4PluginCompleteRecoveryReport> {
  const isolation = "mobile-cooperative-best-effort-only"
  let reservedAdapter: object | undefined
  try {
    const { owner, backup, contract, destination, originalJournalKey,
      withExclusiveCooperativeRecoveryLease: holder,
      assertCooperativeRecoveryLease: lease } = input
    checkEvidence(input, owner)
    if (typeof holder !== "function" || typeof lease !== "function") return manual(isolation)
    const adapter = owner.adapter
    if (!adapter || typeof adapter !== "object" || activeMobileRecoveryAdapters.has(adapter)) {
      return manual(isolation)
    }
    const { configDir, pluginId, runId, assertLiveOwner } = owner
    const nativeMethods = {
      stat: adapter.stat, list: adapter.list, read: adapter.read,
    }
    activeMobileRecoveryAdapters.add(adapter)
    reservedAdapter = adapter
    const reader = await openV4MobilePluginWalForRecovery(owner)
    const pinned = () => {
      checkEvidence(input, owner)
      if (input.owner !== owner || input.backup !== backup || input.contract !== contract
        || input.destination !== destination || input.originalJournalKey !== originalJournalKey
        || input.withExclusiveCooperativeRecoveryLease !== holder
        || input.assertCooperativeRecoveryLease !== lease
        || owner.adapter !== adapter || owner.configDir !== configDir
        || owner.pluginId !== pluginId || owner.runId !== runId
        || owner.assertLiveOwner !== assertLiveOwner
        || adapter.stat !== nativeMethods.stat || adapter.list !== nativeMethods.list
        || adapter.read !== nativeMethods.read) {
        throw Error("Re-encryption Mobile diagnostic evidence or cooperative lease changed.")
      }
    }
    pinned()
    const boundary = async () => { pinned(); await lease(); pinned() }
    let snapshot: readonly string[] | undefined
    const checkpoint = async (): Promise<"best-effort-readback-only"> => {
      await boundary()
      const before = await Promise.all([
        reader.adapter.read(reader.journalRoot + "/slot-0.json"),
        reader.adapter.read(reader.journalRoot + "/slot-1.json"),
      ])
      await boundary()
      if (snapshot && before.some((value, i) => value !== snapshot![i])) {
        throw Error("Re-encryption Mobile WAL changed during complete diagnostic scan.")
      }
      snapshot = Object.freeze(before)
      return "best-effort-readback-only"
    }
    const joined = compose(input, { root: reader.journalRoot, adapter: reader.adapter }, owner.assertLiveOwner)
    const report = await inspectV4ColdStartCompleteRecovery({
      ...joined,
      withExclusiveRecoveryLease: async <T>(body: () => Promise<T>): Promise<T> => {
        return holder(async () => { await boundary(); return body() })
      },
      assertExclusiveRecoveryLease: boundary,
      assertBestEffortWalCheckpoint: checkpoint,
    })
    pinned()
    return observation(report, isolation)
  } catch {
    return manual(isolation)
  } finally {
    if (reservedAdapter) activeMobileRecoveryAdapters.delete(reservedAdapter)
  }
}
