# D119 — Invalidate WAL directory fsync evidence before every new flush

Date: 2026-10-27. **Fail-closed isolated-stage durability hardening; re-encryption release gate stays BLOCKED.**

## Actual correctness defect

The D115 Desktop WAL code retained a mutable `directorySyncConfirmed` Boolean that was assigned **only after** `await syncOneDirectory(directory)`. Once a successful WAL directory sync made the Boolean true, a later WAL slot rename followed by an **unexpected filesystem sync exception** (for example EIO) would reject the WAL write but could leave the Boolean **true** from the earlier operation. Another caller checking `assertCrashDurable()` on the same held lease could therefore receive a stale-positive claim of durable intent. An overlapping older successful sync could similarly complete after a newer sync began or failed, promoting the wrong result.

This is independent of the known Windows Node-only `EPERM` failure: that remains unsupported and never certifies power-loss durability.

## Fix

`src/lib/v4/reencryption-desktop-wal.ts` now uses a small testable `V4RekeyWalDirectorySyncProof` state machine for the runtime `syncDirectory()` barrier:

- Every `refresh()` invalidates the **previous** durability claim *synchronously*, before awaiting a new directory sync.
- A rejected sync leaves the claim invalid and propagates its original unexpected exception. Explicitly unsupported returns also leave the claim invalid. A leaf sync cannot override unproven initial ancestor-directory fsync evidence.
- Each attempt has an identity and active-sync counter. If sync attempts overlap, **neither** completion order can certify durable WAL until a **fresh, nonoverlapping** directory sync succeeds. A stale older success cannot overwrite failure or pending state of a newer operation.
- The existing `assertCrashDurable()` checks this same proof after checking the exclusive stage lease. No fallback to old evidence, no OS-specific waiver and no persistence/protocol format changes.

## Fault-injection regression

Three new tests in `tests/v4/reencryption-desktop-wal.test.ts` exercise the exact production sync-proof class with deterministic test-only promises:

1. Success → injected EIO on a later leaf fsync → `assertConfirmed` rejects even after the prior successful flush; unsupported flush and missing parent durability also reject; a subsequent real success at the proof abstraction may restore the state.
2. While an async leaf flush is **still pending**, the prior success must already be invalidated; rejecting that pending operation cannot restore it.
3. Two overlapping flushes complete in **both possible orders**. Neither may authorize durability; only a subsequent serial successful sync can restore proof.

The existing real Windows Desktop WAL tests still run against actual Node `fs/promises` and exercise encrypted slots, stale locks, OS process kill, disallowed hardlinks, and the Windows `EPERM` fail-closed durability boundary. The injected EIO is a deterministic logic-level proof; it is NOT a physical filesystem fault, arbitrary power cut, or Native Helper.

## Qualification

- Desktop WAL focused **19/19 PASS**; Maximum Strict TypeScript PASS.
- Full Fast **919/919**, Fast repeated **10×919/919** (exit 0, zero failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production Build, GitHub E2E compile-only (3 bundles), package and metadata validation PASS.
- Cryptographic soak **100,000,000 bytes** across 12 chunks and two parts PASS, reference SHA-256 matched. No real GitHub sync/test-repository mutation, actual physical power loss, or installed Obsidian migration performed.
- No installed Obsidian migration, user Vault writes, credentialed GitHub test-repository operations, force pushes, Native Helper, or GitHub Actions.

## Production boundary unchanged

Even with conservative directory-sync bookkeeping, Windows Node-only `fsync EPERM` still blocks proving power-loss durability. Real OS-wide initiating-vault editor fencing, crash-safe initiating-only branch/passphrase/index cutover, new-secret provenance, live GitHub three-ref acceptance with numeric `GITHUB_E2E_EXPECTED_REPO_ID`, and Windows/mobile multi-device acceptance remain open. D90/D91 writable old Source + pinned frozen Backup + zero-parent orphan encrypted Destination, all in the same repo, remains owner-approved. Wizard Preview-only; `docs/release-gates/reencryption-wizard.json` status `blocked`.
