# D85 — Isolated backup restore rehearsal with independent scratch readback

Date: 2026-10-26 (Asia/Bangkok). Based on clean/pushed D84 `2e6c5ca748477fcbf67bc154b8d23e1cb904167b`. Worktree `.worktrees/d85-isolated-restore-rehearsal`, branch `audit/2026-10-26-d85-isolated-restore-rehearsal`.

## Why this stage

D84 validates that an *asserted* backup snapshot's bytes match a complete authenticated source inventory, but does **not** exercise restore write-paths. A backup with readable source bytes can still fail when copied to new storage, be silently altered on write, or fail on re-open/readback. D85 tests the scratch restore pipeline **without selecting a real backup provider or touching the active Obsidian vault**. D85 also deliberately does not pretend the backup is physically/logically independent of its original GitHub repo.

## Implementation

`src/lib/v4/reencryption-restore-rehearsal.ts` exports `verifyV4ReencryptionBackupRestoreRehearsal` with:

- A D84 `V4ReencryptionBackupReadbackInput` already bound to the exact source commit, a user-provided `V4StagingStore` as a **separate, isolated scratch destination**, and an explicit `assertScratchIsIsolated()` guard. The guard must be implemented by a trusted adapter; it is **not proof** of isolation when mocked or supplied as a no-op.
- D84's **complete source authenticated metadata + every-file backup byte/hash check finishes before ANY scratch stage is created**. Missing/extra/corrupted files, invalid paths, source SHA/backup ID changes and cancellation fail closed.
- For each original live source file, re-check backup snapshot and source HEAD, open backup content again, stream in <=1 MiB chunks through the production V4 staged sink, independently SHA-256 hash source bytes and require the original hash before `finish()`.
- Re-open the newly staged bytes with `scratch.open`, hash/read the restored bytes **a second time** with the same size/bounded stream checks, require SHA-256 match against authenticated source record, then remove the staged scratch file. Each file is processed serially and deleted before the next. Empty, Unicode, binary and encrypted-remote-multipart-*sized* logical files are included.
- On ordinary failure, `sink.abort()` attempts to remove unfinished stages; after finish, `scratch.remove()` is required even on readback failure. Cleanup errors propagate rather than silently reporting success. Process crashes can still leave scratch residue and require a separate safe cleanup protocol.
- Final snapshot/HEAD observations and BigInt file/byte totals match D84 readback. Output is frozen and redacted: `integrityScope:"isolated-scratch-restore-roundtrip-only"`, `scratchReadbackMatched:true`, and **`independentStorageVerified:false`, `installedObsidianRestoreVerified:false`, `permissionToPublish:false`, `cutoverAuthorized:false`**.

## Tests

Added five D85 test cases to `tests/v4/reencryption-backup-readback.test.ts` alongside ten existing D84 tests:

1. Positive **four-file** full-vault restore with Unicode, binary, zero-byte and 8 MiB+17 byte source; verify per-file hash and scratch cleanup.
2. A corrupt backup is rejected **before any scratch write**.
3. Corrupt scratch readback fails and cleans the stage.
4. Snapshot changed while staging, injected scratch disk write failure, and rejected scratch-isolation guard all fail without claiming success.
5. A genuine **Windows/Node filesystem sandbox** under this isolated worktree's `.tmp/d85-sandbox-*`: write files, append, close, independently re-read bytes by file path, verify SHA-256, and ensure all scratch files are removed. Only test-owned scratch is deleted; all physical data is well below the owner-requested 100 MB test ceiling.

All tests use a simulation for backup/source. The Windows OS filesystem smoke test is a real disk I/O round trip for staged bytes; it does **not** test native Obsidian's restored vault, physical independent backup media, crash-durable fsync, cross-process locks, mobile suspension, or persisted snapshot provenance. V4StagingStore's store writer and the injected scratch guard are trusted boundary conditions; D85 does not yet provide a secure platform path resolver/retention policy.

Offline frozen pnpm install, max strict `pnpm build`, full fast/resource/recovery/feasibility suites and E2E 3-bundle **compile-only**, metadata/package validation and Git staged diff checks must pass before commit. No GitHub Actions, live GitHub E2E mutation, re-encryption migration ref publication, active vault writes or device settings changes in D85.

## First-release boundary and next work

D66 `docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`: only `ownerApprovedMigrationTopology:"passed"` and **six other acceptance gates pending**. A scratch restore must **not** satisfy `safePreviewAndBackup` or `nativeDesktopAndMobileAcceptance`.

Owner-approved A = new zero-parent orphan branch within the same physical repo, retain old source for recovery; an independent second installed Obsidian instance must be tested before cutover. Still awaiting owner decision whether **all devices on old branch pause Sync** throughout migration/until individually switched (recommended) or require deliberate reconciliation; no policy silently chosen.

**Next safe step:** platform-owned **physically separate independent backup adapter** with checked paths and full restore on a disposable *actual* Obsidian vault; persistence/atomic write and crash-injection testing for D80 WAL and cross-process locks. Do not automatically publish migration or overwrite any user files without the remaining explicit safeguards.
