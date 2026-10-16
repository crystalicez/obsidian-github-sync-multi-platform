# Native encrypted Obsidian Desktop → live GitHub acceptance — 2026-10-17

## Outcome

**PASSED on real Windows Obsidian Desktop 1.14.4** using a freshly generated synthetic vault and Electron profile within this repository's ignored `.tmp`. The exact source commit was `3c1af51856928d29addaa0946b359329ce7fad11` (clean detached checkout). The real production plugin performed an **encrypted** GitHub V4 initialization and then a manual sync triggered by clicking **Sync Center → Sync now** on the live Obsidian UI.

The tester's own result reported:

```text
status=PASS
mode=encrypted
remoteHeadChanged=true
remoteEncryptionVerified=true
screenshotCaptured=true
uiExceptions=0
cleanup=absent-verified
exit_code=0
```

Those are observable test results, not estimates. A second separate authenticated GitHub read-only API check independently confirmed the exact branch absent, target repository ID unchanged and default branch still `main`. A separate Windows process/filesystem check confirmed **zero remaining test Obsidian processes** and **the synthetic local vault/profile folder absent**. Post-run code worktree status `## HEAD (no branch)` was clean.

[Actual UI screenshot — encrypted Sync Center Success](ui-real-screenshots-2026-10-17/13-live-encrypted-github-sync-center-success.png): screenshot reviewed directly. It displays **Success · Normal · Manual · Attempt 1**, **Push 1/1**, elapsed time **11.4 seconds** and a dedicated **Encryption** timing phase. No token or passphrase is visible.

## Scope and security assertions

- **Target:** maintainer-authorized disposable `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (pinned GitHub numeric ID **1284153873**, distinct from canonical source repo ID **1282135059**).
- **Default branch:** `main`, never used as test target or mutated by this runner.
- **Random ephemeral branch:** `obsidian-sync-e2e/local-3c1af5185692-3108c2b397b3cde1`. The remote branch was verified absent before test, was initialized exclusively by the isolated vault, advanced after native UI manual sync, and was verified absent after cleanup. Cleanup uses per-call repository ID/default-branch guards.
- **Credentials:** token was loaded from the ignored protected `.env.github-e2e` file without displaying it; pinned IDs were provided by process-only environment overrides. A new random 32-byte passphrase was generated for this test run and saved only to the ephemeral isolated Obsidian credential store. Both the vault and profile were erased after the test. Neither secrets nor the temporary branch's note data were committed to the project's Git repository.
- **Data protection:** the real live GitHub commit tree had no `UI-smoke.md` plaintext path. It contained V4 config/head and opaque data objects matching `.obsidian-github-sync-v4/data/<bucket>/<64-hex>.enc`. The remote config declared **`mode=encrypted`**, **`pathLayout=opaque-stable-v1`**, and **`AES-GCM`**. An actual remote ciphertext Git blob had the **OGS4** encrypted-payload header and did not include the synthetic Markdown plaintext sample. These checks substantiate the encrypted wire format; they do **not** substitute for a separate second-device native decrypt-and-restore test.
- **Native workflow:** plugin settings were configured via `plugin.saveSettings` in an isolated Obsidian instance (not by typing into the Settings UI). First remote bootstrap called `v4Runtime.forcePush(false)` only on the verified, fresh branch; then `app.vault.modify` edited a synthetic note and an actual DOM `Sync now` button click performed the subsequent upload. GitHub API independently observed the branch HEAD SHA advancing.
- **Screenshots:** only the synthetic Sync Center was captured. The runner checks for the presence of token and passphrase in visible Sync Center text before allowing the screenshot to be written.

## Failure and remediation (the gate must include cleanup)

An initial run on `33f86c4` successfully proved the encrypted GitHub data layout, manual commit advancement, and remote branch deletion, but returned **FAIL / exit 1** because Windows momentarily locked files in the Electron test profile. No associated Obsidian process remained; a later scoped retry removed the exact leftover profile. The gate was **not** marked as passing.

The runner now uses `scripts/obsidian-live-ui-cleanup.mjs`, which:
- Restricts deletion to the exact `<repo>/.tmp/obsidian-live-github-e2e/<16-hex-run-id>` path; rejects unrelated folders and malformed run IDs.
- Retries transient Windows `EBUSY`, `EPERM`, `EACCES`, `ENOTEMPTY` locks within a bounded budget. Other errors or exhausted attempts still **fail** the test.
- Has explicit RED/GREEN unit coverage for transient locks, unsafe deletion paths, persistent locks and unexpected errors (`tests/v4/obsidian-live-ui-cleanup.test.mjs`).

The follow-up real-app encrypted run on **code SHA `3c1af51`** passed all assertions, **exit 0**, with automatically verified remote and local cleanup. Target branch was separately checked with authenticated API afterward; vault/profile absence was separately checked with Windows process/filesystem tools.

The runner has `--mode=encrypted` and `--mode=plaintext` (default), with fail-closed strict mode parsing. Dedicated tests in `tests/v4/obsidian-live-ui-encryption.test.mjs` cover unsafe mode fallback, the required opaque encrypted tree layout, and plaintext filename leakage; targeted UI harness/cleanup/mode tests **9/9** passed in the exact clean code checkout.

## Reproduction

From a **clean checkout** with `corepack pnpm build` already completed and the maintainer's approved disposable GitHub E2E credentials available:

```powershell
$env:GITHUB_E2E_ENV_FILE = 'E:\Coding\obsidian-github-sync-multi-platform-forked\.env.github-e2e'
$env:GITHUB_E2E_EXPECTED_REPO_ID = '1284153873'
$env:GITHUB_E2E_SOURCE_REPO_ID = '1282135059'
node scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --preflight-only
node scripts/run-obsidian-live-github-ui.mjs --mode=encrypted
```

**The second command creates, mutates, and deletes a real GitHub branch.** The repo ID guard and branch-absence proof run before writes, and cleanup will fail loudly if the branch remains. Never point it at a private/personal vault or the source code repository. The protected `.env.github-e2e` is not edited or committed by the runner.

## Clean exact-SHA verification

Code commit `3c1af51856928d29addaa0946b359329ce7fad11` was checked out in the existing **detached clean** `.tmp/release-audit-clean-20261010` worktree. Frozen dependencies were already installed from the earlier qualification. These commands exited **0** from that exact checkout: `pnpm build`, focused native UI harness/cleanup/encryption tests **9/9**, `pnpm test:repeat` **10/10**, `pnpm test:fast`, `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package` and `pnpm test:github-e2e:compile`. The real native encrypted GitHub UI roundtrip also exited **0** on the same SHA. Final `git status --short --branch` was exactly `## HEAD (no branch)` (clean). The unrelated unstaged `tests/v4/github-transport.test.ts` helper in the primary worktree was excluded and untouched.

## Remaining acceptance gates

This result closes the **one-device encrypted native Desktop push/UI path** only. Open work still includes native cross-device encrypted decrypt/pull with independent state, complete Settings form entry, pointer-only configured Force confirmation accessibility, physical Android/iOS, large real files on mobile, hosted CI and official master/release qualification. **PR #8 remains Draft; no merge, tag, or release authorized.**
