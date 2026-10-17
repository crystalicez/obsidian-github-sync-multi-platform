# Reviewed-remote conflict no-publication regression — 2026-10-17

## Incident found in the manual conflict review integration

The new Ask modal returns `{ action: "merged", mergedBytes }` for reviewed hunks. If the user accepts **remote** in every hunk, these bytes exactly equal the pinned, verified remote file. Previously the sync-session's `merged` branch **always created a Push operation** with the staged bytes and published a new GitHub commit. This was a needless remote mutation after the user explicitly chose existing remote content and increased publication-race exposure. It was reproduced with a behavioral RED test in `tests/v4/sync-session.test.ts`: expected `pushedFiles=0`, actually got `1`. The test also proves the local file should contain the chosen remote bytes and the remote commit SHA must remain identical.

## Narrow, fail-closed fix

When a reviewed merged result has the **same SHA-256 content hash, byte size, and logical path** as the verified remote record, the session now queues its existing verified **Pull** binding instead of a Push + staged local overwrite. All other merged contents—including a genuinely mixed hunk result and renames—use the existing staged publication path unchanged. It still obtains user decisions before local writes and uses the normal local target preconditions, cancellation and recovery handling. This change does **not** select a conflict winner automatically, alter the Ask UI decisions, or change any delete/rename policy.

The RED case became GREEN with `pushedFiles=0`, `pulledFiles=1`, unchanged GitHub ref and correct local bytes. The pre-existing mixed-merge publish test stayed green. An additional **credentialed** E2E scenario `V4 reviewed remote conflict preserves exact GitHub commit (both storage modes)` was added to `tests/github-e2e/v4-real-github-e2e.test.ts`; it uses the maintainer-authorized disposable target only, sets up two independent devices with diverged content, asks for the remote bytes, and verifies exact branch-head stability and downloaded payload for plaintext and encrypted modes. The test must be run with the repo-ID-pinned guarded runner, never on the canonical or default branch.

## Precommit deterministic acceptance

On the connected Windows workspace, `corepack pnpm build`, `pnpm test:fast`, `pnpm test:repeat` (10/10), `pnpm test:recovery`, `pnpm test:resource` (15/15), `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile`, and `pnpm test:ui:visual` (101/101 native desktop assertions and zero JS exceptions) all exited 0. The unrelated unstaged `tests/v4/github-transport.test.ts` helper is excluded from this patch.

**Live GitHub E2E and clean pushed-SHA validation:** Record independently after running; compile-only is not real remote evidence. No merge/release or PR #8 promotion is implied. The user's choice for per-file Delete/Remove target remains unresolved, so no selective destructive file action is introduced.
