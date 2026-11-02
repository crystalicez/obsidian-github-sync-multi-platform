import type { V4LocalIndexAdapter } from "./local-index"
import { acquireV4DesktopRekeyWalStorage, type V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"

export interface V4DesktopExistingWalRecoveryReader
  extends Pick<V4DesktopRekeyWalStorage,
    "lockPath" | "assertExclusiveStageLease" | "assertBestEffortCheckpoint" | "release"> {
  readonly adapter: Readonly<Pick<V4LocalIndexAdapter, "read" | "exists">>
}

/**
 * Desktop recovery only. rootAbsolute must come from a trusted, previously
 * pinned private directory; this function never discovers or creates it.
 * The exclusive lock file is the only new file and is released by the caller.
 */
export async function openV4ExistingDesktopWalForRecovery(input: {
  readonly rootAbsolute: string
  readonly journalRoot: string
}): Promise<V4DesktopExistingWalRecoveryReader> {
  const opened = await acquireV4DesktopRekeyWalStorage({
    ...input, recoveryExistingOnly: true,
  })
  return Object.freeze({
    adapter: Object.freeze({
      read: (path: string) => opened.adapter.read(path),
      exists: (path: string) => opened.adapter.exists(path),
    }),
    lockPath: opened.lockPath,
    assertExclusiveStageLease: () => opened.assertExclusiveStageLease(),
    assertBestEffortCheckpoint: () => opened.assertBestEffortCheckpoint(),
    release: () => opened.release(),
  })
}
