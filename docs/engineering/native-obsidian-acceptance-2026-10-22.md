# Native Obsidian D6 acceptance — 2026-10-22 (Windows)

**Status: BLOCKED — reproducible unsaved editor buffer loss. Do not release.**

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
