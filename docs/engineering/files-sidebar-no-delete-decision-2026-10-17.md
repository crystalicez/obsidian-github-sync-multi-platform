# Files sidebar: no Remove or bulk Delete — confirmed decision (2026-10-17)

The maintainer provided a final decision after reviewing the upstream `firstsun-dev/git-files-sync` implementation: **exclude** its legacy **Remove** (local-only row) and **Delete (N)** (bulk selected files) actions from this plugin's new Files sidebar.

## Product scope

- **Include**: All / Changed / Local only / Remote / Synced counts and filters, search, tree/flat layout, folder expansion, file detail, open-local-file, refresh status, commit and current-file history, and the separate existing Ask conflict review.
- **Exclude**: any sidebar Remove, Delete (N), per-file Delete from Vault/GitHub, bulk deletion, or destructive destination chooser. Do not silently revive this proposal in a future audit or ask the user to choose A/B. This supersedes the earlier decision in historical commit `378c912`.
- **Retain**: existing V4 Sync now / normal, force, and conflict handling, including deletion propagation when the planner explicitly determines it; the scope change is only about *new sidebar controls*. Show existing `Deleted locally` and `Deleted remotely` **status labels** as safety information, not actionable Delete buttons.

## Why not copy the upstream Delete behaviors

Inspection of upstream legacy `aeb1ad0` code showed that per-file **Remove** on Local only used Obsidian fileManager trash, while bulk Delete automatically partitioned selected paths: remote-only rows were deleted remotely, other selected rows were deleted from the Vault, and moved rows were excluded. The current upstream Source Control / Sync Queue implementation uses different semantics again: `Remove from Queue` just deselects a queued change, while `Delete local` and `Delete remote` are immediate actions. We will not copy either destructive UI workflow.

It is also **not** universally true that one-sided deletion always restores the file. Existing `tests/v4/planner.test.ts` confirms normal sync may propagate a tracked local deletion to GitHub or a tracked remote deletion to the Vault; with no baseline, a local-only file may instead upload. These tests should remain because they document current safety behavior, even though no new delete controls are added.

## Implementation and release policy

`src/views/sync-center.ts` has no such buttons to remove, so **no destructive source-code change** is needed. Keep an explicit UI regression assertion that neither action appears, and preserve the user-unrelated WIP change in `tests/v4/github-transport.test.ts`.

PR #8 stays Draft; release gates (hosted CI evidence, physical mobile, unresolved encrypted delete/recreate full-suite failure) are unchanged. Historical proposal `docs/engineering/selective-delete-decision-2026-10-17.md` is removed from the active repository because its planned implementation and open A/B question have been withdrawn.
