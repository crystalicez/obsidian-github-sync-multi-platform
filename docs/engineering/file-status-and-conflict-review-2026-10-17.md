# File-status sidebar and manual hunk conflict review — 2026-10-17

**Scope:** Original UI implementation for `crystalicez/obsidian-github-sync-multi-platform`, on the audit branch. Inspired by the user's screenshots and open-source references, **not a copy or translation of their source**:
- Sidebar reference: [firstsun-dev/git-files-sync](https://github.com/firstsun-dev/git-files-sync), MIT License.
- Conflict reference: [silvanocerza/github-gitless-sync](https://github.com/silvanocerza/github-gitless-sync), AGPL-3.0. We use its screenshots solely as visual/interaction inspiration; **no AGPL code is imported or copied**.

## Sidebar behavior

Configured Sync Center now opens to **Files** while retaining **Commits** and **Current file**. The Files mode has All / Changed / Local only / Remote / Synced count pills, case-insensitive path filtering, Tree/flat toggle, expandable folders, file details, and Refresh. Clicking a local file can open it in Obsidian. A bounded render shows the first 400 matches, prompts users to narrow the filter for more, and keeps counts for the full verified snapshot.

`V4PluginRuntime.fileOverview()` fetches **one exact immutable Git ref** and the pinned V4 config/head/index shards; the remote index loader authenticates the remote metadata. It never misidentifies local-only files as remotely present because of an unversioned/stale index. It rejects settings-generation changes mid-fetch. Classification compares current scoped local paths/stat with the last synced index and current remote version. **Synced is a metadata-based status, not a byte-for-byte local hash comparison**; its details state this limitation explicitly.

**Safety:** This is a **read-only file overview**. It does not implement individual Push / Pull / Delete / Remove actions yet because safe scoped writes need their own transactional semantics and review. The existing Sync now uses the normal conflict policy. A remote load error is visible, not misrepresented as an empty repository.

## Conflict review behavior

When conflictPolicy is **Ask**, the engine can now supply verified small local/remote UTF-8 text to the existing Obsidian modal, including packed records only when the entire logical pack group's declared size is bounded. It refuses text previews of oversized, non-UTF-8/binary, and large pack content; the existing safe whole-file Keep both / Use local / Use remote / Cancel choices remain available.

Text conflicts have a **desktop two-column comparison**, independent line hunks, and per-hunk **Accept local / Accept remote / Accept both (local then remote) / Discard both**. Each hunk must be explicitly decided, and a merged preview is displayed before **Apply reviewed merge** is enabled. The result is handed back as `mergedBytes` to the existing staged conflict-resolution pipeline, preserving the transaction's all-decisions-before-writes rule. Abort / modal close / Cancel resolve without writing. The algorithm has hard `256 KiB` per-file and bounded LCS matrix/line-count limits; pathological texts fall back to one explicit whole-change hunk. At ≤620px the comparison columns stack with Local/Remote labels for compact use. This is a desktop-emulated compact acceptance, **not** an Android/iOS device test.

## Tests and real UI evidence

Regression coverage:
- `tests/v4/file-overview.test.ts` — classification, search, folders/tree, unknown baseline.
- `tests/v4/file-overview-runtime.test.ts` — exact Git ref, settings-generation invalidation.
- `tests/v4/conflict-review.test.ts` — multiple hunks, mixed decisions, both/discard, Unicode, insertion/deletion, binary/oversize, matrix bound.
- `tests/v4/sidebar-conflict-ui.test.ts` — actual Obsidian-stub file chips, tree/flat, modal disabled Apply, per-hunk choice, Cancel/Abort.
- `tests/v4/sync-session.test.ts` — verified small packed conflict inputs passed to user decision, custom merged content published and applied. Updated an implementation-string signature test in `tests/v4/settings-secrets.test.ts` to bind the new preview byte args without weakening the cancellation guards.

`corepack pnpm test:ui:visual` exited 0 against **Obsidian Desktop 1.14.4 on Windows** in a separate disposable synthetic vault: **99/99 UI checks, 21 valid screenshots, 0 JS exceptions**. The extra screenshots were taken by rendering synthetic file-status evidence within the real plugin view and opening the actual native conflict modal with synthetic text, never a GitHub credential or real remote operation. This proves DOM and layout, *not* credentialed status correctness. The sole known warning remains the Obsidian desktop Settings popout leaving only 175px for plugin content at an emulated 375px window.

Actual native UI PNG evidence:

- [File tree + status pills](ui-real-screenshots-2026-10-17/24-files-tree-view.png)
- [Changed filter](ui-real-screenshots-2026-10-17/25-files-changed-filter.png)
- [Desktop side-by-side review](ui-real-screenshots-2026-10-17/26-conflict-desktop-side-by-side.png)
- [Chosen hunks + merged preview](ui-real-screenshots-2026-10-17/27-conflict-reviewed-hunks.png)
- [390px compact modal (desktop emulation)](ui-real-screenshots-2026-10-17/28-conflict-compact-390.png)

On the primary Windows engineering workspace, `pnpm build`, `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package` and `test:github-e2e:compile` all exited 0. A first fast-suite run found a stale source-regex test for the old askConflict arguments; it was updated and the full suite then passed. No unrelated pre-existing WIP (`tests/v4/github-transport.test.ts`) was staged.

## 2026-10-17 follow-up: tracked deletion semantics and wide-folder performance

Production review of the original file-status model uncovered a **potentially dangerous UX classification**: a file that was tracked in the last synchronized index but then vanished on just one side was labeled as if it were a newly discovered `Local only` or `Remote` file. That could imply the next sync would upload/download it, while the normal planner may instead propagate deletion. A failing regression was captured first, then corrected.

The file overview now labels **tracked one-sided disappearance as `Changed`**, with precise `Deleted locally` / `Deleted remotely` badges and warnings in file detail that the next sync **may propagate the deletion**. Truly new one-sided files remain `Local only`/`Remote`. When no last-sync record exists, the UI intentionally avoids claiming to know deletion history. `Synced` remains a metadata-only heuristic, explicitly disclosed in its detail text, not an independent byte-for-byte proof.

The tree builder formerly linearly scanned existing sibling nodes, producing quadratic work for large flat folders. It now uses a global path `Map` to construct the folder graph and an iterative sort traversal; regression coverage includes **12,000 siblings** without recursion or quadratic sibling lookups.

**Verification:** `tests/v4/file-overview.test.ts` includes RED→GREEN tracked-deletion cases and a 12,000-file tree, and `tests/v4/sidebar-conflict-ui.test.ts` validates both deletion labels/warnings inside the rendered UI stub. The actual **native Obsidian Desktop 1.14.4** runner now includes tracked-deletion-shaped synthetic entries and clicks each direction to assert the warning; `pnpm test:ui:visual` passed **100/100 checks, 21 screenshots, zero JS exceptions** with the standing 375px desktop Settings popout warning. Screenshot evidence: [Changed view and deletion warning](ui-real-screenshots-2026-10-17/29-files-tracked-deletion-warning.png). Synthetic UI fixtures are not proof of remote protocol correctness; exact-ref runtime tests remain separate.

**Clean baseline:** the previous implementation commit `42f20098acc4380ff5967c5c4cd2f4f9b2fd0371` was independently tested in detached clean worktree `.tmp/file-status-conflict-clean-20261017` (frozen dependencies, actual native Obsidian UI smoke **99/99**, 21 screenshots, 0 exceptions; `git status --short --branch` was exactly `## HEAD (no branch)`). **Clean follow-up qualification:** the exact pushed code SHA `3672abc04b6e0825f316b068f83f12f48bbc1be0` was installed with `pnpm install --frozen-lockfile` in independent detached `.tmp/file-status-deletions-clean-20261017`; `pnpm test:ui:visual` (includes production build) passed **100/100 native Obsidian checks, 21 screenshots, 0 exceptions**. `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource`, `validate:metadata`, `validate:package`, and `test:github-e2e:compile` all exited 0. `test:feasibility` exited 1 once with truncated diagnostic output and then **passed twice on rerun** (138/138 in a fully captured run); root cause of that one-off failure is not established and remains a test-reliability qualification item. The worktree's post-test status was exactly `## HEAD (no branch)` and HEAD remained `3672abc04b6e0825f316b068f83f12f48bbc1be0`; the pre-existing unrelated transport WIP was excluded. This is not hosted CI, a physical mobile test, or a credentialed remote E2E.

## 2026-10-17 follow-up: remote renames are not deletions

The first Files sidebar release classified a remote rename as **old path Deleted remotely** plus **new path Remote only** even when both records had the same stable V4 file ID. Such labels wrongly suggest the change is unrelated file deletion/creation and can mislead users before a potentially destructive sync.

This is a **display-only fix**. The file overview now accepts the authenticated remote and last-synced baseline `fileId` and searches for the same unique identity across distinct paths. It shows both affected paths as **Changed**, with `Moved on GitHub` (the old location) / `Renamed on GitHub` (the new location) and reciprocal path details. It does **not** reclassify records on missing identities, duplicated IDs, or ambiguous lineage; those stay in the conservative existing categories. The normal sync planner and its deletion/conflict policy are **unchanged**. This is not a three-way move-resolution implementation.

**RED→GREEN:** `tests/v4/file-overview.test.ts` first reproduced a remote rename being called `remote-deleted`; then passed the exact positive identity assertion and conservative duplicate/missing-ID negatives. `tests/v4/sidebar-conflict-ui.test.ts` verifies actual labels and cross-references. Native Obsidian Desktop smoke uses nine synthetic records including a rename source/destination and both tracked-deletion directions; `pnpm test:ui:visual` passed **101/101**, **21 screenshots**, **zero JS exceptions**. [Screenshot of real native view with synthetic rename data](ui-real-screenshots-2026-10-17/30-files-remote-rename.png). The screenshot is UI evidence, not credentialed GitHub proof.

**Local regression:** build, fast suite, repeat 10/10, recovery, resource, feasibility, release metadata/package validation, and GitHub E2E compile-only all exited 0 on the primary Windows engineering host. No destructive live GitHub test was run for this display-only update. **Exact pushed-code SHA `dcc3fc8b71155681d7814603a5885f8cee068e85` independently qualified:** detached `.tmp/remote-rename-clean-20261017` worktree, `pnpm install --frozen-lockfile` exit 0, then production build + **native Obsidian UI 101/101 checks, 21 screenshots, zero JS exceptions**, fast, repeat **10/10**, recovery, resource, feasibility, metadata/package validation, and GitHub E2E compile-only all exited 0. After the suite `git status --short --branch` remained exactly `## HEAD (no branch)` at that SHA. The screenshot was also fetched from the pushed GitHub commit and visually inspected: both rename badges and their relationship text are visible in a narrow sidebar. Unrelated local WIP was excluded. This does not constitute live GitHub E2E, actual Android/iOS validation, or hosted CI.

## Explicit remaining production work

This does **not** yet provide per-file selective remote mutations, a syntax-highlighted Monaco merge editor, true 3-way common-ancestor merge review, reviewed text for large packed/chunked objects, physical mobile acceptance, or independently approved hosted CI. Live GitHub E2E on this precise source SHA is separately qualified (or remains unverified if not executed). The previous intermittent encrypted delete/recreate incident is still open. Draft PR #8 stays Draft; do not merge or publish without signoff.
