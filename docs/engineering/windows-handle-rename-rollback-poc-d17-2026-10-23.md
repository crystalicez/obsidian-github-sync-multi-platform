# D17 — Windows handle-relative rename / rollback and process-interruption PoC

Date: 2026-10-23. **Experimental only** on the isolated audit worktree. User authorized proof beyond D16 but **not** production integration, adding/signing/shipping native executables, changing WAL/remote format, or selecting helper-process vs Electron addon architecture.

## Scope and implementation

- New test-only C# P/Invoke `poc/windows-handle-no-follow/RenameProbe.cs`. It is compiled with the installed Windows .NET Framework C# compiler by **manual-only** `scripts/test-windows-native-rename-poc.mjs`. The resulting executable lives exclusively under ignored `.tmp/d17-native-build-*` and is removed in `finally`. It is not part of `src/`, `package.json`, Obsidian's main bundle or release packaging.
- Strict synthetic root only: randomized `.tmp/d17-native-root-*` plus marker `.d17-poc-only`. Hardcoded `notes/original.md`, `notes/candidate.stage`, `notes/original.backup`, `notes/replacement.residue`. Another random `.tmp/d17-native-outside-*` contains a canary that is compared byte-for-byte before cleanup. No user vaults, real GitHub repo, credentials, service, or arbitrary path input.
- Native helper opens trusted root via `CreateFileW` (no reparse); each single child directory/file via `NtCreateFile(OBJECT_ATTRIBUTES.RootDirectory=held_parent_handle)`, `OBJ_DONT_REPARSE`, `FILE_OPEN_REPARSE_POINT` and file-attribute reparse rejection. Opens sources with `DELETE` and read rights; hashes bytes actually read from a **pinned file handle** with SHA-256 after rewinding via `SetFilePointerEx`. 4096-byte fixture cap.
- Rename by `NtSetInformationFile(FileRenameInformation=10)` with x64 `FILE_RENAME_INFORMATION.RootDirectory` set to the open destination directory handle. Only safe single-component destination names, with `ReplaceIfExists=FALSE`; existing file/symlink/hardlink is a hard failure. No absolute-path fallback, no automatic replacement, no direct `rmSync` in helper.
- Synthetic test WAL intent `.wal-intent-d17` contains fixed-version original/stage SHA-256 values, written and **fsync'd before mutation** by the Node harness. Every fresh native process reads it via the pinned root handle and verifies exact expected contents. This simulates a persistent, proof-bearing intent; it **does not** implement the plugin's real WAL file/directory fsync ordering or durability protocol.
- Transaction steps: original → backup, pause; candidate → original, pause; retain backup. Rollback verifies pinned hashes; if candidate is installed, parks candidate → replacement.residue, pause, then backup → original, pause. A separate fresh process recovers after a killed child. Residue is **retained** rather than silently deleted. Missing/corrupt WAL, unexpected edits and symlinks require manual review.

## Real Windows evidence

Host: Windows NT `10.0.26300` x64, local filesystem. Run `node scripts/test-windows-native-rename-poc.mjs --repeat=10`.

**180/180 cases passed = 18 separate adversarial cases × 10 rounds**, each in a new disposable root, with persistent evidence reads and external sentinel equality verification:

1. Normal backup-then-publish retains complete provable original backup.
2. Kill child after `original→backup`, restart fresh rollback: restores original, retains untouched candidate stage.
3. Kill child after `candidate→original`, restart rollback: restores original and parks verified replacement residue.
4. Full rollback returns original and retains candidate residue.
5. Kill child just after `candidate→residue`, restart rollback: restores original, retains residue.
6. Kill child just after `backup→original`, restart recovery: verifies original and residue in final state.
7. Missing fsync'd test WAL intent after commit: recovery refuses; candidate and backup unchanged.
8. Corrupt test WAL intent after commit: recovery refuses; candidate and backup unchanged.
9. Stage modified after backup rename: commit/recovery refuse and preserve backup and edited stage.
10. Backup modified after successful commit: rollback refuses, preserves edited backup and published candidate.
11. Attempt to rename a held parent directory: observe Windows handle behavior and preserve external canary (parent rename was blocked by Windows in D16 on this same host).
12. Local published target independently modified: rollback refuses, preserves local edit plus backup.
13. Symlink inserted at backup destination before commit: no-overwrite rename refuses, no external mutation.
14. Hardlink inserted at backup destination before commit: no-overwrite rename refuses, no external mutation.
15. Symlink inserted at original destination between backup and publish: commit refuses; recovery refuses without replacing outside sentinel, backup retained for review.
16. Source leaf renamed and replaced by an outside symlink after native handle open: handle-based move affects original held file, **not** outside sentinel; subsequent recovery fails closed because name evidence is now inconsistent.
17. Original independently edited between initial and final native pinned proof: commit refuses without mutating stage/backup.
18. A spoofed marker and matching root prefix placed *outside* the compiled helper's own ignored audit `.tmp` parent is refused before opening a child file; correct real fixture remains intact.

