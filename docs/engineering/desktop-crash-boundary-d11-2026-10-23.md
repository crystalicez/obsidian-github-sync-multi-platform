# D11 — Desktop staged rename process-termination qualification

Date: 2026-10-23. **Audit branch only; NOT a production release approval.**

## Purpose and exact scope

Exercise the *real* Node Desktop `V4PlatformIo.commitStage` /
`rollbackStage` and persisted `V4RecoveryStore` across abrupt child-process
termination, with physical Windows filesystem files (not an in-memory fake).

Harness:
- `tests/recovery/staged-process-kill.test.mjs` builds
  `tests/recovery/support/staged-process-kill-child.ts` into a CommonJS
  bundle in a unique, disposable `.tmp/native-kill-d11-*` directory.
- The child patches only its **own** `node:fs.renameSync` to invoke the
  **real** filesystem rename and then call `process.exit(91|92)` before
  any subsequent JavaScript, WAL receipt, catch/finally, or file cleanup.
- `spawnSync` verifies the exact child exit code and independently inspects
  byte-for-byte target, backup, staged object and WAL slot files.
- A **new child process** runs the actual recovery/discard routines, without
  retaining the killed process's memory. Each fixture uses single-digit-byte
  files, never a user vault, never a real GitHub repo, and is deleted on exit.
- The standalone `.test.mjs` is auto-discovered by `pnpm test:recovery`.
- A second auto-discovered test, `tests/recovery/staged-external-termination.test.mjs`, uses child-only preload `tests/recovery/support/staged-external-terminate-preload.cjs`. The child performs an actual `renameSync`, writes a post-syscall handshake and blocks with `Atomics.wait`; its parent sends **external SIGKILL / Windows TerminateProcess**. Fresh processes recover all four boundary states. This supplements the `process.exit()` fault injection, while still not simulating power loss inside a syscall.

## Boundary matrix

| Cut point | Immediate filesystem state after exit | Fresh-process outcome |
| --- | --- | --- |
| Commit after `target → .target-backup` | Original in backup; target absent; staged bytes preserved; WAL present | Proof-gated rollback restores original and removes plugin stage |
| Commit after `stage → target` | Remote candidate in target; original in backup; WAL lacks receipt | Recovery verifies candidate bytes, saves receipt and clears verified backup |
| Rollback after `target → .replacement-residue` | Candidate parked as residue; original still in backup; target absent | Fresh rollback verifies and restores original, clears verified residue |
| Rollback after `backup → target` | Original restored; backup absent; remote candidate in residue | Fresh rollback verifies **both** original target (size, rounded mtime, SHA-256) and residue (size, SHA-256), then clears residue |

### Additional crash boundary: stage returned before WAL receipt

The original implementation deleted `.target-backup` inside `commitStage()` *before* its caller persisted the WAL receipt. A fail-first test showed the original was already gone when the returned commit had not yet been receipted. This is unsafe for a user-requested abort or interrupted journal persistence. D11 retains the original until `finalizeStage()` verifies the target and backup after durable receipt. The direct, no-WAL large-file pull path explicitly finalizes on success.

A child is now terminated with exit 93 **after `commitStage()` returned but before WAL receipt**. Two fresh-process paths were verified: abort/discard restores the original; replay records a receipt and retains the new remote candidate. The backup is cleared only after either proof-gated outcome.

### Fail-first finding and fix

The fourth row **failed before the change** with
`V4ManualRecoveryRequiredError: rollback residue exists without its original backup`,
even though both retained physical files still matched their WAL proofs.

`src/lib/v4/platform-io.ts` now accepts this narrowly proven terminal
rollback state. It does **not** overwrite or delete the user's target:
only the verified plugin-owned residue is removed, after re-verifying the
restored original. Any missing hash, modified target or modified residue
still raises `V4ManualRecoveryRequiredError`, preserving both files.
`tests/recovery/staged-crash-backup-orchestration.test.ts` adds these
positive and negative proof gates.

### Second fail-first finding: backup must outlive the WAL receipt

A separate D11 regression failed on the original Desktop implementation:
`commitStage` removed `.target-backup` after verifying replacement bytes,
**before** the caller successfully persisted its per-file WAL completion receipt.
If receipt persistence fails at this point, the plugin has already discarded
the proof-backed original needed for an abort decision.

The Desktop commit now **retains the original backup** after a successful
swap. `applyV4RecoveryLocalMutations` saves a durable WAL receipt first,
then calls `finalizeStage`, which verifies original backup SHA-256 and
candidate target SHA-256 before removing the backup. If the receipt fails,
the original backup remains available for proof-gated rollback or subsequent
reconciliation. The direct no-WAL large-file Pull path also explicitly
finalizes after its successful commit **before** marking the mutation
complete instead of leaving an orphan backup. An additional fail-first
Sync session test establishes the order `commit → finalize → completed`.

The process-termination harness additionally exits **after `commitStage`
returns but before any WAL receipt**. From a new process, both (a) discard
restores the original and (b) resume verifies the committed candidate and
records a durable receipt. A further fault matrix modifies independently
the restored original, parked candidate or original backup **after** process
exit; every case fails closed, leaving all bytes and WAL evidence untouched.

## Qualification

- Four real child-process rename boundaries plus two after-commit/before-receipt recovery choices: PASS (exit 0 test).
- Four additional **externally terminated child processes** after real rename return, fresh-process WAL recovery: PASS. Changed-evidence post-crash cases also fail closed without modifying user files.
- Focused filesystem recovery regressions: 17/17 PASS (including same-size/same-mtime hash tampering and WAL backup retention).
- `pnpm build`, full Fast, full Recovery, 10x Repeat Fast, Resource,
  Feasibility, 100,000,000-byte bounded virtual cryptographic soak,
  metadata/package validations and GitHub E2E **compile-only**: PASS.
- No GitHub Actions, no source branch mutation outside the isolated audit
  worktree, no actual Obsidian.exe process was killed in the crash harness.
- Separately, the final D11 bundle SHA-256 `fe91b08208ffd1a96468aa34a5a4d7d6dd9baa3ff536af2ccb6a49e0bdb03a68` was installed in **two disposable native Windows Obsidian 1.14.4 instances**. Live GitHub encrypted A→B Force Push/Pull, A update, B open-note conflict modal, close and resume passed with `allCorrect:true`, `openEditorModalVisible:true`, `destructiveOverrideShown:false`, and verified disposable branch cleanup. No personal vault or user Obsidian process was touched.

## Limits that remain

This proves recovery when the child is terminated **immediately after**
each real rename call returned. It **does not** simulate power loss before
filesystem metadata or data reached stable storage, OS crash within the
rename syscall, actual Obsidian renderer process state, delayed network
filesystem metadata updates, or a malicious outside process swapping path
components during a path-check/rename TOCTOU gap.

Outstanding release gates: slow/network filesystem latency for synchronous
renames, external editor/file handle race, symlink/junction defense at the
OS-handle boundary, Windows native 1000-note encrypted lifecycle on this
candidate, physical macOS/Linux/mobile, and C2 protocol/merge UX acceptance.
