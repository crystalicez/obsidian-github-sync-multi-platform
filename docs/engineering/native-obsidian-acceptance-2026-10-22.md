# Native Obsidian D6 acceptance — 2026-10-22 (Windows)

## Stage D10 — two native Obsidian instances, encrypted GitHub, and persisted WAL after restart

- Windows **Obsidian 1.14.4**, Plugin built from the audit D10 candidate; isolated disposable vaults `vault-e` and `vault-f` with independent Electron profiles and localhost renderer CDP ports 9241/9242. Credential values and temporary encryption passphrase were not logged. GitHub destination verified by pinned numeric repository ID **1284153873**, each unique branch absent before creation, all branch deletions verified afterward.
- **Live pre-fix repro:** A encrypted Force Push → B Force Pull → A encrypted update → B normal Sync. B originally failed with `V4LocalTargetChangedError` instead of open-note protection. First cause: Desktop `Math.trunc(fs.stat.mtimeMs)` could differ from Obsidian adapter by one millisecond on actual NTFS. Second independent cause: planner `change.before` represented the remote/base file's timestamp rather than the actual unchanged local device's staged-file physical timestamp. Changing only the rounding did not solve the second issue.
- **After fixing both:** A encrypted Push, B encrypted Pull, A normal encrypted Push, B open-note veto `V4OpenEditorConflictError`, B closes note and normal Sync recovers exact remote bytes. No destructive edit. In native UI the `Open note needs review` modal referenced the affected note and contained `Keep files unchanged`, with no force-overwrite button.
- **Recovery durability:** B's blocked Pull preserved two recovery WAL slots and one staged binary; managed B process stopped, same profile reopened, journal and stage persisted, user note still original. After closing the pane, native normal Sync replayed the pending write and cleaned consumed stage **1 → 0**. Test branch deleted, verified absent.
- **Unit safety:** Live-scanned local snapshot with SHA-256 now provides Pull preconditions for modify, delete and rename. Original-content mutation after scan remains hash-rejected. D10 fail-first tests demonstrate both the fractional NTFS mtime mismatch and stale-base-precondition failure.
- **Final-bundle rerun:** Exact final D10 candidate `main.js` SHA-256 `550debd56549d5c7b1149652f5e40b4a13c3c4a877a35b75a6ccadc41d75549a`: full encrypted two-instance sync, guarded editor conflict modal and later recovery successful (`allCorrect:true`, branch `cleanup:true`), after the additional non-WAL former-path rename fix. Separate `sync-session.test.ts` exercises a local mtime discrepancy for that direct rename path.
- **Not yet proven:** Crash exactly between the two `renameSync` calls, cross-process filesystem races, network volumes/slow synchronous metadata operations, mobile/macOS/Linux, and full 1000-note GUI lifecycle. Native E2E harness remains a throwaway ignored driver rather than a checked-in portable acceptance test.

## Stage D9 — no renderer-yield between Desktop filesystem renames

- **Baseline issue:** D8 guards were checked before `await fs.rename`, but the promise could yield before the OS rename and a user might open an editor during that interval.
- **Mitigation:** Desktop uses `fs.renameSync` only for metadata renames in its critical stage replace and rollback; the editor guard runs before these calls. File hashing/reads and network I/O remain asynchronous. This removes the renderer event-loop gap during the rename pair, while external processes and abrupt OS kills remain outside that guarantee.
- **Tests:** D9 contract tests for commit/rollback first failed with async rename and passed after the fix. Crash and Recovery regression suites green, and real Windows Obsidian 1.14.4 disposable plugin tests passed again: clean/dirty editor protection, new staged creation, closed note replacement with watcher create/modify and correct bytes/stage cleanup.
- **Tradeoff:** A networked or unusually slow filesystem may block renderer briefly during synchronous metadata operations; quantify this with native timing before production release. No change to the approved policy 1 or pinned-credentials policy B.

