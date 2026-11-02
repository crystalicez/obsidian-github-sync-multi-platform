# D244 — Pin Desktop WAL authoring to the live Runtime and persisted Sync Fence

Date: 2026-11-03. Re-encryption Wizard remains Preview-only and release-blocked.

## Problem

D243's create-only Desktop WAL writer required live initiating-lease and Sync Fence callbacks. A caller could supply an arbitrary callback that returned successfully without checking the *actual* persisted D173 Sync Fence. A stale runtime or a restart must not be able to create another WAL just because local files look plausible.

## Boundaries

- `src/lib/v4/reencryption-persisted-wal-fence.ts` provides `createV4PersistedWalFenceAssertion`. It pins the local Index adapter's `exists` and `read` methods, live owner, migration runId and exact Source/Destination repo identities. At every invocation it requires `github-sync-v4-rekey-sync-fence/` and its `active.json` to exist, reads the canonical D173 marker twice, checks byte-for-byte identity and verifies root/file existence again. Missing, torn, malformed, oversized, changed or wrong-run evidence fails closed. It never writes or repairs the marker.
- D243 `openV4NewDesktopPluginWalWriter` now **requires** the actual fence Index adapter plus exact Source and Destination repo IDs. It checks persisted disk evidence in addition to the existing live owner/initiating lease/Sync Fence callback before and after WAL operations. Callback success alone can no longer suffice.
- `V4PluginRuntime` keeps a private, transient `armedReencryptionInitiator` record **only after** `armReencryptionSyncFence` succeeds with the initiating Runtime's reserved quiescence closure and initiating-device lease. The new internal method `openNewReencryptionDesktopWalForArmedRun` uses that exact Runtime's Obsidian adapter, plugin-private Index storage, frozen migration IDs, current Settings and the D243 owner-vetted physical WAL path. It verifies ongoing Sync quiescence and pinned connection credentials, the identity of the original Vault and Settings objects, the configDir/pluginId, and the file-sync scope before and after each file operation. Disposing the Runtime invalidates its initiating session and all subsequent writes; another Runtime instance cannot reconstruct this authority merely by reading persisted files. If final watcher shutdown throws after arming, the transient authoring session is invalidated while the on-disk Fence is preserved.
- The original D243 create-only directory rule and its Node cooperative exclusive WAL lock remain. No second WAL directory creation is allowed after interrupted startup, even if the original WAL leaf is empty.

A matching D173 marker is a **local non-cryptographic prerequisite**, not a MAC and not sufficient on its own to authorize migration, Cutover or Sync resumption. The initiating lease excludes cooperating clients only; unrelated filesystem processes and actual power loss are not certified. On uncertain evidence, data is preserved for Manual Recovery.

## Tests and limits

`tests/v4/reencryption-persisted-wal-fence.test.ts` covers exact marker, invalid identity, missing/torn/oversized marker, changed reader and owner, mutation between awaited disk reads, and no unintended writes.

`tests/v4/reencryption-desktop-plugin-wal-writer.test.ts` now writes a real D173 fence under a disposable Windows plugin-private directory before creating any WAL. Additional scenarios prove that a missing/torn/foreign marker prevents WAL creation and that later marker loss or caller/adapter mutation blocks the next encrypted WAL write without deleting prior bytes.

`tests/v4/reencryption-runtime-wal-authoring.test.ts` constructs a V4 Runtime over an actual disposable Windows vault directory and the native Obsidian adapter contract; it arms the real D173 marker, creates a real encrypted two-slot WAL, releases its Node OS lock, and independently reopens the matching authenticated journal through D242 Recovery. It refuses unarmed and restarted runtimes, lost lease, changed Settings object or scope, moved config directory, changed adapter, disposed owner and damaged disk marker. Failure of watcher shutdown after Fence creation also leaves the transient writer authority absent. It is a **simulated Obsidian runtime**, not an installed Obsidian desktop or mobile acceptance test.

No existing Wizard Run command calls the new writer, and no old passphrase deletion, automatic rollback, remote mutation, publication, index Cutover, native helper, GitHub Actions or public Release occurs. Android/iOS still lack a proven safe WAL writer/interrupt recovery protocol. The six first-release gates remain pending and blocked. The next stage should evaluate conservative Mobile WAL authoring without assuming atomic file rename or OS-level locks, then run installed Obsidian Desktop/Mobile and stale-device acceptance before opening the Wizard.
