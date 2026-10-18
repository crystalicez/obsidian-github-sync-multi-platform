# Parallel test-runner output isolation — 2026-10-18

## Observed failure and root cause

In a clean detached qualification at code SHA `c93438002cb70c48503ec3d4929620abc5890e03`, `pnpm test:repeat` and `pnpm test:feasibility` were started simultaneously. The feasibility process failed with `ENOTEMPTY: directory not empty, rmdir .../.tmp/tests` while the repeat process was also compiling tests. Running feasibility **alone** afterwards passed **138/138**. This was a shared temporary-output race, **not an Obsidian V4 Sync assertion failure**.

Previously `scripts/run-tests.mjs` recursively removed and recreated the single shared `.tmp/tests` directory on every invocation, even when other test processes were still using their own compiled modules there.

## Fix

- Each runner invocation creates its **own unpredictable `.tmp/tests-*`** directory through `mkdtemp`. No runner removes the former shared `.tmp/tests` path.
- A `try/finally` removes **only that invocation's own directory** after tests finish, including failing test exits or build exceptions.
- The `.tmp` output root must be a real directory, not a symlink/junction exposed as a symlink to another location. Fail closed otherwise.
- Test exit status is retained in `process.exitCode` instead of calling `process.exit` before asynchronous cleanup completes.
- Added `tests/feasibility/test-runner-parallel.test.mjs` to launch a filtered fast tier and feasibility tier concurrently. It verifies both exit successfully **and** verifies a preexisting marker under `.tmp/tests` survives. The test removes only its own marker, never the shared directory.

## Observed Windows validation (working tree)

- Focused parallel-regression test: **1/1 pass**.
- The original overlapping large-suite scenario reran in parallel: **feasibility 139/139 passed** (one new regression test) and **repeat 10 consecutive runs of fast 666/666 passed**; both processes exited 0.
- After both finished, a read-only directory inspection found **zero leftover `.tmp/tests-*` generated directories**.
- `pnpm build` exited 0, `pnpm test:resource` **15/15**, `pnpm test:soak` **6/6** (all test logical payloads at most 100 MB), `pnpm test:recovery` **50/50**, and `pnpm test:github-e2e:compile` compiled three suites without credentialed network calls.
- No live GitHub mutations, source/default branch updates, package release or merge. The original user WIP `tests/v4/github-transport.test.ts` remains untouched and unstaged.

## Clean exact-code-SHA qualification

Audit commit `ff8933b5d2ed22a54d2c1bceece4918676aab9cb` was pushed to `origin/audit/2026-09-26-production-hardening`. The independent detached Windows checkout `.tmp/parallel-runner-clean-20261018` had exactly that HEAD and remained `## HEAD (no branch)` after validation. Frozen `pnpm install --frozen-lockfile` succeeded.

From this exact source SHA, **simultaneously executed** `pnpm test:repeat` (10 consecutive runs, each fast **666/666**) and `pnpm test:feasibility` (**139/139**) both exited 0. Other exact-SHA gates also passed: build, resource **15/15**, soak **6/6**, recovery **50/50**, and standard GitHub E2E compilation (no credentialed remote writes). After all runners finished, read-only directory inspection returned `unremovedOutputDirectories: []`. This removes the observed shared `.tmp/tests` race for these test suites; it is **not** a hosted CI or real GitHub 16 MB acceptance claim.

## Limits

This fixes local/CI test *bundle-directory interference*, not API-level rate limits, native Obsidian device acceptance, hosted CI proof, or old-client compatibility. A clean pinned new-code-SHA run remains necessary when preparing release evidence. Do not count compile-only GitHub E2E as a live transport test.
