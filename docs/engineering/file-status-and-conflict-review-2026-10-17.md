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

## Explicit remaining production work

This does **not** yet provide per-file selective remote mutations, a syntax-highlighted Monaco merge editor, true 3-way common-ancestor merge review, reviewed text for large packed/chunked objects, physical mobile acceptance, or independently approved hosted CI. Live GitHub E2E on this precise source SHA is separately qualified (or remains unverified if not executed). The previous intermittent encrypted delete/recreate incident is still open. Draft PR #8 stays Draft; do not merge or publish without signoff.
