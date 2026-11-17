# Stage D403: Desktop WAL temporary-slot ownership (2026-11-12)

## Scope

Continue the inherited dirty D87 audit worktree. Preserve earlier D292–D402 changes and keep the Re-encryption release gate blocked. This is a local filesystem boundary fix. Do not run Wizard Execute, Settings/Selector/Index Cutover, access a user's Vault, change a default GitHub branch, or reclaim stale WAL locks.

## Failure reproduced on Windows

`rawAdapter.write()` wrote and fsynced a random `.slot-*.tmp` file, then closed its handle before several awaited lease/target checks. It renamed the temporary **pathname** over a valid WAL slot without first proving that the pathname still referred to the file it had created. Its `finally` cleanup also unconditionally unlinked the same pathname. An uncooperative OS process could replace this file while the writer awaited I/O.

Two deterministic physical-filesystem regressions failed on the original source:

- `D403 temporary-slot replacement cannot overwrite a valid WAL checkpoint`: the test displaced the legitimate temp and installed foreign bytes just before the final target check. The write unexpectedly succeeded (`Missing expected rejection`). The caller could lose its last valid WAL slot.
- `D403 failed WAL rename preserves another owner's temporary file`: the test displaced the temp, replaced the original path, then injected a rename I/O failure. The original cleanup removed the foreign replacement (`ENOENT` on readback).

Both tests create isolated Windows filesystem fixtures under `.tmp`; no GitHub, user Vault, or default branch is accessed.

## Narrow repair

In `src/lib/v4/reencryption-desktop-wal.ts`:

1. Capture the newly created temp file's pinned descriptor identity using BigInt `stat`, including `dev`, nonzero `ino`, `nlink`, size and nanosecond modification/change times after syncing data.
2. Verify a regular, non-symlink, single-link pathname with the same identity immediately before renaming it over the WAL slot. A different or missing inode throws instead of publishing.
3. During cleanup, unlink the temporary pathname only when it still matches the pinned writer-owned inode and metadata. Otherwise preserve the foreign file as unexplained recovery evidence.
4. Cover the positive failure case: if the pre-rename filesystem error leaves the original temp unchanged, cleanup still removes that temp and keeps the prior WAL slot intact.

This is a **best-effort, non-atomic check**. It narrows ordinary I/O races but does not create OS-level exclusive access or prevent a malicious change after the final `lstat`. The authenticated journal remains the recovery authority. A discovered foreign temp is not automatically cleared or reused.

## Verification

- RED before fix: two D403 regressions failed as predicted (`Missing expected rejection` and `ENOENT`).
- GREEN after fix: D403 focused 2/2, then full `reencryption-desktop-wal` file **35/35** including three new D403 tests.
- `pnpm typecheck:max-strict`, `pnpm build`, `pnpm typecheck:github-e2e`, `pnpm test:github-e2e:compile`, `pnpm test:recovery` **93/93**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **167/167**, `pnpm validate:metadata` and `pnpm validate:package`: all exited **0**.
- Full source-fingerprinted Fast offline qualification and installed Obsidian live acceptance are separate gates. See the latest `HANDOFF-NEXT-SESSION.md` for their terminal status; this document does not imply they passed.
- Prior D402 pending task IDs from another session were unavailable for result retrieval here. Do not report their completion without independent evidence.

## Release decision

`docs/release-gates/reencryption-wizard.json` remains `blocked`. The full installed Runtime owner migration chain, restart-safe Cutover, stale-device behavior, physical Android/iOS and independent release review remain unproven. This patch changes no encryption format, remote protocol, user-visible configuration, or release policy. No commit/push/merge/release was performed during D403.
