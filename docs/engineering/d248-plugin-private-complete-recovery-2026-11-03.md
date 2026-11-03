# D248 — Plugin-private read-only complete Recovery bridge

Date: 2026-11-03. Owner decision **B** remains unchanged: first public stable Release needs fully qualified Sync **and** working Re-encryption. The six acceptance checks remain pending.

## Problem and scope

D247 joins the independently authenticated original frozen Backup, persisted candidate contract/key, encrypted adjacent WAL slots and complete new-key Destination under one exclusive Recovery scope. Its internal input still accepts a caller-supplied WAL adapter and relative path, so it cannot by itself demonstrate that the verified slots are the physical slots owned by the installed Obsidian plugin.

D248 adds **only read-only bridge functions**, not a Re-encryption migration workflow or a Cutover permission:

- `inspectV4DesktopPluginCompleteRecovery` takes the actual live Obsidian Vault Adapter, current config directory, manifest plugin ID and saved migration run ID. The D242 Desktop owner resolver checks every physical vault/plugin directory, refuses redirection/symlinks and derives the same plugin-private WAL path as D243 authoring. D241 existing-only recovery opens exactly two slots, with a temporary cooperative Node OS-exclusive lock. While holding it, D247 reauthenticates the old frozen Backup twice around the encrypted WAL/new Destination proof. The lock is released even if verification fails. It **does not create, erase, rewrite or repair** either WAL slot; the temporary OS lock file is the only local file added/removed by opening the reader.
- `inspectV4MobilePluginCompleteRecovery` derives the *same* WAL location from the native Obsidian Adapter without Node APIs, uses D242 existing-only `stat/list` plus double-read size/mtime checks, and requires an **explicit live cooperating-device lease** provided by its future installed caller. It snapshots both slot ciphertext strings across every D247 boundary and refuses drift. Mobile has **no OS-level lock or atomic-replace/fsync guarantee**; cooperating callbacks cannot prove exclusion of unrelated processes. Never use this diagnostic as a publication or automatic recovery authority.
- Both functions require the D236 frozen Backup and D239 new-key Destination to share the **exact same live owner**, physical Index reader and SecretStorage reader, and require the owner run ID to match the authenticated saved candidate Contract. The old journal key is supplied only as an *untrusted candidate*, rederived/authenticated by D236 inside D247 and never included in the public diagnostic report.

All successful and failed reports explicitly retain `powerLossDurabilityProven=false`, `commitDecisionAuthorized=false`, `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false`, `oldPassphraseCleanupAuthorized=false`, and `installedObsidianAcceptanceProven=false`. The report distinguishes Desktop cooperative OS lock from Mobile cooperating-lease-only isolation; `mobileOsLockProven=false` throughout. Any missing WAL, wrong owner/run, lock contention, damaged file, changed lease or authenticity mismatch returns `manual-recovery-required` and preserves evidence.

## Tests

`tests/v4/reencryption-destination-exact-commit.test.ts` adds D248 tests using D247's real PBKDF2 old key, authenticated frozen Backup/Settings/contract, two adjacent AES-GCM WAL generations and full new-key Git/Shadow fixture.

The Desktop scenario seeds a real plugin-private WAL on disposable Windows filesystem, verifies the bridge refuses access **while the original D164 writer still holds its OS lock**, releases the writer, completes D247 through the physical existing-only WAL opener, then proves both ciphertext files survived byte-for-byte and no lock file is left. A mismatched run ID is refused without making a new WAL.

The Mobile scenario simulates native Obsidian Adapter `stat/list/read` on an existing plugin-private WAL, completes the same D247 proof under one cooperating holder, verifies no filesystem mutation, and proves revoked lease and torn ciphertext fail closed. Neither scenario is an installed Obsidian app or physical power-cut acceptance test.

## Remaining release work

These APIs are internal and **not wired into the current user-visible Wizard or Restart command**. The plugin still must safely construct D247 evidence from a real native runtime owner, persistent SecretStorage, correct current Git clients and the previously persisted migration contract; authenticate ownership and set a read-only diagnostic state on startup. The end-to-end create-only Backup/WAL/Orphan Destination pipeline, multi-device stale-client fencing and actual Windows/macOS/Linux/Android/iOS Obsidian acceptance remain to be proved. Do not enable Wizard Run/Cutover, automatically resume Sync, delete the original passphrase, mutate live GitHub refs, create a public Release, or use GitHub Actions from D248 evidence alone.
