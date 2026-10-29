# D157 — Destructive Force confirmation target and lifetime binding

Date: 2026-10-30. This is an existing normal-Sync UI safeguard, **not** permission to execute Re-encryption. Owner-approved Node.js-first strict crash-safety policy and `docs/release-gates/reencryption-wizard.json` `blocked` remain unchanged. No GitHub Actions or Native Helper.

## Production finding

`FastSync.showForceConfirm("forcePush" | "forcePull")` displayed the repository and branch when the modal opened. Its unlocked confirmation button subsequently called `v4Runtime.forcePush()` or `forcePull()`, which snapshots **the current** connection/credentials/sync policy at execution time. If Settings were saved while the confirmation remained open, the displayed authorized target and the actual destructive operation could differ. Similarly, closing or cancelling the modal previously settled only the dialog Promise; the captured old confirm callback could remain callable after the slider had already been unlocked.

## Fail-closed patch

The prompt now captures a **value copy** of the current settings; the displayed target comes from that copy. At click time, before any Force dispatch, the code compares each material current settings property against that copy, including repository owner/name/branch, GitHub credentials, encryption credentials/mode, vault choice, ignore regex, synchronized config/plugins/bookmarks, change threshold and conflict policy. It also refuses confirmation during an in-progress settings save or when Settings has unsaved draft edits. Only display preferences, last-sync timestamp and independent automatic scheduling preferences are excluded, so a harmless progress display update does not invalidate a valid confirmation.

If material state differs, the modal closes without calling `forcePush` or `forcePull`; one static generic notice instructs the user to review the current target and open a new confirmation. The notice does not echo secret credentials, a private vault path or the new target. There is **no automatic retry or fallback**. Existing slide-to-unlock and explicit click confirmation remain mandatory.

The `onClose` handler now irrevocably revokes the modal's `resolved` confirmation flag and settles the dialog Promise, so an old unlocked button cannot initiate a Force operation after Cancel, Escape or close. An authorized click consumes the flag before closing and executes exactly once. The Obsidian Modal test stub was adjusted to invoke `onClose` when `close()` is called, matching the host lifecycle for realistic tests.

## Behavioral evidence

`tests/v4/main-ui-sync-errors.test.ts` drives real production `FastSync.showForceConfirm()` dialogs via the test Obsidian Modal/slider/button stubs for **both Force Push and Force Pull**. The matrix covers replacement owner/repository, in-place branch edit, token replacement, encryption-mode and passphrase edits, vault selection, ignore regex, sync-plugin scope and conflict policy, each verifying no Force dispatch and sanitized expiration guidance. It also checks harmless lastSyncTime/statusBar changes do not invalidate the correct target, double-click triggers only one operation, and Cancel or external Close **after slider unlocking** revokes previously captured button callback. Focused 6/6 PASS.

## Explicit limits

The guard binds the user's confirmation to settings identity **at click time**. It does not lock the remote branch, physically freeze the Vault, prove OS-wide writer exclusion, or replace the runtime's preexisting GitHub CAS/WAL/recovery protections. It does not change user-approved Force semantics. Actual user Vault, SecretStorage and live GitHub were not mutated during this stage. Re-encryption Cutover remains explicitly unavailable until independent strict safety qualifications.
