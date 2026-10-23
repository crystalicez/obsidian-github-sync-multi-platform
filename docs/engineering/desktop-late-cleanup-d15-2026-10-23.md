# Stage D15 — Desktop WAL backup and residue cleanup: close avoidable asynchronous junction-swap gap

Date: 2026-10-23. Isolated audit branch only; **not a production or OS-handle-race qualification**.

## Risk and physical fail-first experiment

D12 added synchronous symlink/junction component checks directly before each sensitive `renameSync`. D15 independently audited what happened **after** a verified rollback or WAL receipt: `finalizeStage` and `rollbackStage` still used `await fs.rm(...)` after asynchronously hashing/proving files, with **no renewed containment check** directly before removing the original backup or the plugin-owned replacement residue.

The deterministic physical Windows tests in `tests/v4/staged-desktop-io-containment.test.ts` use disposable real filesystem directories, native `renameSync`, native Windows junctions, and a temporary test-only `node:fs/promises.stat` intercept synchronized to ESM via `syncBuiltinESMExports()`. Each intercept returns the *real* preceding stat, then swaps a proved in-vault parent into a junction to an external disposable directory in the last async validation window. All monkeypatches and test fixtures are restored/removed in `finally` and the test aborts/skips if junctions are unavailable.

- `D15 finalizeStage`: after the final verified target hash's last `stat`, swap `notes` to a junction with an outside file named `stage.bin.target-backup`. **RED** without the renewed guard: finalizer returned successfully despite the late swap. **GREEN** with guard: rejects as unsafe, preserves original backup under renamed local parent *and* the outside sentinel bytes.
- `D15 rollbackStage`: with proven restored original and leftover plugin residue but **no original backup**, swap the parent at the last original hash `stat`. **RED** before the guard: rollback succeeded despite the late junction. **GREEN** after: rejects unsafe, preserves original local target, plugin residue, and outside sentinel bytes.

Both tests prove real junction injection and the original unguarded success, not simulated-memory IO. They are adversarial unit tests, not evidence of complete OS race freedom.

## Narrow change and safety contract

`src/lib/v4/platform-io.ts`:
- `finalizeStage()` now obtains the cached synchronous Node filesystem/path modules before starting content verification. Just before deleting the verified backup, rechecks `stage/backup/residue/target` components with existing `assertRecoveryPathsSync`, then executes `rmSync(backup)` **without an intervening JavaScript await**.
- `rollbackStage()` similarly rechecks all four components and synchronously removes only the *previously proven plugin-owned* residue in both the post-restoration and interrupted-restoration cleanup paths.
- All SHA-256, size/mtime evidence checks and the original commit/recovery WAL receipt policy are untouched. On an unsafe late junction the code throws and preserves files for manual review instead of silently deleting outside vault. No new user override, no remote protocol/encryption/settings changes.

**Residual limitations:** `lstatSync` and `rmSync` are separate OS operations; a privileged concurrent external process can still substitute a directory in between them. Node's path-based APIs do not supply cross-platform `openat2`/Windows handle-relative atomic no-follow removal here. This hardening closes the demonstrable **async** gap, not the full OS TOCTOU release blocker. New sync `rmSync` can block Electron briefly on a slow/network filesystem; it is confined to a single backup/residue cleanup entry rather than hashing content, which remains asynchronous. True UNC/SMB/NFS latency and durability are unqualified; user-selected Network Drive best-effort policy B remains unchanged.

## Acceptance gates

On D15 code:
- Physical fail-first/green Desktop containment suite: **14/14 PASS** (D15 2 new).
- `pnpm build`: PASS.
- `pnpm test:fast`: **503/503 PASS**.
- `pnpm test:repeat`: **10 × 503/503 PASS**.
- `pnpm test:recovery`: **79/79 PASS** (includes D11 external Windows process kill/WAL interruption).
- `pnpm test:resource`: **11/11 PASS**.
- `pnpm test:feasibility`: **132/132 PASS**.
- Bounded virtual cryptographic `pnpm test:soak`: **1/1 PASS**, 100,000,000 bytes simulated, no >100 MB physical fixture.
- Metadata/package validation and 3 GitHub E2E bundle compilations PASS; compile-only not live repo acceptance.
- *Native two-instance disposable Windows Obsidian encrypted small-journey test:* pending; update with actual result if executed.

## Next release qualifications

Atomic OS directory-handle no-follow mutation and cross-process adversarial race, real network drive latency/crash durability, physical macOS/Linux/iOS/Android, C2 remote layout/historical compatibility and line-level merge UX. No `master` merge, GitHub Actions, release/tag, personal vault mutation or unsafe file-size test.
