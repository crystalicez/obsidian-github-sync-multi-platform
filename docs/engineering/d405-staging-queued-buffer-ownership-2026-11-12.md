# Stage D405: queued staging appends retain submitted bytes

Date: 2026-11-12 (Asia/Bangkok). Scope: local Windows audit worktree `.worktrees/d87-owner-rekey-policy`. This repairs the existing V4 Sync staging implementation, not a new feature. Release gate remains **blocked**.

## Incomplete behavior

`src/lib/v4/staging-store.ts` serializes queued `V4StagedSink.append(bytes)` operations. Previously it captured the caller's mutable `Uint8Array` in the queued closure and passed the same view to `backend.write()` / `backend.append()`. If a streaming caller reused a buffer after handing it to a sink, but before a queued write completed, the stored bytes could silently differ from the supplied bytes. This invalidates the staged content's correspondence to the separately supplied SHA-256 and can block recovery or make a staged file unusable.

## Repro on existing code

Added `D405 queued staging appends retain the supplied bytes after caller buffer reuse` in `tests/v4/staging-store.test.ts`. It uses two real asynchronous `append()` calls against a delayed backend. The caller supplies `[1,2]` and `[3,4]`, then overwrites both input arrays while the first backend write is still pending.

On the original implementation, the regression failed with real observed bytes `[9,9,8,8]` versus expected `[1,2,3,4]`. The focused test process `03b3f334-0648-442e-8559-35e3d7cc67e0` exited **1** for the intended behavioral mismatch.

## Narrow correction

`append()` now copies input to a writer-owned `Uint8Array` *synchronously before entering its asynchronous serialization queue*. The queued operation checks the owned buffer's length, sends only its owned buffer to the storage backend, and accounts for exactly those submitted bytes. Neither the backend API nor the WAL/stage IDs or encryption formats change.

The tradeoff is one additional byte copy per submitted chunk and temporary ownership of that memory while a write is pending. Normal production call sites await each append, so the additional staged input is bounded to a chunk at a time; clients that deliberately queue many appends retain copies until processed. The fix does not claim to make an uncooperative backend or a hostile external filesystem actor atomic. SHA-256 and destination readback still provide separate checks.

## Validation

- Focused V4 Staging Store tests: **13/13 PASS** after repair; observed new regression changed from RED to GREEN.
- Maximum Strict TypeScript `pnpm typecheck:max-strict`: exit **0**.
- V4 Sync Session **137/137 PASS**, Recovery **93/93 PASS**, Resource **11/11 PASS**, production build exit **0**.
- Additional feasibility, full source-fingerprinted Fast and disposable live GitHub results are recorded in `HANDOFF-NEXT-SESSION.md` only after terminal validation.

## Boundaries

No real user Vault, GitHub default branch, existing production branch, old SecretStorage passphrases, settings Cutover or Wizard Execute was changed. Previously approved live writes are permitted only on fresh, preflight-absent branches in isolated GitHub test repository physical ID `1284153873`, with double-verified cleanup. Keep `docs/release-gates/reencryption-wizard.json` as `blocked` until the existing integrated migration and mobile hardware acceptance are complete.