The harness captures `CUT:BACKUP`, `CUT:PUBLISH`, `CUT:PARK`, `CUT:RESTORE` **after the relevant native rename call returns** and terminates the whole test helper process at each cut. This establishes recovery from external process termination across those boundaries. It does **not** simulate power removal inside a system call, metadata flush completion, journal-directory durability, torn writes, or all possible instruction-level interleavings. The tests do not assert the production WAL schema's safety.

## Important observations and residual security problems

1. `NtSetInformationFile` with `RootDirectory` did perform the relative operation on this Windows version. A contemporary compatibility report found Win32 `SetFileInformationByHandle(FileRenameInfo)` with non-null root rejected (`ERROR_INVALID_PARAMETER`), hence D17 never falls back to a full pathname; using the native NT API is a **prototype**, not a supported matrix guarantee.
2. Native pinned source handles prevent a substituted symlink at the same *name* from redirecting the rename outside the pinned directory. **However** an external process can rename/move the held source file after it is opened: the helper still acts on that original *object*. Preventing an unwanted operation on a user's renamed file requires explicit path+file-ID+version/WAL binding and concurrent mutation policy beyond this experiment.
3. Source/destination metadata checks and hash proof still comprise multiple OS calls; an attacker modifying the **same open file's bytes** just after proof is not excluded. Hardlink identity, alternate data streams, foreign volumes, oplocks/antivirus, all reparse tags and all Windows versions are unqualified.
4. The fixture's small content, exact filename constraints and synthetic pre-fsynced intent are deliberately narrower than real Desktop WAL. The native PoC has **no code** for WAL publish receipts/finalization, USB unplug, file/dir fsync after rename, antivirus/crash durability or open-editor checks. It must not replace production staging.
5. SMB2 FileRenameInformation specifies `RootDirectory` must be zero for network operations. Native directory-handle rename on an SMB/network vault is **not qualified**, which matters because the user approved Network Drive policy B (best effort).
6. Linux `openat2 + renameat2`, macOS `openat + renameat`, mobile adapters and signing/deployability remain research only. No native integration or architectural choice authorized.

## References

- Microsoft native `NtSetInformationFile(FileRenameInformation=10)`: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile
- Microsoft `FILE_RENAME_INFO` Win32 root directory: https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
- Microsoft SMB2 FileRenameInformation and RootDirectory=0: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/52aa0b70-8094-4971-862d-79793f41e6a8
- Microsoft file cache / metadata flush and power loss: https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching
- Real user-mode rename incompatibility report: https://github.com/PIHC-Team/ParaDev/issues/1

## Final CI-less local checks and artifact hygiene

Executed in the isolated worktree without enabling GitHub Actions or running real GitHub E2E:
- D17 manual native PoC `node scripts/test-windows-native-rename-poc.mjs --repeat=10`: **180/180 PASS**.
- D16 independent older handle-delete PoC `node scripts/test-windows-native-handle-poc.mjs --repeat=2`: **8/8 PASS**.
- `pnpm build`: PASS.
- `pnpm test:fast`: **503/503 PASS**.
- `pnpm test:repeat`: **10 × 503/503 PASS**.
- `pnpm test:recovery`: **79/79 PASS**.
- `pnpm test:resource`: **11/11 PASS**.
- `pnpm test:feasibility`: **132/132 PASS**.
- `pnpm test:soak`: **1/1 PASS**, virtual stream exactly 100,000,000 bytes (not a physical 100MB file).
- `pnpm validate:package`, `pnpm validate:metadata`: PASS.
- `pnpm test:github-e2e:compile`: PASS; **compile-only**, not live GitHub.
- `git ls-files -- '*.exe' '*.dll' '*.node'`: empty; ignored `.tmp` has **0** remaining `d17-native-*` directories after run.
- Original checkout at the top-level repository unchanged, including the user's untracked `AGENTS.md`.

The PoC's native calls and its 170 tests are not included in `test:fast`, Obsidian's bundle, or distributed packages. This is deliberate: a successful Windows-only research executable must not silently become a release dependency.

## Next gates / user consent

- **Do not integrate into production.** Before picking a signed separate helper vs native Node/Electron addon and fallback policy, ask the user explicitly.
- Needed: real plugin WAL serialization and receipts, inode/file-ID binding, rollback after *inside*-syscall power cuts, directory metadata durability, file and directory fsync, physical SMB and OS matrix, macOS/Linux/mobile, code signing and package/install security.
- Existing D15 path-based mitigation remains the active plugin behavior. D14 1,000-note native encrypted A→B and D15 small native smoke remain the latest integration evidence; **D17 never touched the Obsidian plugin**.
