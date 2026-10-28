# D136: read-only restart reconciliation of prepared Intent, Source/Shadow Index and encrypted WAL

Date: 2026-10-28. Re-encryption Wizard remains **Preview-only** and the release gate remains **blocked**.

## Scope and observation

`inspectV4ReencryptionRestartEvidence` in `src/lib/v4/reencryption-local-cutover-restart.ts` reads the separate D135 local cutover Intent, D134 Shadow Destination Index, Source Index and D132 independently authenticated WAL evidence. This creates **no commit record, no cross-surface durable atomic transaction, no repair, and no authorization**. Success is only `source-with-prepared-intent-uncommitted`. Every report hardcodes `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false` and `oldPassphraseCleanupAuthorized:false`. Partial and mismatched observations return `manual-recovery-required`. Platform errors (failed lease/durability/WAL reads) propagate; they cannot be mistaken for success.

This function is **not wired into the shipping runtime, the Wizard, Settings or SecretStorage**. It runs on a separately supplied reader/lease, and cannot write to a user's Vault or to GitHub.

## Consistency checks

1. Pin the independent Source/Backup/Destination identity, exact commit SHA, WAL generation, SecretStorage **IDs** (never values), active/shadow roots, run ID, index adapter, journal and WAL verifier method, secret provider, lease and durability callbacks **before the first await**.
2. Build the exact canonical D135 `prepared-uncommitted` Intent bytes from the pinned independent identity. Bound the Intent to 8 KiB using the same shared maximum as the D135 writer, which now refuses oversized records before making an Intent directory; compare the full serialized record, not merely the caller-controlled or recomputable SHA-256 checksum.
3. Under externally supplied lease/durability assertions, read Intent and complete Source/Shadow sharded indices. Require expected encrypted repository and device identity, exact pinned Git commit SHAs and non-dirty/non-deleted records.
4. Confirm that **both old and new accessible SecretStorage values** are available for restart recovery; never read them into a report or log. Pass the pinned WAL verifier into D132, which validates the two distinct Backup/Destination ref observations and prepared candidate using two healthy WAL readbacks around Settings/index/secret inspection.
5. Check the lease/durability assertions again, reread the exact Intent and both indices, require equal full index snapshots, both Secret IDs available, and unchanged caller identity and callbacks before returning a positive *uncommitted* observation.

A positive result **is not an authenticated proof of index record contents**. Local shard content digests and the D135 Intent checksum are unkeyed. A hostile writer who can replace a complete cached index with a self-consistent forged one before the first read may evade purely local consistency inspection. D136 cannot reconstruct the original D134 candidate solely from a branch SHA. A future commit protocol must bind an independently authenticated Destination content/candidate receipt and actual GitHub ref readback, not infer trustworthy content from this report. Similarly, a cooperative JS lease and bounded readbacks do not prevent non-cooperating external Vault edits after the final read.

## Fault matrix and physical filesystem test

- `tests/v4/reencryption-local-cutover-restart.test.ts` tests positive Source observation with **zero writes**, forged/retargeted Intent with recomputed SHA, missing/truncated/oversized/noncanonical Intent, corrupted/moved Source or Shadow, changed Intent/Shadow during SecretStorage read, damaged WAL receipts/candidate, mismatched Settings/missing old or new Secret, swapped index adapter, swapped WAL verifier method, absent durability/lease, corrupt WAL reader and malformed path/run/commit.
- The two last hardening cases (missing new Secret and swapped WAL verifier method) were **RED before the fix** and **GREEN after**.
- `tests/recovery/reencryption-local-cutover-restart-windows.test.ts` writes an Intent and both indices into a fresh disposable Windows filesystem directory, constructs a separately reopened **read-only** adapter, checks the positive uncommitted report, intentionally truncates Intent and proves manual recovery, restores it and verifies Source/Shadow bytes are unchanged. This checks disk I/O and adapter separation, **not** actual reboot, sudden-power-loss hardware persistence or an encrypted production WAL. Its injected durability/lease callbacks are test stubs and its WAL reader is a fixture.

## Blockers carried forward

- True crash/power-loss persistent WAL and parent-directory `fsync` on Windows Node-only path remain unproven (`EPERM`). No downgrade from the owner-approved strict Re-encryption crash-safety standard.
- No independently durable **commit** or idempotent restart reconciler that can atomically coordinate Obsidian `saveData()`, SecretStorage IDs, selected local index, and old-key cleanup. The Source and Backup must remain safe and both Secrets retained until commit/recovery is proven.
- No live same-repo Source/Backup/Destination three-ref GitHub acceptance in this stage, no installed Obsidian 2-device migration on Windows/macOS/Linux and no physical Android/iOS qualification. No GitHub Actions, Native Helper promotion, automatic Git branch deletion, or live sync mutations.

Next safe step is an independently authenticated candidate-to-Shadow content binding and a read-only post-restart **commit-proof design**, followed by fault-injected crash tests and actual platform durability qualification. Do not enable automatic cutover or accessible old-passphrase cleanup from observation alone.
