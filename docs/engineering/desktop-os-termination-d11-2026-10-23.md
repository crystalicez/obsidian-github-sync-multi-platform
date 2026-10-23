# D11 additional evidence — externally terminated child process

Date: 2026-10-23. Audit branch only. **Not production release approval.**

## Scope and isolation

This supplement distinguishes an internally requested `process.exit(91/92)` from termination delivered by a **separate parent process**. It is deliberately narrower than an OS power-loss guarantee.

- `tests/recovery/staged-external-termination.test.mjs` bundles the real Desktop platform I/O and Recovery WAL implementation from `tests/recovery/support/staged-process-kill-child.ts` into a disposable Node child executable.
- `tests/recovery/support/staged-external-terminate-preload.cjs` intercepts only that child process's `node:fs.renameSync`. It invokes the **real rename syscall first**, then synchronously writes a known marker to stdout and blocks its JS thread with `Atomics.wait`.
- On receiving the marker, the parent terminates **only the child it spawned** with `child.kill("SIGKILL")` (Windows: OS process termination), then waits for the process close event.
- A **fresh, separate process** performs the real WAL-based rollback, replay, or stage discard; the parent independently reads target bytes, backup, residue, stage and persisted journal before and after.
- All files are single-digit-byte fixtures under unique `.tmp/native-kill-d11-external-*` paths inside the audit worktree. The preload refuses to operate outside these sandbox paths. No Obsidian.exe, private vault, GitHub remote or GitHub Actions are involved.

## Verification matrix

| External-termination pause point | Required on-disk evidence | Fresh process result |
| --- | --- | --- |
| Commit after `target → backup` | Original backup, staged candidate, WAL; target absent | Original safely restored |
| Commit after `stage → target` | Target is candidate, original backup, WAL lacks receipt | Candidate hash verified, WAL replay completes |
| Rollback after `target → residue` | Candidate residue, original backup, WAL; target absent | Original restored, residue verified and cleared |
| Rollback after `backup → target` | Original target, candidate residue, WAL; backup absent | Both contents reverified, residue cleared |

The focused **external OS termination test passed (exit 0)** and passed **5 additional consecutive runs** (each covers all four commit/rollback cut points). The complementary internal abrupt-exit harness passed including proof-gated preservation when an outside writer altered backup, restored target or residue. The latter was repeated 10 consecutive times with no failure. Following those changes, `pnpm test:fast`, `pnpm test:recovery`, Production Build, Resource, Feasibility, metadata/package validations, GitHub E2E compilation, 10-round Fast repeat and the 100,000,000-byte bounded virtual cryptographic soak all passed.

## What this does not prove

The parent terminates the child **immediately after the rename syscall returned**, while JS is deliberately paused before the next operation. It does **not** simulate sudden power loss while disk write caches hold metadata/data, interruption *inside* a rename syscall, or journal/fsync durability on a remote filesystem. It does not test actual Obsidian editor reentrancy in this run (D8–D10 provided separate native qualification). External OS processes can still change file paths during TOCTOU checks. Slow or network filesystems may stall synchronous renames; platform-specific tests and C2 protocol/UX work remain.

No master merge, release, tag or CI workflow should be initiated on the basis of these results alone.
