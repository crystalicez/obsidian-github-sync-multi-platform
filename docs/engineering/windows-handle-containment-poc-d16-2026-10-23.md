# D16 — Windows Handle-Based No-Follow PoC (test only)

**2026-10-23; NOT approved for production integration or binary distribution.**

## Scope

User approved only researching and testing a native OS helper in isolated worktree `.tmp/staged-production-6c67c8a` on audit branch. No production source, package scripts, release, master, GitHub Actions, user vaults, account credentials or network services are touched.

- Test-only C# P/Invoke code: `poc/windows-handle-no-follow/HandleProbe.cs`.
- Manual-only runner (not auto-discovered): `node scripts/test-windows-native-handle-poc.mjs --repeat=10`.
- C# uses existing Windows .NET Framework `csc.exe`; generates `HandleProbe.exe` only inside ignored `.tmp/d16-native-build-*` and deletes it in runner `finally`. No binary checked in.
- All test vaults/external sentinels are randomly named `.tmp/d16-native-root-*` and `.tmp/d16-native-outside-*` in the isolated audit worktree. The helper rejects any root without a `d16-native-root-` basename plus explicit `.d16-poc-only` marker and only operates on the fixed synthetic `notes/sentinel.bin`. Parent and file are genuinely renamed/replaced by a separate Node process at a `READY` / `GO` process barrier.

## Native calls & trust model

Win32 `CreateFileW` opens the test root as a directory with `FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT`. `NtCreateFile` opens one child directory/file component relative to the previously opened `OBJECT_ATTRIBUTES.RootDirectory` handle, with `OBJ_DONT_REPARSE`, `FILE_OPEN_REPARSE_POINT` and `GetFileInformationByHandleEx(FileAttributeTagInfo)` rejection of reparse handles. Leaf opens request DELETE permission. `SetFileInformationByHandle(FileDispositionInfo)` deletes the already pinned file object, not a path that might have changed. No path-based fallback is implemented. Multi-component traversal, dot-dot, slash, colon and alternate stream names are refused.

## Physical results

Host: Windows NT **10.0.26300**, x64, actual local filesystem. **40/40 PASS**: 10 repetitions of each scenario.

| Adversarial event | Observed outcome |
|---|---|
| Trusted root handle opened, `notes` replaced by outside junction before child open | Reparse rejected; original parked file and outside bytes unchanged |
| Trusted `notes` directory handle opened, file renamed then replaced with symlink to outside before child open | Reparse rejected; parked file and outside unchanged |
| Root/parent/file handles opened, parent rename attempted, file renamed and symlinked to outside before handle-only delete | Parent rename blocked with **EPERM**; file rename/symlink permitted; handle deletion removed original parked file while **outside sentinel was untouched** |
| Outside directory junction existed before child open | Reparse refused, outside unchanged |

The initial parent-only attempt could not simulate an actual swap because Windows returned `EPERM` while the directory/file handles were pinned; it was replaced with the four more specific scenarios above. A preliminary test assertion accidentally inspected the new junction instead of the parked original; corrected before 40/40 green repetitions.

## Safety limits — not qualified for release

Empirical behavior is **not** a proof of atomic staged rename/replace or WAL durability. The PoC intentionally does **not** implement `FILE_RENAME_INFO.RootDirectory` relative rename, rollback, content/hash proof tied to a file ID, crash injection, atomic no-follow across all reparse tags, hardlink protection, external file identity, antivirus/oplock behavior, Windows older versions/ARM64, actual SMB/NFS, cloud volumes, root junction compatibility, runtime performance or macOS/Linux/mobile. A directory/file may change *inside* a pinned root, so user edits and WAL receipt ordering still require proof-gating. Do not reduce original backup retention.

`OBJ_DONT_REPARSE` is documented for `OBJECT_ATTRIBUTES`, but the user-mode `NtCreateFile` contract is not unambiguously stated by all Microsoft references. The single Windows build tested here does not guarantee portability. Node/Obsidian plugin does **not** execute the helper.

Cross-platform investigation only (not built): Linux `openat2` + `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS` with dirfd and `renameat2`/`unlinkat`; macOS `openat` with `O_NOFOLLOW` per path component and `renameat`/`unlinkat`. Mobile native helper availability is not assumed.

Architecture decisions **deferred to user**: (1) a separate restricted-IPC, signed Windows helper executable vs (2) a native Node/Electron addon, and explicit unsupported-platform fallback. These require installation, signing, supported OS/build matrices, safe handle identity + hash, crash/WAL correctness, and native build QA. No integration or distribution is authorized by D16.

## References

- https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
- https://man7.org/linux/man-pages/man2/openat2.2.html
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html

**Next acceptance needed:** verify no release contamination, complete existing local tests, keep 100MB fixture cap, update real `HANDOFF-NEXT-SESSION.md`, audit-only commit/push and exact-remote SHA check. Remaining OS-handle TOCTOU production blocker stays OPEN.
