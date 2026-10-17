# V4 local precondition must reject stat-less adapters — 2026-10-18

## Risk and RED reproduction

V4 preconditions are checked just before mutating an Obsidian note, including overwrite/delete after downloading remote content or applying reviewed merges. `V4SessionVault.stat` is optional at the *interface level* to support different adapters. Before this patch, `assertV4LocalTargetPrecondition` silently skipped the entire path/existence/mtime safety check when `io.stat` was absent. For a **new target**, the check with `exists: false` returned successfully despite not knowing whether another user action created the file during download. For an **existing reviewed target**, the hash alone could not verify that the expected mtime/path was still valid.

A new regression in `tests/v4/staged-commit.test.ts` sets up a stat-less adapter and explicitly requires the typed `V4LocalTargetChangedError` for both `exists: false` and a reviewed source with SHA-256. It **failed RED** (missing expected rejection), exposing the missing capability check.

## Fix

`assertV4LocalTargetPrecondition` now fails **closed** with `V4LocalTargetChangedError` if `stat` is unavailable. This does not modify the chosen conflict winner, alter GitHub publication policy or start any new destructive action. Adapters that cannot prove the local target is unchanged must not proceed with a potentially destructive local mutation. The adapter interface remains optional so pure adapters can be constructed for non-mutating operations; the mutation guard requires the capability.

## Verification

- The RED test turned **GREEN** after the change: focused `staged-commit` suite **7/7**.
- Primary Windows workspace `corepack pnpm build`, `test:fast`, `test:repeat` (**10/10**), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile`: all exited **0**.
- Actual native Obsidian Desktop 1.14.4 `test:ui:visual` exited **0**: **111/111 UI checks, 22 PNG screenshots and zero observed JavaScript exceptions**, with the known desktop Settings 375px popout width warning.
- This is **not a physical Android/iOS pass or a credentialed GitHub E2E run**. Hosted CI, full live E2E intermittent encrypted delete/recreate, independent review and physical devices remain production gates.

## Exact pushed-code independent qualification

Source SHA **`ee09ceb9c5e2948ea8b1e2a85c0ddd05e0061623`** pushed to audit branch and independently checked out as detached `.tmp/stat-precondition-clean-20261018`:

- `pnpm install --frozen-lockfile` and native Obsidian Desktop 1.14.4 `pnpm test:ui:visual` (includes production build) both **exit 0**. Actual native UI report: **111/111 checks, 22 screenshots, zero JS exceptions**; standing 375px desktop Settings popout warning persists.
- Full clean `test:fast`, `test:repeat` (**10/10**), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile`: all **exit 0**.
- Post-run worktree `git status --short --branch` exactly `## HEAD (no branch)` and `git rev-parse HEAD` matched that code SHA. Primary repository still had **only** the unrelated, previously uncommitted `tests/v4/github-transport.test.ts`, excluded.
- Real Obsidian session adapter was source-inspected: `src/lib/v4/runtime.ts` `sessionVault()` **does** provide `stat` based on `app.vault.getAbstractFileByPath()` and `TFile.stat`. This new fail-closed capability requirement therefore does not remove `stat` from the production adapter.
- GitHub PR #8 verified open, **Draft**, head exactly that code SHA. No merge/release.

**Scope:** no credentialed GitHub E2E on this exact SHA; no physical Android/iOS, hosted CI success or independent security review is claimed. Full live encrypted delete/recreate instability still blocks production. Preserve unrelated user WIP `tests/v4/github-transport.test.ts`; keep PR #8 Draft, master and stable release untouched.
