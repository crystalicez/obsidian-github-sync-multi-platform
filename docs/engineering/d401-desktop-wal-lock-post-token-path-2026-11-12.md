# D401: revalidate the Desktop WAL lock pathname after reading its token

Date: 2026-11-12 (Asia/Bangkok). Scope: inherited dirty Windows audit worktree `.worktrees/d87-owner-rekey-policy`. First-release Re-encryption remains blocked.

## Defect

`acquireV4DesktopRekeyWalStorage()` owns an exclusive lock file and verifies its token using a pinned open descriptor. Before D401, `assertHeld()` compared the lock path's inode with the descriptor's inode, then awaited `lockHandle.read()` and checked the token. An external process could remove or replace the lock pathname **during the awaited token read**. The pinned descriptor retained the correct token, so the original function returned successful lease proof even though the path no longer identified the active owner's lock.

The problem is independent of the D399 write epoch and D400 post-read WAL-slot checks. It affects an authority check that callers rely on before mutating WAL or accepting stage checkpoints.

## Red test before repair

`tests/v4/reencryption-desktop-wal.test.ts` adds a deterministic Windows physical-filesystem test. Its intercepted pinned lock-handle read pauses after the original pathname and inode checks. The test moves `.exclusive.lock` out of the WAL directory, resumes the original token read, and requires lease rejection. The unmodified code **incorrectly succeeded**.

- `node scripts/run-tests.mjs --tier=fast --filter=tests/v4/reencryption-desktop-wal.test.ts --name-pattern=^D401`, task `efbcbde4-e2ea-41ef-b881-a5ee284dc1b1`: **RED, EXIT 1**, with `Missing expected rejection`.
- The test restores the moved owner lock before releasing the test storage. Its completed version also covers a **different lock inode with the same token bytes** at the original pathname. This ensures merely checking token text or file existence is insufficient.

## Smallest production change

`src/lib/v4/reencryption-desktop-wal.ts` now performs a second `fs.lstat(lockPath)` **after** successfully reading the pinned descriptor's token. It only accepts a regular non-symlink singly linked file whose path device/inode match the pinned handle and whose size matches the token length. Missing, detached, hardlinked, replaced or unsafe lock paths fail with the existing `V4DesktopRekeyWalLockError`.

The post-token check does not create a new lock, unlink any preexisting lock, automatically recover ownership, rotate token values, or enable Cutover. It narrows the interval of unchecked path ownership; it is **not an OS-wide atomic lease** and does not prevent external mutation after the final check. A checkpoint or migration still needs independently authenticated WAL and the existing fail-closed policies.

## Verification

- **GREEN:** D401 focused native Windows test via process `4bb14a8f-5f81-42e3-978c-e4841d910de0`, **1/1 PASS, exit 0**, both real filesystem interference cases. Complete Desktop WAL test file via process `e58f5307-8366-4776-9119-5973b19b86d8`, **30/30 PASS, exit 0**. The earlier complete Desktop WAL suite task `5da65a33-1fa5-4d02-9c2e-94d18fdad754` also passed 30/30 after the initial fix.
- `pnpm typecheck:max-strict` process `cc54eab3-d7b6-47b4-ab24-0f391b4ba411`, `pnpm build` `1287718d-b04c-4b2a-96c4-c4c430b1dac5`, `pnpm typecheck:github-e2e` `7503b3c0-815d-4506-b894-664027f316d0`, GitHub E2E 3-bundle compilation `222c613e-f1d0-441b-a61d-cdb2fc226269`, `pnpm test:feasibility` `a4f7cf48-e9d1-46b8-9faf-f59889e66268`, `pnpm test:recovery` `0d3e0fea-dcf5-4b3f-8006-467f33c9d610`, `pnpm test:resource` `7e209c5d-ec5f-4676-827c-9f7bfea207be`, metadata `cb222f4d-e89e-4ca0-9d87-ba4b5c485de2`, and package validation `2fa5cbaf-983e-4e9a-b02e-e4a1e0e3ca25` all finished **EXIT 0**.
- `git diff --check` EXIT 0 with known Windows LF/CRLF warnings. Live GitHub/installed Windows and Full Fast source-fingerprint final results will be recorded in the handoff after their terminal results; no PASS is claimed for unfinished tasks.

## Release boundary

This is a cooperative Desktop WAL lease guard and a deterministic negative test, not proof of real power-cut safety, full installed-runtime GitHub publication, or an authorized Settings/Selector/Index Cutover. The existing first-release policies stand: Sync plus Re-encryption together, ciphertext part size 8 MiB, Mobile initiation capability-gated at 32 MiB, no physical test file larger than 100 MB, and best-effort Manual Recovery when evidence is insufficient.

Live remote test writes remain restricted to approved disposable GitHub repo ID `1284153873`, unique preflight-absent `obsidian-sync-e2e/local-*` branches, and double-verified cleanup. No user Vault, default branch, GitHub Actions, release, commit, push or merge is authorized. Physical Android/iOS and stale-device acceptance, Git-history disclosure and restart-safe local Cutover still need proof.
