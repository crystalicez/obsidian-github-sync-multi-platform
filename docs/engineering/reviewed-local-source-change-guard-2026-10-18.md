# Conflict review: preserve local edits made during the decision dialog

Date: 2026-10-18. Repository: `crystalicez/obsidian-github-sync-multi-platform`, Draft PR #8 only.

## Data-loss risk (RED regression)

A user can edit a note in Obsidian while the **Ask / manual Merge** modal is open. Previously the no-recovery `applyStagedWrite` path wrote the reviewed output without verifying that its **local source** had remained unchanged since review. The remote choice path used a local precondition of size + modification time only. A same-size, same-mtime edit during review could therefore be silently replaced with stale merged/remote content.

A behavioral RED test in `tests/v4/sync-session.test.ts` deliberately changes the note's bytes in the `askConflict` callback **without changing size or mtime**. Before the fix, it reported `Missing expected rejection`. The test now passes, checks local bytes remain the newer user's edit, and verifies the GitHub branch head did not advance. A second test exercises the `Use remote` choice under the same same-stat edit.

## Fail-closed change

- `V4StagedWriteBinding` now carries its original reviewed `V4LogicalFile`; `V4PullBinding` can carry the reviewed original hash for same-path `Use remote` or a reviewed merge equal to remote.
- The session verifies **source path, size, mtime and SHA-256** after all Ask decisions and before any local write or remote publication begins. The non-recovery Apply path checks again immediately before the final write; pull paths re-check at application.
- Recovery payloads include an optional SHA-256 in affected local stage/pull preconditions. The recovery validator accepts only valid lowercase 64-hex hashes, keeps old records compatible, and `applyV4RecoveryLocalMutations` uses the same precondition guard before mutations.
- To avoid trading a data-loss guard for out-of-memory failures, a reviewed source over the existing **32 MiB whole-buffer ceiling** uses `openContentSource` + incremental SHA-256 in bounded 4 MiB chunks, with checks across streaming. If bounded I/O is unavailable the operation fails closed. Smaller source files are read and hashed with pre/post stat checks.
- Nothing is selected or deleted automatically; changed local content means the sync **aborts and must be reviewed/replanned** rather than silently choosing a winner. Existing remote CAS/commit safety remains in place.
- This reduces but does **not eliminate** every possible race between the final precondition and the OS's actual write, nor does it replace an atomic compare-and-write API. That limitation remains a production review item for platform adapters.

## Follow-up: stage-read-to-write race closed (RED → GREEN)

An additional deterministic regression `reviewed merge refuses a same-stat edit after the first guard but immediately before local Apply` revealed a narrower race **after** the first reviewed-source precondition had passed. A callback at `phase: applying` changed the Vault note's bytes without changing size or mtime; the original implementation of `applyStagedWrite` then awaited `readStage` and silently overwrote the newer local bytes. The test **failed RED** with `Missing expected rejection`, while the same isolated test **passed GREEN** after the fix.

`applyStagedWrite` now verifies the original source SHA-256, path, size and mtime **again after awaiting `readStage`, and before trash or write**. This does not select a winner or change conflict policy; it fails closed and preserves the edited note. The preflight review guard and the recovery/pull guards remain intact. A legacy stat-count test was updated from 10 to 12 because the additional SHA guard necessarily performs before/after-stat checks; its exact bounding assertion was not removed.

**Remaining inherent risk:** a Vault adapter without atomic compare-and-write still has a very small check-to-write window. Also, when this last-moment check fails *after* GitHub has already published the reviewed result, local data is preserved but the remote may already be advanced; the operation must surface the error and replan/recover instead of pretending the two sides are synchronized. This patch does not provide an atomic cross-service transaction or prove away that residual race.

**Primary Windows verification of this follow-up:** `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile`, `test:ui:visual` (including production build) all exit 0; native Obsidian Desktop 1.14.4 UI **111/111 checks, 22 screenshots, 0 JavaScript exceptions**, synthetic disposable vault only. Exact committed SHA clean qualification and hosted CI are not yet claimed.

## Verification

- RED → GREEN tests: `tests/v4/sync-session.test.ts` exercises stale merged content and `Use remote` with same-size/same-mtime edits; `tests/v4/staged-commit.test.ts` proves hash-sensitive preconditions and **larger-than-32 MiB streaming verification** without any whole-file `read()` calls, including rejection after one byte changes.
- Updated a source-scan stat-count test to account for **two mandatory pre/post-hash verification passes**, without removing the scan-bounding assertion.
- Primary Windows workspace: production `build`, `test:fast`, `test:repeat` (**10/10**), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, and `test:github-e2e:compile` **all exit 0**.
- Native Obsidian Desktop 1.14.4 synthetic UI acceptance: **111/111 checks, 22 screenshots, zero JavaScript exceptions**. No real credentials, user vaults or remote writes in these tests.

## Exact pushed-SHA independent qualification

**Code SHA `5c81d6ac13dbfb9da7408cc7be014957ca07c509`** was checked out independently into detached `.tmp/review-source-guard-clean-20261018`, with `pnpm install --frozen-lockfile` exit 0.

- Native **Obsidian Desktop 1.14.4** visual runner (including production build) exited **0**: **111/111 assertions, 22 screenshots, zero JS exceptions** in the disposable synthetic vault. The standing Desktop 375px Settings popout width warning remains, not a physical-mobile pass.
- Full `test:fast`, `test:repeat` **10/10**, `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile` all independently exited **0** on the exact SHA.
- `git status --short --branch` after tests was **exactly `## HEAD (no branch)`**, and `git rev-parse HEAD` matched the code SHA. The primary worktree contained only the user's unrelated uncommitted `tests/v4/github-transport.test.ts`, which was not staged.
- GitHub PR #8 remained **open and Draft**, head verified as the pushed SHA at the time of qualification.

This does **not** constitute a credentialed end-to-end GitHub run of this SHA. Hosted CI evidence, full live GitHub E2E stability, physical Android/iOS and independent review remain release gates. No PR merge or release was performed.
