# D242: Plugin-private Re-encryption WAL location on Desktop and Mobile

Date: 2026-11-02. Owner decision **A**: keep the encrypted Re-encryption write-ahead log (WAL) inside the Obsidian Vault's plugin-private storage, following the existing Index namespace, rather than adding an OS-wide private storage architecture.

## Shared layout

The layout is derived from the **actual Obsidian** `vault.configDir`, `plugin.manifest.id`, and an authenticated migration `runId`. It never uses an untrusted remote repository path or arbitrary absolute WAL directory.

```
<configDir>/plugins/<pluginId>/reencryption-wal/<sha256(UTF-8 runId)>/
    slot-0.json
    slot-1.json
```

`planV4PluginPrivateWalLocation` returns the Vault-relative plugin root, the plugin-relative journal root, and the complete Vault-relative WAL root. A 64-character hex digest maps a run ID of up to 128 characters into the existing D164 Node WAL's safe two-segment directory format. The same layout applies to Desktop, Android and iOS. This planner validates run ID, plugin ID, custom config path components, Unicode NFC and Windows-reserved names; no filesystem writes occur.

## Existing-only recovery on Desktop

`openV4DesktopPluginWalForRecovery` receives the current Obsidian adapter's `getFullPath`, `configDir`, `pluginId`, `runId` and live runtime owner guard. It checks the adapter's Vault absolute root and plugin path, verifies each existing physical ancestor with `lstat` and `realpath`, rejects redirected paths, junctions and symlinks, and delegates to the D241 **existing-only** WAL opener.

The only newly created file is the temporary token/inode-checked cooperative OS lock in the **existing** WAL directory. The returned frozen adapter exposes only `read` and `exists`. Every read and checkpoint checks live owner and adapter identity again. The caller must release the lock, even on owner loss. Missing WAL slots, damaged files and foreign interrupted temporary files remain untouched for Manual Recovery. A cooperative OS lock does not prevent an unrelated filesystem writer.

## Existing-only readback on Mobile

`openV4MobilePluginWalForRecovery` accesses exactly the same logical WAL location using the native Obsidian Vault Adapter's `stat`, `list` and `read` operations. It requires all plugin and WAL ancestor directories to already exist and the two expected files to be the **only** WAL children. It validates slot sizes, the original size/mtime identity, stable listings and two identical text reads while repeatedly asserting the live owner. No fallback memory WAL or directory creation is allowed.

Mobile reports `cooperativeOsLeaseProven=false`, `powerLossDurabilityProven=false`, `resumeSyncAuthorized=false`, and `localCutoverAuthorized=false`. Obsidian Adapter does not prove no OS-level symlink, an atomic cross-file snapshot, fsync or exclusion of other devices. The result is **diagnostic**; it must not be substituted for D239's required exclusive recovery lease.

## Verification and remaining release requirements

D242 offline tests cover deterministic and safe shared layout, default and Unicode custom config directories, traversal and reserved names, real Windows private plugin directories and existing WAL lock reopen, foreign adapter mapping, owner drift, missing directories, unchanged/recovered slots and torn temporary-file retention. Separate Mobile Adapter simulations cover successful bounded readback, missing/extra slots and directories, modified slots, changed adapter methods, owner loss and read-outside-WAL rejection. All tests require no physical power-cut.

**Not installed in Obsidian Wizard Run**: the production WAL **writer** is still not wired into the actual Re-encryption lifecycle. In future, both writer and recovery must derive the same private path from a separately authenticated persisted run ID; no legacy migration compatibility is required before first public release. An OS power failure, deletion of the plugin folder or different Android/iOS storage lifecycles can still require Manual Recovery. No active Index writer, automatic Cutover, GitHub remote write, old passphrase deletion, Native Helper or GitHub Actions has been introduced.

The first-release Re-encryption Wizard gate remains `blocked`. Next work should attach the writer/reader to one actual Obsidian owner with a conservatively fenced local transaction, validate the old Frozen Backup and full Destination contents, then run real desktop and mobile acceptance tests and stale-device scenarios before considering release.