## Stage D8 — approved fail-closed open-editor policy (follow-up, 2026-10-22)

**User decision:** Choose policy **1**. Never automatically overwrite or trash a local note with pending editor changes. Because Obsidian may change a clean buffer during asynchronous filesystem verification, the runtime now conservatively pauses *all* staged write, normal write, trash, and staged rollback operations for any note currently open in an Obsidian workspace file leaf (even if its editor appears clean). Saving and closing the note before retry is required. The earlier Settings **policy B** (an active Sync continues with its original credentials) is unrelated and preserved.

**Implementation:** `src/lib/v4/runtime.ts` throws `V4OpenEditorConflictError` at the local mutation boundary and offers a dedicated review modal at the Sync error boundary. `src/lib/v4/platform-io.ts` accepts a synchronous `assertNoOpenEditor` callback and rechecks immediately before each filesystem rename; if the editor becomes open after the original file was moved into a backup, the commit attempts proof-gated restoration and retains the staged object and pending WAL. No destructive override button was introduced. Path comparisons use case-insensitive NFC normalization for safety, including on Windows. This does not change remote storage format or Mobile platform IO.

**Red-to-green regression:** Added `tests/v4/runtime-dirty-editor.test.ts` (dirty buffer, clean open file, trash veto, and write after closing note), `tests/recovery/staged-crash-backup-orchestration.test.ts` race where an editor appears after the first filesystem rename, and `tests/recovery/v4-crash-matrix.test.ts` preservation of a published but unapplied WAL/stage. Initial dirty/clean/deletion tests failed before the fix and passed after.

**Real native Obsidian qualification:** On the *same isolated* Obsidian 1.14.4 Windows profile and disposable vault documented below, rebuilt and verified the final candidate bundle SHA-256 `57C4220676593C7D12232ABCD3DD0EE190ECA0A8797ADDE21F3169E188BB0102`. Driving the real loaded plugin via CDP verified:
- **Dirty editor:** editor buffer `USER_DIRTY_UNSAVED_EDIT` survived, physical file retained `BASE_CONTENT` after 1.4s, zero modify events, `V4OpenEditorConflictError` returned, and staged remote bytes remained available (exit 0).
- **Clean open editor:** mutation was also vetoed; original disk and editor contents unchanged, zero modify events and stage preserved (exit 0).
- Both tests invoked the actual **`V4PluginRuntime.sessionVault().commitStage`**, rather than bypassing the runtime guard by invoking bare platform IO. Obsidian test process stopped and no personal vault was accessed.

**Final automated gates:** Focused editor tests 4/4; WAL race and pending-recovery receipt preservation both PASS; Fast, 10x Repeat Fast, Recovery, Resource, Feasibility, 100,000,000-byte virtual soak, Production Build, metadata/package validation and GitHub E2E compilation PASS. Credentialed GitHub mutation tests were not repeated on the D8 candidate (E1 live 3/3 results belong to an earlier candidate).

**Remaining limits:** This protects the real runtime mutation route but does **not yet** prove that all end-to-end GitHub Sync UI scenarios, open-pane transitions or a file edit exactly after the last synchronous guard and while an OS rename is pending are impossible. A true Editor/Filesystem lock would close this final race; real two-instance live Sync must be tested before production approval. A direct internal `platformIo.commitStage` invocation without the callback is not an approved production entry point. Historical D6 failure below remains a valid fail-first repro against the previous build.

---


**Historical D6 baseline was BLOCKED by reproducible unsaved editor buffer loss. Stage D8 now blocks this real runtime path; broader release qualification remains incomplete. Do not release yet.**

## Proven execution environment

