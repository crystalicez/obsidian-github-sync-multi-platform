# Real Obsidian Desktop → disposable GitHub UI roundtrip — 2026-10-17

## Scope and safeguards

The maintainer authorized destructive testing against the prearranged disposable repository, not the source repository:

- **Source code:** clean detached SHA `464800d016682e49fc6dc1ef8645335f319d50ef` on `audit/2026-09-26-production-hardening`.
- **Disposable GitHub repository:** `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned numeric ID **`1284153873`**, distinct from canonical source ID `1282135059`. Default branch `main` was never mutated.
- **Per-run branch:** `obsidian-sync-e2e/local-464800d01668-548833738e948b7f`, generated using the source SHA and a random suffix. Repository metadata and branch absence were checked with GitHub API **before** writes.
- **Obsidian:** actual Windows Obsidian Desktop 1.14.4 launched through a separate Electron user-data directory and a newly created **synthetic** vault under ignored `.tmp` inside the repository. Both are deleted when the isolated process exits.
- **Credentials:** local ignored `.env.github-e2e` is read only by the test runner, with independently verified `GITHUB_E2E_EXPECTED_REPO_ID=1284153873` supplied as a process environment override (the secret file could not be edited due to `SECRET_ACCESS_DENIED`). Token is never included in screenshots, stdout, tracked files, or reports. Only the test repository/branch is configured.
- **Evidence:** the runtime screenshot is cropped to the visible Sync Center, checked for valid PNG dimensions and token absence in the Sync Center text. It contains synthetic note names and remote commit metadata only.

## What the native UI run actually did

1. Read-only GitHub preflight proved pinned ID, source/target separation, default-branch safety and **new test branch absence**.
2. Spawned an isolated production Obsidian instance; asserted its live vault path matches the newly created project-local synthetic vault before injecting any credentials.
3. Loaded the **built production plugin** in Electron, saved test GitHub owner/repo/token/branch to that isolated instance, with startup/local-change/scheduled sync disabled.
4. Initialized V4 data by issuing `forcePush(false)` **only** against that new, random disposable branch, then checked GitHub reported a branch HEAD.
5. Modified a synthetic Markdown note using Obsidian's `app.vault.modify`, opened **actual Sync Center**, and clicked its **Sync now** button in the Electron page.
6. Waited for `lifecycle=success` with `trigger=manual`, then read GitHub's Git ref independently and asserted **HEAD SHA changed** from the initialization commit.
7. Captured and visually inspected [the actual Sync Center Success screenshot](ui-real-screenshots-2026-10-17/12-live-github-sync-center-success.png): **Success · Normal · Manual · Attempt 1**, **Push 1/1**, total **11.3s**, phases for checking remote/loading index/scanning/hashing/planning/uploading/committing/saving index, and a newly listed commit.
8. Terminated only the isolated Obsidian process, erased its vault and Electron profile (including locally persisted test secrets), and called `cleanupE2EBranch` on the branch it created. Cleanup re-verified the numeric target repository ID/default branch and independently confirmed the branch **absent**.
9. Runner returned **exit code 0** with `status=PASS`, `cleanup=absent-verified`, `remoteHeadChanged=true`, `screenshotCaptured=true`, and `uiExceptions=0`. Git status for the detached tested source remained clean.

This is **real application + network + GitHub API** acceptance for a synthetic **plaintext** sync sequence. It is **not** a physical Android/iOS test, an entire configured Settings UI journey (credentials were saved via the plugin settings API), an encrypted real native-vault acceptance, or a user-authorized release/merge.

## Critical defect discovered through real UI (UI-127 — HIGH)

The **first two guarded native attempts failed** despite the earlier protocol-level GitHub E2E passing:

- First failure: Progress phase **hashing**, error `Failed to fetch dynamically imported module: node:fs/promises`; branch cleanup returned `absent-verified`.
- Second run recorded the same error with sanitized phase/error telemetry. This proved a genuine Electron renderer failure: `src/lib/v4/platform-io.ts` used `import("node:fs/promises")` / `import("node:path")` for desktop capabilities. In Obsidian's browser-like renderer those imports were treated as URL fetches; Node-based harnesses do not reproduce this.
- A RED regression in `tests/v4/platform-io.test.ts` initially showed the shipped CommonJS `main.js` omitted the required `require("node:*")` path. The first attempted fix broke ESM tests because the esbuild `require` shim is not a real Node `require` there; the second fix properly gates CommonJS-only `require` with `typeof exports === "object"`, retaining dynamic `import` for genuine Node ESM tests.
- **GREEN:** Production Build and `tests/v4/platform-io.test.ts` **16/16** passed, including bounded reads, stage/rollback, symlink/junction security. Full Fast suite passed in both source and clean detached checkouts. The third **real Obsidian** run passed the complete synthetic GitHub roundtrip and branch cleanup.

## Commands

From a **clean source checkout** only, with the maintainer's prearranged ignored credentials file:

```powershell
$env:GITHUB_E2E_ENV_FILE = 'E:\Coding\obsidian-github-sync-multi-platform-forked\.env.github-e2e'
$env:GITHUB_E2E_EXPECTED_REPO_ID = '1284153873'
$env:GITHUB_E2E_SOURCE_REPO_ID = '1282135059'
node scripts/run-obsidian-live-github-ui.mjs --preflight-only
node scripts/run-obsidian-live-github-ui.mjs
```

These commands access the live GitHub API. The second command creates commits on a **new randomly named disposable branch**, then deletes that branch after testing, and deletes the isolated local credential storage. A failure must be investigated; never re-run against an existing branch or a personal vault.

## Outstanding release gates

Configured Force Push/Pull keyboard/screen-reader accessibility remains unresolved. This sequence proves **only** plaintext native Obsidian test-vault sync; an encrypted native path, large real file on mobile, physical Android/iOS, independent configured Settings UI acceptance, official clean master-SHA qualification, hosted CI and release approval remain open. PR #8 stays **Draft**, unmerged.
