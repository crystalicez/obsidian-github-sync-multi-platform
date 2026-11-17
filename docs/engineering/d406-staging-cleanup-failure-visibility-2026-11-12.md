# Stage D406 — Staging cleanup must not silently certify deletion

Date: 2026-11-12. Scope: existing V4 Sync/Re-encryption staging paths in the inherited dirty D87 audit worktree. First public release gate remains **blocked**.

## Defects in already-implemented paths

**1. Failed partial cleanup was silently ignored.** `src/lib/v4/staging-store.ts` implemented `removePartial()` as `try { await backend.remove(path) } catch {}`. As a result, `abort()` could resolve and permanently enter `aborted` although an uncommitted partial stage still existed. If a write partially persisted bytes, then failed, and cleanup also failed, `poison()` threw only the original write error with no indication that unknown residue remained.

**2. Missing Mobile remove capability was silent success.** `createV4PlatformIo().removeStage()` on non-desktop platforms returned normally when `adapter.remove` was not supplied. A caller could therefore believe it had cleaned up a stage when no deletion had been attempted.

## Behavioral RED evidence

- New `D406 abort reports failed partial cleanup and retries instead of falsely claiming deletion`: with a backend that fails the first remove and leaves a byte array, the unchanged source **resolved** abort instead of rejecting. Two concurrent abort callers were not correctly notified. Original test process `7e7a5e42-7d12-433c-86e5-6afcb02e7d6d`, exit **1**, `Missing expected rejection`.
- New `D406 failed staged write does not hide a second failure to remove its partial bytes`: when a backend writes a partial file then fails, and the first cleanup also fails, original source reported only the write error. The same process exited 1 with this failure.
- New `D406 mobile missing remove capability cannot claim successful stage cleanup`: original Mobile I/O returned success without calling any remove method. Process `0171bc57-983e-4efa-a463-3d12b13e3f3f`, exit **1**, `Missing expected rejection`.
- New positive boundary `D406 abort with an explicit absent stage is idempotent, not a recovery failure`: after initially surfacing cleanup failures, the fix was strengthened to accept a specifically reported `ENOENT` (no stage existed) rather than warning about unproven cleanup. Intermediate focused process `029fcace-8466-4cb1-aba5-9f56605f7f80` exit 1 before this correction.

## Narrow fixes

- Exported `V4StagingCleanupError` with the exact private partial path, underlying cleanup failure and (when applicable) original stage failure; when cleanup cannot be confirmed, a partial stage is **not** marked aborted. Errors from two simultaneous aborts are not hidden by the queue's deliberately swallowed internal continuation; both callers see a rejection. A later `abort()` can retry the removal.
- `poison()` preserves its original failure when cleanup succeeds, preserving earlier behavior and error identity. If cleanup itself fails, it reports a typed error containing both failures, with no successful stage reference or commit.
- Specifically recognized `ENOENT` on remove as proof of an absent stage; it is safe for repeated/never-started abort. Permission, I/O and other unknown errors are **not** swallowed.
- Mobile and other non-desktop platform I/O now fail closed with a `V4BoundedIoUnavailableError("stage-cleanup")` if adapter.remove is missing rather than returning success.
- No automatic stale-stage deletion or GitHub ref handling is introduced. No change to encryption format, Sync conflict policy, PBKDF2, or Vault commit permissions.

## Validation

- Focused V4 Staging Store suite, including D406 and earlier D405: **16/16 PASS**.
- Focused Platform I/O suite, including missing Mobile remove: **8/8 PASS**.
- `pnpm typecheck:max-strict`: exit 0.
- Remaining Sync/Recovery/build/release checks and source-fingerprinted full Fast results are recorded in `HANDOFF-NEXT-SESSION.md` after terminal verification.

## Limitations

This repair can report an unremoved partial stage but cannot guarantee cleanup when the operating system refuses deletion or when a non-cooperative external process changes a pathname. Manual inspection remains necessary when cleanup cannot be proven. Physical Android/iOS staging acceptance, multi-device stale-client safety and complete installed owner Re-encryption Cutover are outstanding. The approved disposable GitHub test repository, if used, must use only fresh preflight-absent temporary refs and double-verified cleanup. Do not enable Wizard Execute or mark the release gate passed.
