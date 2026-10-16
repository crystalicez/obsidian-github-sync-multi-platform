# First authorized live GitHub E2E — 2026-10-17

## Authorization and scope

The maintainer explicitly authorized **real testing in the prearranged disposable repository** and reported that its credentials had been saved in the local ignored `.env.github-e2e`. No credential value is recorded in Git, this report, commands or transcript.

- **Source/audit repository:** `crystalicez/obsidian-github-sync-multi-platform` (pinned source ID `1282135059`).
- **Target/disposable repository:** `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`.
- **Pinned target repository ID:** `1284153873` (read through token-authenticated GitHub API before the run; distinct from the source ID).
- **Target default branch:** `main`; was **not** selected for tests.
- **Disposable working branch:** `e2e-destructive`. Authenticated read-only preflight confirmed it was **absent before the first mutation**.
- **Source checkout:** clean detached checkout of full SHA `3cf17bdbf3f22854356074ec10bb2ecdeb9e0f7f` in `<repo>/.tmp/release-audit-clean-20261010`, not the primary working tree with unrelated `tests/v4/github-transport.test.ts` WIP.
- **Mode:** `corepack pnpm test:github-e2e` (**live, not compile-only**). Three test bundles built and executed sequentially through `scripts/run-github-e2e.mjs` and Node's test runner.

## Configuration caveat

The secret file exists and supplied `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, `GITHUB_E2E_BRANCH` and `GITHUB_E2E_TOKEN`, but **did not include `GITHUB_E2E_EXPECTED_REPO_ID`**. The read-only preflight initially rejected the incomplete configuration. After independently verifying the target ID via an authenticated GitHub repository metadata request and confirming that the branch was absent, the ID was **supplied for this child process only** as `GITHUB_E2E_EXPECTED_REPO_ID=1284153873`; the source ID was also passed as `GITHUB_E2E_SOURCE_REPO_ID=1282135059`. The script was not modified to bypass its guards.

A guarded attempt to edit the secret file was explicitly denied by the remote workspace (`SECRET_ACCESS_DENIED`), and the denial was respected. **The maintainer should manually add** `GITHUB_E2E_EXPECTED_REPO_ID=1284153873` to their own ignored `.env.github-e2e` if future live runs should work without a temporary environment override. Optional extra defense: `GITHUB_E2E_SOURCE_REPO_ID=1282135059`. Never commit the env file; `git check-ignore` confirmed it is ignored. Do not automatically derive the expected ID from the target API **during** each live run, as that would defeat persistent identity pinning.

## Actual execution results

| Gate / observation | Evidence |
| --- | --- |
| Read-only target identity / default-branch preflight | target ID matched `1284153873`, `main` proved distinct |
| Read-only disposable branch preflight | `e2e-destructive` **absent** |
| Live test command | `corepack pnpm test:github-e2e` |
| Source SHA | `3cf17bdbf3f22854356074ec10bb2ecdeb9e0f7f` |
| Runner exit code | **0**, no stderr |
| Wall clock | 18:07:57 to 18:20:22 as recorded by the task service, approximately **12 min 25 sec** |
| Recorded passing test examples | rename vs stale edit Copy contract; encrypted out-of-band GitHub commit guard |
| Recorded passing live telemetry examples | plaintext baseline edge paths; stale catchup/disjoint push; same-file Copy conflict; rename vs stale edit; delete/recreate |
| Post-test branch cleanup proof | **two authenticated, read-only API checks** confirmed `e2e-destructive` **absent**, repository ID unchanged and default branch still `main` |
| Git cleanliness | detached checkout still `## HEAD (no branch)` with no modified tracked files |
| User content / source repo | no personal vault and no source-repo branch mutation |

**Reporting limitation:** The remote task service truncated its captured stdout to the **first ~3.8 KB** despite the runner completing with exit code 0; therefore the entire individual scenario list, final Node TAP totals and any trailing cleanup printout are **not available as retained stdout evidence**. The runner's exit code and independently verified branch absence support the overall result. Do **not** infer an exact count of passing individual test scenarios from the truncated log. A next run should use an ignored per-run log file and a sanitized summary/receipt for auditability, without dumping secrets.

These tests exercise the **real GitHub REST API** with simulated two-device vaults and actual branch writes. They are **not** equivalent to a complete Obsidian Desktop UX workflow with configured secrets, nor to physical Android testing.

## Remaining release blockers

- The configured-repository Force Push/Pull confirmation remains pointer-only; keyboard/screen-reader alternative and destructive-operation safety signoff are open.
- **Follow-up 2026-10-17:** This native Obsidian-to-GitHub gap was **partially closed**: a configured **plaintext** synthetic vault successfully initialized a new disposable branch and synced a locally edited note by clicking the **real Sync Center → Sync now** button, with an independently verified advanced commit and branch cleanup. A serious Electron dynamic-import regression was identified and fixed. See [native UI + live GitHub evidence](live-obsidian-github-ui-e2e-2026-10-17.md). Native encrypted UI, full manual Settings form entry and mobile acceptance remain OPEN.
- Hosted CI checks, official clean `master` SHA qualification, physical mobile and large-file capacity claims remain open.
- PR #8 remains **Draft**. No merge, stable tag or release was authorized.

## Rerun, after maintainer pins the repository ID

From the source repository root:

```powershell
corepack pnpm test:github-e2e
```

This command **mutates and deletes** the configured disposable branch. Confirm it is unused/absent before each rerun. Do not run on a personal repository or a default branch.