- Obsidian **1.14.4** installed at `C:\Program Files\Obsidian\Obsidian.exe` on Windows 11.
- Tested the exact **audit worktree build** `main.js` (SHA-256 `745efaa898bc2a546016f96e1ab257b6c6c6cc3669ffc349be58814db49b7d06`) of commit `e78a8805200e40beef8b410e6931c86b66689aed`.
- User-approved disposable vault: `.tmp/native-obsidian-d6/vault-a` **inside the isolated audit worktree**. Isolated Electron profile: `.tmp/native-obsidian-d6/profile-a`. Obsidian launched with `--user-data-dir=<isolated profile>` and loopback-only CDP port `9227`; renderer verified the exact absolute vault root **before each mutation**.
- **No private vault, master, GitHub Actions or real GitHub remote mutation.** Community Plugins globally enabled **only in the disposable profile**; initial Restricted Mode had prevented the plugin from loading, and this was explicitly resolved in the disposable profile.
- Verified from real `window.app` renderer that `app.plugins.plugins["encrypted-github-sync-multi-platform"]` and `plugin.v4Runtime` exist; `platformIo.capabilities.recoveryStagedCommit === true`.
- Repro driver and fixture remain only under the ignored `.tmp/native-obsidian-d6/`; they are not a substitute for a checked-in, portable automated acceptance test.

## Results

| Scenario | Real Obsidian evidence | Status |
| --- | --- | --- |
| Staged overwrite of closed `Native acceptance.md` | `platformIo.commitStage` succeeded; exact disk bytes, live `TFile.stat`, `Vault.read` and `sessionVault.stat` matched; one **modify** event; stage file removed | PASS |
| Staged create of new Markdown file | One **create** event; file appeared in vault index and `sessionVault.listFiles`, exact disk/Obsidian bytes matched; stage removed | PASS |
| Staged overwrite while a clean Markdown editor was open | Editor contents updated to staged remote version; one modify event; disk bytes matched | PASS |
| Staged overwrite while Markdown editor held **unsaved user changes** | In a disposable new note, `editor.setValue("...USER_DIRTY_UNSAVED_EDIT...")` changed the visible buffer, and a direct disk read still returned `BASE_CONTENT` (proving user edit was not saved). Then `platformIo.commitStage` replaced target with `REMOTE_STAGED_REPLACEMENT`. Immediately and after **3.4 seconds**, both disk and editor contained the remote version; user edit was gone; **no modal**; one modify event. Reproduced in two isolated notes. | **FAIL — DATA LOSS RISK** |
| Unclean app stop then restart of same isolated profile | Plugin loaded automatically; Desktop staged capability true; 5 Markdown notes indexed; all four staged markers preserved and read correctly from disk/Obsidian; unsaved user marker did not survive | PASS for restart consistency, but does **not** prove a kill exactly between two rename syscalls |

The last failing scenario is **not** proof that every normal Sync loses edits, because the stage commit was triggered directly via the plugin's real runtime rather than a complete GitHub Sync session. It **does prove** that the Desktop small-file replacement primitive can silently discard a dirty native Obsidian editor buffer. Current Sync WAL replay uses that primitive. Treat as a release blocker until a safe end-to-end policy and mitigation are demonstrated.

## Decision required before fixing production behavior

**Candidate A — fail closed and defer:** If an affected file has any open editor with uncommitted changes (or the state cannot be proven safe), do not apply the staged local mutation; retain the recovery WAL/stage and report a conflict requiring user review. Never silently overwrite an editor buffer. Must also recheck race at commit time, including edits made after asynchronous preflight.

**Candidate B — preserve both:** Materialize the unsaved local editor buffer as an independently verified conflict copy, then apply the remote stage after user confirmation, with proof-gated recovery. More UX and crash consistency complexity; needs user approval.

No choice has yet been approved for this new dirty-editor policy. The existing **Settings policy B** (a started sync finishes with its starting GitHub credentials) remains unchanged and is a different decision.

## Release gates still pending

Real two-profile/two-instance credentialed sync, simultaneous local editor and remote publication, forced kill exactly mid-backup/rename, filesystem handle-pinning/symlink TOCTOU, macOS/Linux/Mobile, and the remaining C2 protocol/merge UI decisions. No automatic release, merge, or master push.
