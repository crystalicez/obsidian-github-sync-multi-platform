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

A separate exact pushed source SHA clean-checkout verification will be recorded after commit. Preserve unrelated user WIP `tests/v4/github-transport.test.ts`; keep PR #8 Draft, master and stable release untouched.
