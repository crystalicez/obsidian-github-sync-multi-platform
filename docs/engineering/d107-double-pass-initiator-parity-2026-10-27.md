# D107 — Double-pass initiating-vault SHA-256 against post-read same-size/mtime modifications

Date: 2026-10-27. **Internal safety hardening, not an end-user Re-encryption release.**

## Finding

D105/D106 read every initiating-device source file once with SHA-256, then compared final directory listing by `path/size/mtime`. A second writer could mutate an already-hashed note **after the first scan read that file** but while other files were being read, and preserve the original size and mtime. The inventory check would not detect the changed content. D106 file-handle `ctime` checks protect a single handle while it is open, but not edits after that handle has closed.

An already-hashed source file must not be treated as permanently authenticated merely because an earlier hash was valid.

## Change

`src/lib/v4/reencryption-initiator-parity.ts` now:

1. Fully inventories actual scoped local files under the D106 live Sync/editor/config/lease guards.
2. Streams and SHA-256 authenticates EVERY source file against the pinned immutable remote records.
3. Re-observes inventory/size/mtime with guards and compares exactly.
4. **Independently streams and authenticates EVERY file a second time**, without trusting the first pass or cached digests, and checks the byte totals again.
5. Re-observes inventory/size/mtime a third time, and rechecks all guards. All errors still fail closed **before** D100/D102 could create an orphan Destination ref.

This is an expensive, deliberate two-pass safety barrier, not an implicit production-performance optimization. Peak memory stays bounded by the existing 8 MiB chunk size plus streaming SHA and per-file inventory. D100 may invoke this check multiple times across publication barriers. Cost needs measurement on installed Obsidian representative vaults before enabling the full migration.

## Evidence

- Added `D107 second SHA-256 pass detects an intervening same-size same-mtime edit to an already-hashed note` in `tests/v4/reencryption-initiator-parity.test.ts`. The test alters the first note *after its hash*, before the second note is read; restores identical metadata, and requires rejection on pass two.
- Added disposable **real Windows filesystem** D107 regression in `tests/v4/reencryption-desktop-initiator-reader.test.ts` that changes a previously hashed file between reads of two notes. The independent physical reader and new second pass refuse an apparently stale-source Vault.
- D105+D107 parity focused **9/9 PASS**, physical D106+D107 focused **11/11 PASS**, D100/D102 destination tests **34/34 PASS**.
- Full local qualification after change: Fast **880/880**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production build, GitHub E2E compile-only (three bundles), package and release metadata validation **all PASS**.

## Trust boundary and remaining hard blockers

Even a double pass **does not atomically freeze the filesystem**: an external writer may still change a note after its second hash or intentionally alternate contents between reads. No proof authorizes `initiatorLocalCutoverAuthorized`, and no local Settings, secrets, indexes or vault files are changed by D107. The production Cutover needs a truly enforced cross-process edit fence or a separately approved snapshot/transaction architecture.

Unchanged first-release blockers: D86 Windows Node-only directory `fsync EPERM` means power-loss durable migration WAL is unproven; local initiating-device-only safe branch/key/index Cutover and associated recovery remain unfinished; real guarded GitHub 3-ref E2E still needs the numeric pinned `GITHUB_E2E_EXPECTED_REPO_ID` and installed two-Obsidian/mobile acceptance. Do not bypass safety checks, adopt Native Helper without owner approval, force old-device migration, or use GitHub Actions.

`docs/release-gates/reencryption-wizard.json` remains **`status:"blocked"`**, and the Wizard stays Preview-only. Three roles remain old Source independently writable, pinned Backup, and zero-parent newly encrypted Destination under D90/D91.
