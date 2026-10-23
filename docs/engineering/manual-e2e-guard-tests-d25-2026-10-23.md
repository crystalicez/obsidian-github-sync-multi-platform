# Stage D25 — Offline fail-closed tests for manual GitHub E2E launchers

Date: 2026-10-23. Audit-only Node.js production-readiness test hardening on `audit/2026-10-21-staged-production-integration`.

## Scope and decision boundary

- Node.js + Obsidian API remains primary. GitHub [Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) on native OS filesystem TOCTOU is **deferred** until explicitly requested.
- Do not change `src/`, remote protocol, journal/WAL, conflict policy, encryption, or release packaging. No GitHub Actions or changes to master/release.
- D24 already proved **three separate full real GitHub E2E matrices PASS**, each with three top-level tests and 13 scenario receipts, on independent absent-first branches in only the user-approved test repository (numeric ID **1284153873**). All three branches had post-run double-absence proof. D24's first focused plaintext wrapper experienced a transient GitHub network error **after** the actual tests passed; an independent read-only request subsequently verified the ref absent twice. This is not a reason to weaken cleanup rules.

## New deterministic offline guard regressions

`tests/v4/manual-github-e2e-invalid-input.test.ts` adds **three** tests that invoke only *invalid* arguments against the existing tracked launchers:
1. Missing scenario, `--help`, ambiguous extra arguments, shell-looking strings, default-branch overrides → `scripts/run-github-e2e-disposable.mjs` must exit code **2** with its usage message **before reading test secrets or contacting GitHub**.
2. `scripts/check-github-e2e-branch-absence.mjs` rejects main/master/production, traversal, escaped slash, and ref namespace confusion before any network request.
3. The read-only verifier rejects missing/extra arguments and produces no claimed verification.

The subprocess environment contains only platform essentials (no GitHub tokens, ignored E2E credential file is **never accessed** because invalid inputs are rejected at the initial argument gate). These are tests for accidental misuse/targeting errors, not authorization to run against any arbitrary repository.

## Evidence

- Focused offline guard tests **3/3 PASS**.
- `pnpm build` PASS.
- Local `pnpm test:fast` **516/516 PASS** in the audit worktree and `pnpm test:repeat` **10 repetitions** PASS.
- `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **132/132**, metadata/package validation PASS, GitHub E2E compile-only **3 bundles** PASS.
- **Accurate counting caveat:** This worktree also contains **three other untracked** fast tests in `tests/scripts/run-disposable-github-e2e.test.mjs` and an untracked alternative launcher `scripts/run-disposable-github-e2e.mjs` from a separate workstream. Those are **not** staged or committed by D25. Fast 516 thus includes +3 untracked tests; relative to D23's committed Fast510 baseline, **D25 adds exactly three tracked tests** and the expected fast total in a clean checkout without the unrelated untracked files is **513**, assuming unchanged discovery. Do not claim 516 is reproducible from the D25 commit alone without a clean-worktree rerun.
- No new live GitHub mutation and no new real Obsidian GUI acceptance in this stage; those claims belong only to separately verified D24/D14/D15 evidence.

## Next production qualification

Use existing safe full E2E runner on approved test repo, then run native Obsidian UI on the latest Node.js sync source across supported platforms and address independent C2 remote format and line-by-line merge UX release blockers. Keep OS-level native TOCTOU Issue #9 parked.
