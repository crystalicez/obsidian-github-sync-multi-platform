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

## Verification

- RED → GREEN tests: `tests/v4/sync-session.test.ts` exercises stale merged content and `Use remote` with same-size/same-mtime edits; `tests/v4/staged-commit.test.ts` proves hash-sensitive preconditions and **larger-than-32 MiB streaming verification** without any whole-file `read()` calls, including rejection after one byte changes.
- Updated a source-scan stat-count test to account for **two mandatory pre/post-hash verification passes**, without removing the scan-bounding assertion.
- Primary Windows workspace: production `build`, `test:fast`, `test:repeat` (**10/10**), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, and `test:github-e2e:compile` **all exit 0**.
- Native Obsidian Desktop 1.14.4 synthetic UI acceptance: **111/111 checks, 22 screenshots, zero JavaScript exceptions**. No real credentials, user vaults or remote writes in these tests.

This is **not** a credentialed end-to-end GitHub run of this exact source SHA. Hosted CI, full live-GitHub E2E stability, physical Android/iOS and independent review remain open. No PR merge or release. Preserve unrelated uncommitted `tests/v4/github-transport.test.ts` WIP. Exact-SHA detached clean checkout qualification must be recorded after push.
