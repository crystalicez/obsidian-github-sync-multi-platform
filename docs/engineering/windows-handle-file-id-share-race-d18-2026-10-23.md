# Stage D18 — Windows Native PoC File ID / WAL identity binding and sharing-lock tradeoff

Date: 2026-10-23. **Isolated research only. No production integration, signed binary distribution, plugin architectural selection or release approval.**

## Concrete finding: D17 silently renamed a user-rehomed file

D17 used a *pinned file handle* and rehashed its bytes but did not prove that the handle's **current logical filename still matched the transaction's expected path**. Fail-first on real Windows NT `10.0.26300`: after `READY` but before backup rename, a second actor moved `notes/original.md` to `notes/parked-third-party.md` and replaced `original.md` with an outside symlink. D17 still moved the **user-rehomed** parked object into `original.backup` (outside file untouched). This is not acceptable user-file semantics even though no directory traversal happened. The D18 fail-first regression demanded **rejection and preservation** of the user-rehomed file and failed before the mitigation.

## Two experimental defenses; different tradeoffs

### 1. File ID + logical name + synthetic WAL binding (permissive sharing)

- Added Win32 `GetFileInformationByHandleEx(FileIdInfo=18)`; compares **volume serial number plus all 128 bits of File ID**, not just SHA-256/size/timestamp.
- New native read-only `capture` mode opens each original/staged source under trusted directory handles, checks expected contents, and exports the two OS file IDs. The Node harness persists these IDs and SHA-256 digests in `D18-WAL-INTENT-V2` test-only intent and calls `fsyncSync` before mutations. Each later commit and fresh-process rollback reads the intent through a root handle and checks the **original file IDs** from current pinned source handles, even after a legitimate in-vault rename.
- Before a mutating rename, permissive mode also reopens the expected **logical name relative to the pinned directory**, refuses symlinks, and requires its File ID to match that of the pre-opened source handle. The formerly unsafe original-name-replaced-with-junction/symlink now **rejects without moving any parked user file**.
- Two same-content/different-File-ID attacks are rejected **even when the bytes match SHA-256 exactly**: swap before helper opens (caught against persisted WAL identity), and swap after source opens (caught against the current logical name). The equivalent staged-file swap after original was backed up is refused, preserving original backup and both candidate versions.
- On this local NTFS Windows version, file IDs survived ordinary renames, rollbacks and helper process restarts.

**Critical proven residual:** File ID/name recheck is **not atomic** with the subsequent `NtSetInformationFile` rename. In a deliberately enlarged interleaving between the two calls, the second actor again rehomed the user file. The permissive helper still moved that rehomed object into the backup. This is one explicitly *reproduced unsafe case*, **not a passing containment test**.

### 2. Strict Windows file-share rights (research mode only)

New `commit-locked`/ `commit-locked-gap` modes request `FILE_SHARE_READ` **without** `FILE_SHARE_WRITE` or `FILE_SHARE_DELETE` while holding source handles through both native rename boundaries. Physical Windows results:

- While handles are pinned, a second actor's `renameSync` and `writeFileSync` returned `EBUSY` on local fixture sources.
- At the **same deliberately paused post-proof / pre-rename gap** that still exploits permissive sharing, both external rename and write attempts returned `EBUSY`; the helper then committed original → backup and stage → target successfully.
- If a third-party editor already has a writable handle open, strict mode **cannot open the source** due to sharing violation and safely refuses before mutation.

This supports a strict-share *research direction* on this machine. It is **not a universal mutual exclusion proof** (preexisting handles, antivirus, memory-mapped write access, filesystem drivers, hardlinks, SMB/NAS/cloud/other Windows build differences, changes to the destination directory, and OS crash remain unqualified). Moreover it is a **major compatibility/UX tradeoff**: the native helper could block or be blocked by Obsidian and other apps. It must not be silently enabled for the released plugin; require explicit user decision on locking, retry/defer UX and independent physical validation.

## Verification and evidence accounting

Command: `node scripts/test-windows-native-rename-poc.mjs --repeat=10`.

- **26 different interleaving scenarios × 10 runs = 260 observed cases**, exit code 0.
- **250** verified protective/recovery cases across 25 types: File ID recheck; pre-open ID bound to WAL; stage object swaps; post-proof strict sharing; preexisting editor lock refusal; all prior D17 four kill/restart rollback boundaries; missing/corrupt intent; unexpected file edits; outside symlinks/hardlinks; path-marker root confinement; and original/staged bytes preservation.
- **10** runs of *deliberate unsafe identity-check-to-rename gap* (the 26th type) demonstrate that permissive name/File ID verification **still has a race**. Test runner labels final result `POC_COMPLETE_WITH_PROVEN_RESIDUAL_RACE`, records `protectiveEvidence:250` and `demonstratedKnownUnsafe:10`. Do not call these 10 security successes.
- No external sentinel changed; crash cuts target a disposable native helper after a returned syscall only. Synthetic tests operate on small local fixture files.
- Independent D16 handle-delete PoC `--repeat=2`: **8/8 PASS**.
- Existing product local gates after D18 test-only source changes: Build PASS; Fast **503/503**; Repeat **10 × 503/503**; Recovery **79/79**; Resource **11/11**; Feasibility **132/132**; virtual max 100,000,000-byte soak **1/1**; metadata/package validation PASS; GitHub E2E **compile-only** PASS (3 bundles).
- No network GitHub E2E or native Obsidian run was needed for this stage because D18 did **not** modify `src/`, `package.json`, or any compiled plugin code. D14 1,000-note Windows peer native gate and D15 small peer smoke remain the last production-code evidence.

## Security and correctness boundaries

- Native file-ID source uses the Win32 `FILE_ID_INFO` contract: volume serial + 128-bit file ID; the same ID may not remain stable forever on non-NTFS filesystems; no global uniqueness or collision-resistant authentication is assumed.
- The test-only WAL stores plain strings and can be modified by an actor who can write that file. **This is NOT authenticated WAL**. Its `fsyncSync` does not guarantee persisted directory entries, power-loss durability, real production WAL schema, or the safety of simultaneous local edits. Physical in-syscall crash remains untested.
- Relative `NtSetInformationFile(FileRenameInformation=10)` is an empirically working Windows NT API on one build; Windows Share Mode behavior was reproduced but Windows version/support matrices, mounted volumes and network drives remain unqualified. Do not fall back to absolute path-based deletion/rename on errors.
- OS source mutations and destination replacement are not an atomic multi-file transaction; only proof-gated recoveries *after syscall return* were simulated.
- No native addon, separate process service/IPC, code-signing, release binaries or mobile/macOS/Linux helpers selected or added.
- **User decision needed before production design:** Must a Desktop Sync attempting to modify a note with an active external writable handle *defer and retry with all evidence retained*, rather than allowing permissive rename? The previously approved open-note policy 1 covers Obsidian editor state, but not all writable OS handles from other applications. Any strict locking default/failure UX needs explicit sign-off.

Microsoft API references:
- `FILE_ID_INFO` source: https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
- `GetFileInformationByHandleEx`: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex
- `CreateFile` share-mode interaction: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
- `NtSetInformationFile`: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile

## Continuing release blockers

Full no-follow race closure requires either a verified strict/share-lock contract or other atomic path/name pinning, plus real WAL receipt and directory durability, Windows support matrix and actual SMB/NFS/cloud drive, macOS/Linux/mobile, signing and deployment review, C2/migration and line-level merge UX. Stage D18 is only an isolated PoC. Do not integrate or ship it.
