# Clean code-SHA qualification: GitHub E2E retry safety (2026-10-18)

## Exact source and scope

- Source commit: `4df548c31189d9864eff2a9b0fd9bf5fcda33ad1` (`test: prevent GitHub E2E mutation replay on uncertain responses`).
- Detached checkout: `.tmp/e2e-retry-clean-20261018` in `E:\Coding\obsidian-github-sync-multi-platform-forked`. Before and after the gates, `git status --short --branch` returned `## HEAD (no branch)`; `git rev-parse HEAD` returned the full source SHA.
- The main audit checkout retained a pre-existing, unstaged edit to `tests/v4/github-transport.test.ts`. No source or test changes from that edit were present in the detached checkout.
- This is audit-branch qualification only. It does not qualify `master` for release.

## Observed deterministic gates

Executed inside the detached checkout, sequentially:

| Command | Outcome |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | exit 0 |
| `corepack pnpm build` | exit 0 |
| `corepack pnpm test:fast` | exit 0 |
| `corepack pnpm test:repeat` | exit 0, all 10 runs |
| `corepack pnpm test:recovery` | exit 0 |
| `corepack pnpm test:resource` | exit 0, 15/15 |
| `corepack pnpm test:feasibility` | exit 0 |
| `corepack pnpm validate:metadata` | exit 0 |
| `corepack pnpm validate:package` | exit 0 |
| `corepack pnpm test:github-e2e:compile` | exit 0, three bundles |

The native UI command `node scripts/run-ui-screenshots.mjs --launch` also exited 0 against real Obsidian Desktop with a new isolated profile and synthetic vault. Its generated report contains **111/111 passing checks**, **22 screenshots**, and **zero JavaScript exceptions**. Evidence is under `.tmp/e2e-retry-clean-20261018/.tmp/ui-visual-smoke/runs/1792300296417-27792/screenshots/report.json` (ignored local artifact). The report warns that the Obsidian Settings popout at a 375-pixel desktop viewport leaves only 175 pixels for plugin content. This is host-controlled layout and is not evidence of mobile usability.

## Remaining release gates

- Credentialed full live GitHub E2E has **not** been rerun on this SHA. The intermittent `controlled-external-branch-head-race` case remains unresolved, and exact disposable-target and cleanup proofs must accompany any live qualification.
- GitHub's public Actions workflows API shows `CI` as active, but the exact code SHA has **zero observed hosted workflow runs**. This does not establish why Actions did not run. Inspect repository Actions settings and eligibility before counting hosted CI as passed.
- The clean checkout is not `master`; independent review, real physical device coverage, Windows 5 GiB evidence and any release claims remain separate gates.
- No live GitHub mutation, stable release, merge, or production runtime change was performed in this qualification.

Do not substitute the completed deterministic gates for live GitHub, hosted CI, physical devices, or maintainer sign-off.
