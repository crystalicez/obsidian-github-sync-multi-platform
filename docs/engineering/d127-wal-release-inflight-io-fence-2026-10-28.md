# D127 — WAL exclusive lease release drains in-flight adapter I/O before unlinking lock

Date: 2026-10-28. **Real Windows Node filesystem fail-closed hardening; Re-encryption release remains BLOCKED.**

## RED→GREEN: A WAL write outlived its exclusive lease

D126 serializes multiple encrypted recovery journal instances sharing one live adapter, but `acquireV4DesktopRekeyWalStorage()` had a separate lease lifecycle defect. Its `release()` awaited `assertHeld()`, then set `closed = true` and unlinked `.exclusive.lock`, without checking if a physical adapter `read/write/exists/mkdir` was still running. The adapter write has async lock checks, temporary file creation, `fsync`, rename, directory sync, and cleanup stages; the owning lock could disappear while these operations were in flight. A second process could then acquire a new `wx+` WAL lease during the preceding writer's remaining I/O.

A new test in `tests/v4/reencryption-desktop-wal.test.ts` initiated a **real Windows filesystem** rewrite of the same authenticated encrypted WAL slot, then called `release()` before the pending operation completed. **Before the fix the new regression failed**: the active write threw `V4DesktopRekeyWalLockError: lease already released`, showing the lock had been released in the middle of work. This was not a forged callback or an in-memory adapter-only simulation.

## Runtime fix

In `src/lib/v4/reencryption-desktop-wal.ts`:

- Each publicly exposed adapter operation now executes through `withLiveLease()`, which **synchronously** increments the lease's active operation count **before its first await**, then releases the count in `finally` (including after errors and temporary-file cleanup).
- The raw adapter is private to the storage constructor; consumers only see the guarded wrapper for `exists/read/mkdir/write`.
- `assertExclusiveStageLease()` and `assertCrashDurable()` also take this short-lived activity claim so release cannot overlap a durability assertion.
- `release()` **synchronously** claims the releasing state before awaiting anything, forbidding further adapter I/O. If earlier operations remain active, it **waits for all to drain** while retaining the original OS lock, including sibling reads still running after an upstream fail-fast `Promise.all` rejection. Duplicate release is rejected with `V4DesktopRekeyWalLockError`. It does not force-cancel I/O or unlink the lock prematurely. This avoids turning ordinary recovery cleanup into a failed release because another read was still settling.
- Once release claims the lifecycle, new operations and duplicate release attempts are refused. A successful release still requires original pinned inode/token verification and retains existing unlink, directory sync and close ordering. On failure before unlink, the original lock and WAL remain for the caller/operator to inspect.

No WAL encryption, two-slot transition, Git remote publication, or owner-approved branch policy changes.

## Test proof

- **RED→GREEN** Windows test: starts an actual encrypted WAL slot write and immediately attempts release. The pre-fix implementation incorrectly released the lease mid-write; the fixed implementation refuses new I/O while release is pending, drains the original write before unlinking, then preserves a healthy authenticated WAL on fresh acquisition.
- Second Windows regression: two simultaneous release calls cannot both unlink the same lock; any adapter operation attempted after release begins fails closed. A subsequently acquired lease reads the exact original authenticated WAL. In the first full repeat campaign the original fail-fast release policy also exposed an in-flight sibling read after a corrupted slot returned early; graceful draining resolves that cleanup race. Focused Desktop WAL suite **22/22 PASS**.
- The existing D86 independent child-process `wx+` exclusion and no stale-lock takeover tests, D117 OS-process SIGKILL recovery, D118 inode/hardlink restrictions and D119 fsync proof all continue to run in the broader suite.
- Full Fast **934/934**, Fast repeat **10×934/934** (exit 0, no failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata and package validation PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS; digest exactly matched the reference SHA-256.

## Scope and non-negotiable release blockers

This fences **only operations on the owned WAL storage adapter and release()**. It does not freeze or lock the Obsidian Vault, its editors, other processes operating on user notes, or malicious processes able to interfere with WAL filenames. Windows Node-only directory `fsync EPERM` still does not prove sudden-power-loss durable WAL. Initiating-only atomic Branch/Passphrase/Index cutover, new-key provenance/recovery, numeric-pinned same-repository three-ref live GitHub acceptance and installed Windows/mobile multi-device qualification remain incomplete. Re-encryption Wizard is Preview-only; `docs/release-gates/reencryption-wizard.json` status stays `blocked`.

D90/D91 owner-approved policy remains independent writable old Source, frozen Backup at original SHA, and zero-parent orphan Destination encrypted with a new key, all in the same GitHub repository. No GitHub Actions, Native Helper promotion, branch auto-deletion, release waiver or live user Vault test.
