# D25 — Real Windows Obsidian encrypted two-instance acceptance on D22 Node.js code

Date: 2026-10-23. **Actual Windows Obsidian desktop GUI**, synthetic isolated vaults, user-approved disposable GitHub test repository only.

## Scope and product identity

- Tested **Git commit** `f261b3e99c358663bbcf23298b098ac706e8a021`, which contains D24 test-only tooling and **the same `src/` implementation as D22** `acdce29ae6958e531e582e78432959e712ecb0b7`. The test was run inside a clean detached disposable worktree at `.tmp/d25-windows-ob-ui-f261b3e-20261023` because the active audit worktree contained unrelated concurrently untracked work.
- `scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey` through Node.js, with the missing pinned `GITHUB_E2E_EXPECTED_REPO_ID=1284153873` supplied **for the test process only** from known approved repository identity. Ignored root `.env.github-e2e` was neither modified nor exposed.
- Target `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric ID **1284153873**, default branch `main` untouched. Random disposable branch `obsidian-sync-e2e/local-f261b3e99c35-7fdf3ed0046f1dfc` absent at preflight; only this branch was used. Two synthetic test-only Obsidian vaults and distinct temporary Obsidian profiles/CDP ports; **no personal vault**.
- Native OS-helper research in [deferred Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) was not resumed. This test uses the **Node.js + Obsidian API plugin**, not the P/Invoke research. No GitHub Actions, master, release, signing, or physical file larger than 100 MB.

## Observed real Obsidian result

The external managed process (test command `node --env-file=../../.env.github-e2e --input-type=module -e ...` with process-scoped repo ID, argv `--mode=encrypted --verify-peer --journey`) **exited with code 0** and returned:

- `status: PASS`, `cleanup: absent-verified`, `remoteHeadChanged: true`.
- `mode: encrypted`, `remoteEncryptionVerified: true` (opaque AES-GCM data/header validated against GitHub tree, synthetic note content not leaked).
- `peerRestored: true`: independent second actual Obsidian instance force-pulled and decrypted the expected synthetic note content.
- `journeySteps`: nested Unicode + scratch note creation, rename/modify/delete combination, recreate deleted note, and simultaneous two-device conflict retaining both edited versions.
- `noOpEvidence`: an additional warm small-vault sync returned `lifecycle: no-change`, 0 changed files, ~2100.9 ms wall clock.
- `uiExceptions: 0`, `screenshotCaptured: true`; both Sync Center and restored peer-view screenshot artifacts were written under the test worktree's ignored `.tmp/obsidian-live-github-e2e-evidence/` directory. This is automated UI screenshot assertion / capture; not a separate human visual accessibility audit.
- `nativeDownloadWallMs: 6707` as recorded by test harness for peer restore; **not** a representative upload benchmark. `native100mbBytes: 0`: **no 100 MB physical test was requested/performed** in this focused journey. This run does not establish latest-code 1,000-note load acceptance.

## Independent GitHub branch cleanup

After the GUI test exited, a separate **read-only** process ran:

`node scripts/check-github-e2e-branch-absence.mjs obsidian-sync-e2e/local-f261b3e99c35-7fdf3ed0046f1dfc`

Its result was `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit **0**, branch absent on both reads, test repository ID **1284153873**. This provides independent confirmation beyond the GUI runner's own cleanup declaration.

## Production-readiness boundary

This confirms D22 Node.js code can complete the **real Windows two-Obsidian encrypted small synthetic lifecycle**, including conflict retention and idle no-change, in addition to the D24 **three complete 3/3 real GitHub simulation matrices**. Neither establishes a comprehensive production sign-off: macOS/Linux/mobile behavioral acceptance, actual SMB/cloud volume durability, OS power cut, C2 coordinated remote migration, line-by-line merge conflict UX, a current large-scale GUI soak, and independent release review remain separately pending. The original D23 intermittent missing-object event remains without a uniquely proven root cause; no product retry/overwrite behavior was changed to conceal it. Issue #9 remains deferred.
