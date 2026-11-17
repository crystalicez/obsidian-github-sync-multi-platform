# Stage D404: Desktop WAL release preserves a replacement owner's lock

Date: 2026-11-12. Working copy: `.worktrees/d87-owner-rekey-policy`. The Re-encryption release gate stays **blocked**.

## Existing behavior that did not work reliably

`acquireV4DesktopRekeyWalStorage().release()` waited for in-flight operations, called `assertHeld()` to verify the current lock pathname and pinned token, then unlinked `.exclusive.lock`. Unlike initialization cleanup and the WAL temporary-slot handling hardened in D402–D403, release never rechecked the lock pathname's physical identity immediately before unlinking it.

An independent OS process could rename the original lock to another pathname and place its own lock (including identical token bytes) at `.exclusive.lock` after `assertHeld()` completed. The original release operation would delete **the new owner's lock**, even though it did not own that inode. This matters to concurrent writers and Manual Recovery, not to normal cooperative clients.

## Reproduction and repair

The `D404 releasing a displaced lock preserves a foreign same-token replacement` regression intercepts the **second real Windows filesystem `lstat` of the lock** inside `release()`'s `assertHeld()`, swaps the original lock to a different pathname, and creates a different inode with the original token at `.exclusive.lock` before returning the earlier stat result.

- **RED on original source:** the release returned successfully. The test reported `Missing expected rejection (V4DesktopRekeyWalLockError)`; task `244a3d2e-dcc6-4ec5-a07f-86690dfb0a26` exited 1. This shows the original code could unlink another owner's same-token lock.
- **Repair:** after `assertHeld()`, `release()` checks that the current pathname is still a regular, single-link, non-symlink file whose nonzero `dev + ino` matches the pinned lock descriptor, with the expected token byte length. A missing or changed file raises `V4DesktopRekeyWalLockError` without unlinking either lock.
- **Positive recovery:** the same test restores the original lock pathname after the failed release and verifies that its legitimate owner can then release successfully. This keeps the in-process lease usable after a transient external pathname change.

The D404 check is **best-effort** and cannot make `lstat` plus `unlink` atomic on Windows. A hostile process could still replace a pathname between the final check and unlink. No permission to auto-reclaim stale locks, trust an unverified WAL, or claim power-loss durability follows from this repair.

## Validation and compatibility

- Full physical Windows Desktop WAL suite, including D404 and existing D399–D403 coverage: **36/36 PASS**.
- `pnpm typecheck:max-strict`, `pnpm build`, `pnpm test:recovery` (**93/93**): all exit 0.
- Further compile, broad offline qualification, and native E2E outcomes are recorded in `HANDOFF-NEXT-SESSION.md` only after terminal verification.
- No encryption format, GitHub protocol, settings, wizard execution, or user-visible UI changes.

The user Vault, production/default GitHub branches, GitHub Actions, and automatic stale-lock cleanup remain untouched. Authorized E2E writes, if run, use only unique preflight-absent disposable branches and double-verified deletion. This work does not authorize the still-unproven migration Cutover.
