# D245 — Conservative Mobile WAL authoring under a live Obsidian owner

Date: 2026-11-03. The first public Re-encryption Wizard remains Preview-only and blocked.

## Goal and constraint

Owner decision **A** places the encrypted Re-encryption WAL under the same Vault plugin-private namespace on all platforms. D242 had an existing-only Mobile Recovery reader, D243 had an isolated Desktop writer with a Node OS lock, and D244 pinned that writer to a live Runtime and an exact persisted Sync Fence. Mobile lacks a proven OS-wide exclusive lock, atomic rename and crash-durable fsync contract through the Obsidian Vault Adapter.

**Therefore D245 is a fail-closed, best-effort Mobile WAL writer, not an atomic or durable WAL certification.** No repository Git ref, active Index, old key, or Release Gate is changed.

## Boundaries

`src/lib/v4/reencryption-mobile-plugin-wal-writer.ts` exports `openV4NewMobilePluginWalWriter` using the real Obsidian Vault Adapter `stat/list/read/write/mkdir` plus the D242 shared `<configDir>/plugins/<pluginId>/reencryption-wal/<sha256(runId)>` layout. It uses no Node APIs and never calls `rename` or `remove`.

Before creating the run-specific directory, it requires every existing plugin ancestor, a pinned live owner/initiating-device cooperative lease, and D244's **double-read, exact run/source/destination persisted D173 Sync Fence**. It rejects an existing WAL directory even when empty. If the parent is absent it may create the parent only under the verified plugin-private root; the newly created WAL leaf remains after any subsequent error for Manual Recovery. Mobile `stat` + `mkdir` is **not** atomic across unrelated processes; separate device/OS agents are not excluded by this implementation.

The writer returns a frozen `V4LocalIndexAdapter` compatible with the existing authenticated AES-GCM two-slot `createV4ReencryptionRecoveryJournal`. The adapter is restricted to the two exact WAL slot paths and the two already created WAL directories. Reads and existence checks can occur concurrently because the encrypted Journal reads both slots in parallel; all mutations are serialized. The adapter allows only one active writer per live in-process Obsidian Adapter object. It rejects extra files/folders and missing/altered known slots, bounds each text write to **2 MiB**, double-reads each written slot and checks `size/mtime` and the full returned text. It checks all known slots and the exact directory listing before and after every operation, along with the owner, lease and persisted Fence.

If a slot write is interrupted, returns an error after committing bytes, acknowledges truncated bytes, or any guard/inventory fails, the writer enters a **permanently poisoned state**. It does not retry, remove, overwrite, repair, or attempt automatic Rollback. The persisted files are preserved for Manual Recovery. The original encrypted Journal still checks authenticated generation adjacency; these extra readbacks do **not** turn Adapter writes into atomic/durable writes.

The explicit returned flags are `cooperativeOsLeaseProven=false`, `atomicSlotWritesProven=false`, `powerLossDurabilityProven=false`, `resumeSyncAuthorized=false`, `cutoverAuthorized=false`.

## Live Runtime integration

`V4PluginRuntime.openNewReencryptionMobileWalForArmedRun()` is an **internal, explicitly invoked** method that uses the *same transient initiating owner* created by the real D173 `armReencryptionSyncFence` operation. The shared owner-checking helper pins the original plugin/Vault/Settings, configDir/pluginId, connection and file-sync scope, and reserved Sync coordinator quiescence, including asserting the initiating-device cooperative lease across awaits. Both Desktop and Mobile writer entrypoints now share that helper. The Mobile method requires a complete live Obsidian Adapter and is unavailable on Desktop. It is not called from the installed Wizard Run, and a restarted Runtime does not rehydrate writer authority.

## Validation and release limitations

`tests/v4/reencryption-mobile-plugin-wal-writer.test.ts` exercises actual AES-GCM journal generation and existing-only Mobile Recovery on an Obsidian Adapter simulation; create-only refusal for empty/torn/foreign old run directories; missing plugin root and wrong-run Fence; truncated write, uncertain acknowledgement after a full write, foreign temp file, same-length slot substitution, lost owner/lease/Fence, input method identity change, concurrent in-process starts and path traversal. The retained interrupted bytes are checked directly.

`tests/v4/reencryption-mobile-runtime-wal-authoring.test.ts` exercises the simulated Mobile `V4PluginRuntime` lifecycle: real D173 Fence creation, encrypted two-slot WAL and independently reopened Recovery, denied Restart writer authority, changes to Settings scope/adapter, missing lease, torn Fence and Desktop/Mobile platform mismatch. Regression tests on the previous Desktop Runtime authoring path remain green.

**These are not installed Android or iOS Obsidian tests.** No real device crash, OS kill, sync-provider concurrent writer, unreliable filesystem, symlink/junction, or power-cut durability has been proven; the Android/iOS runtime still needs native acceptance tests. In particular, a hostile or uncooperative process can modify WAL slots between readbacks and a second process could win a `stat`/`mkdir` race. The legacy Source/Backup, candidate contract, full WAL/Destination content readback and stale-device state still require an owner-scoped joined proof before an active Cutover. User-visible Re-encryption Wizard Run remains Preview-only and all six release gates remain pending.

## Next

D246 should connect the Mobile writer to an installed-device-only, explicitly user-initiated diagnostic harness or integration test. Validate Android and iOS Obsidian Adapter behavior with interrupted writes and restart. Then join D236 original Backup and D239 WAL/Destination read-only proof under a single real owner/lease, followed by stale-device and Manual Recovery acceptance. Do not promote the current best-effort Mobile adapter to automatic migration or Git publication authority.
