# D115 — Include WAL parent-directory entries in crash-durability gate

Date: 2026-10-27. **Fail-closed filesystem hardening, not a release gate waiver.**

## Finding

The D86 Windows/Node desktop re-encryption write-ahead log (WAL) creates a private nested directory tree (for example `rekey/wal`) underneath an explicitly authorized, pre-existing root. Previously `acquireV4DesktopRekeyWalStorage` flushed the lock file and the WAL **leaf** directory, then accepted successful leaf-directory `fsync` as the directory side of `assertCrashDurable`. This omitted an important part of the creation durability boundary: each newly created nested directory name is an entry in its **parent**, and successful `fsync` of the leaf alone is not evidence that those ancestor directory entries are durable after sudden power failure.

The concern is most relevant on systems that support directory `fsync` (where the old code could claim success). Windows Node-only directory `fsync EPERM` was already blocked; that block remains.

## Minimal fix

`src/lib/v4/reencryption-desktop-wal.ts` now:

1. Maintains separate ancestor and leaf sync evidence. After creating the nested directory structure, acquiring the create-only OS lock and syncing the lock's bytes, it requests `fsync` for **every parent of the WAL leaf within the trusted pre-existing root**, in order: authorized root, root/first-segment, and so on.
2. Syncs the leaf directory after the lock and after each atomic WAL slot rename, as before.
3. Sets `directorySyncConfirmed` only if **both** the one-time ancestor chain check and the most recent leaf check succeed. Unsupported `EPERM`, `EACCES`, `EINVAL`, `ENOTSUP` or `EISDIR` anywhere in the hierarchy fail closed; unexpectedly different filesystem errors still propagate.
4. Never upgrades a failed ancestor result into apparent durability just because a subsequent leaf-directory sync succeeds. This does **not** add a Native Helper, change the WAL encrypted format, alter user-vault paths, broaden platform privileges or skip the existing single-writer lease.

The trusted absolute root is required to **already exist** and is outside the created WAL subtree. This change does not independently certify durability of that root's own directory entry, a complete sequence of power cuts, device write-cache honesty, or externally enforced vault-wide writer exclusion.

## Qualification

- Real Node/Windows nested-directory WAL test creates a deeper `rekey/extra/nested/wal` structure, writes and reads encrypted slot-1, probes support for syncing the root, each nested parent and leaf, and requires `assertCrashDurable` to fail closed when any directory sync is unsupported.
- Focused real-filesystem Desktop WAL **11/11** PASS; Maximum Strict TypeScript PASS; full Fast **911/911**, Fast Repeat **10 complete rounds × 911/911** (exit 0), Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, production Build, GitHub E2E **compile-only three bundles**, package and metadata validation PASS. Bounded cryptographic soak **100,000,000 bytes / 12 chunks**, digest matched reference, exit 0.
- Platform-provided `fsync` success is not a physical power-loss certification. No real GitHub test-repository mutation, installed Obsidian multi-device migration, user vault access or production release was performed.

## Unchanged blockers and owner decisions

Windows Node-only `fsync EPERM` remains a hard gate. A production migration still requires supported/proven WAL crash durability on the target OS, a real cross-process initiating-vault edit fence, trusted new-key provenance, fully crash-safe initiating-only branch/passphrase/index cutover, pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID` real same-repository three-branch validation, installed two-device Windows and physical Android/iOS qualification and independent release review.

D90/D91 owner policy stays: independently writable old-key Source branch, frozen Backup, fresh zero-parent encrypted Destination branch, **all in the same GitHub repository**; no forced switch of old clients, automatic cleanup, GitHub Actions, Native Helper promotion or durability waiver. Re-encryption Wizard remains Preview-only and `docs/release-gates/reencryption-wizard.json` remains `blocked`.
