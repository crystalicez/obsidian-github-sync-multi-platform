# D243: Create-only plugin-private Desktop WAL authoring

Date: 2026-11-02. Owner policy **A** remains: the Re-encryption WAL lives in the Obsidian Vault's existing plugin-private storage. The first public Re-encryption Wizard remains **blocked** and Preview-only.

## Why

D242 mapped the same run-specific WAL directory on Desktop and Mobile and provided existing-only recovery readers. The isolated D164 Node WAL writer still accepted a caller-supplied absolute root and could reopen a directory belonging to an interrupted attempt. A production lifecycle must never silently reinitialize a previous run: even an **empty** WAL leaf can be valuable evidence of a failed start. A separate writer boundary must verify the **current** Obsidian adapter, plugin path, owner, cooperative initiating lease and persisted Sync Fence.

## Changes

- `src/lib/v4/reencryption-desktop-plugin-wal-owner.ts` owns the read-only physical path and live-owner verification shared by D242's recovery reader and D243's new writer. It calculates the D242 plugin-private WAL root from `configDir`, `pluginId`, and `runId`, verifies Obsidian `getFullPath("")` and `getFullPath(pluginStorageRoot)`, and checks every physical ancestor using `lstat` and `realpath`. The writer rechecks the owner and physical directory through awaited boundaries.
- D164's `acquireV4DesktopRekeyWalStorage` has an explicit, opt-in `requireNewJournalRoot` mode. On its initial open it uses one atomic `mkdir` for the WAL leaf, rejecting `EEXIST`; ordinary WAL creation and D241 existing-only recovery behavior are unchanged. After initial creation it allows legitimate `adapter.mkdir(root)` operations by the encrypted journal. It never deletes previous WAL folders or slot evidence. If the process fails after directory creation, the empty leaf remains and later attempts demand Manual Recovery.
- `src/lib/v4/reencryption-desktop-plugin-wal-writer.ts` exposes `openV4NewDesktopPluginWalWriter`. It requires **caller-provided live assertions** `assertExclusiveInitiatorLease` and `assertSyncFenceArmed`, in addition to the pinned Obsidian owner; these assertions are checked before and after each read, write, mkdir, lease verification and checkpoint. The returned adapter supports the existing encrypted `createV4ReencryptionRecoveryJournal` unchanged, and provides a token/inode-checked Node cooperative WAL lock, best-effort checkpoint and explicit `release`. Reports `crashDurabilityProven=false`, `resumeSyncAuthorized=false`, and `cutoverAuthorized=false`; no claim of physically durable power-loss writes.

## Verification

`tests/v4/reencryption-desktop-plugin-wal-writer.test.ts` uses real disposable Windows filesystem directories and the real encrypted journal's two-generation AES-GCM WAL writes, releases its OS lock and independently reopens both slots under D242's read-only Recovery reader, recovering exactly the authenticated journal state. Additional cases: original empty WAL directory; interrupted single slot; unknown temporary evidence; missing initial owner, lease or Sync Fence; late loss of each guard after slot 0; simultaneous same-run writers (only one atomic mkdir winner); out-of-root path; altered guard callback; and loss of Fence immediately after creating the WAL directory. All fail closed without deleting WAL evidence.

The test provides fake assertions backed by mutable state, **not** a real installed Obsidian initiating-device lease or actual persisted Sync Fence proof. The writer is **not wired** to the installed plugin or Wizard Run, cannot perform Git operations, does not implement Mobile authoring, and cannot give Cutover permission. There is no real power-cut test or proof of directory fsync on Windows.

## Next

D244 should bind these required callbacks to one actual live Obsidian plugin/vault instance with settings snapshots and the persisted Sync Fence on every write boundary. For Mobile, add a conservative Obsidian Adapter write protocol with explicit interrupted-write recovery; do not imply Node-style atomic rename or filesystem lease parity. Complete the D236/D239 source/Backup/Destination authentication, stale-device and Manual Recovery acceptance before considering any unblocking of Re-encryption Wizard gates.
