# Per-line conflict merge acceptance — 2026-10-17

**Maintainer requirement:** Conflict Resolution must allow selecting and combining **individual lines**, not just choosing Local / Remote / Both / Discard for an entire diff hunk. The example screenshots from `silvanocerza/github-gitless-sync` are UX references only (that repository is AGPL-3.0). All implementation is independently authored in this Apache-2.0 repository.

## UI and safety behavior

- On **Ask** conflicts of small UTF-8 text files, the native Obsidian dialog shows a side-by-side Local / Remote comparison with common context and numbered difference hunks.
- **Every changed line** has an independent accessible **Keep** and **Omit** control with visibly selected state. Decisions from one side do not automatically include/exclude the opposing side. Unreviewed lines are *not* silently discarded.
- **Keep all local / Keep all remote / Keep both sides / Omit both sides** remain available as fast hunk-level shortcuts. These shortcuts fill individual line decisions and can then be overridden line by line.
- The actual merged result is shown in an **editable textarea** after all changed lines are reviewed. Users may change text and arrange the final content manually; exactly that displayed text is committed when they click **Apply reviewed merge**. The result retains original newline delimiters in ordinary cases.
- If the user alters the merged text and later changes a line decision, **manual text edits remain intact**. The explicitly labeled **Reset text to selected lines** command discards those edits and reconstructs the result. The dialog indicates when custom text is preserved.
- Apply is disabled until all changed lines have an explicit decision. It is also disabled when the edited UTF-8 output exceeds **512 KiB**. Cancellation, close, abort, and the existing staging/publication/recovery safeguards remain unchanged. A custom merge creates no write until Apply.
- The existing bounded `256 KiB` per-input text gate and UTF-8/binary rejection remain. **Line-by-line controls are only rendered for text pairs with at most 600 lines each and at most 180,000 LCS matrix cells**; larger/more-complex text falls back to existing whole-file actions rather than rendering an unbounded number of controls.
- At desktop sizes the comparison is two columns; at narrow emulated 390px sizes the Local / Remote columns stack. The **Apply / Keep both / Use local / Use remote / Cancel command bar stays visible at the bottom while scrolling** through lines and the merged editor. This is **desktop emulation, not physical Android/iOS acceptance**.

## Regression and real native acceptance

- `tests/v4/conflict-review.test.ts` now checks mixing individual lines from both sides **within one contiguous hunk**, pending decisions, newline preservation, empty content, binary and large inputs.
- `tests/v4/sidebar-conflict-ui.test.ts` clicks each line's real stub UI buttons, verifies Apply is blocked until the last decision, checks hand-edited results, preserved manual edits after a changed line decision, explicit reset, oversized hand-edit rejection, and no-op Cancel.
- `scripts/run-ui-screenshots.mjs` opens the native plugin modal in **Obsidian Desktop 1.14.4**, clicks six separate line decisions across two hunks, proves a mixed Local/Remote result within the *same* hunk, tests custom edited text persistence and Reset, then cancels without modifying the vault or GitHub.
- Visual acceptance in disposable synthetic vault: **102/102 native checks, 21 screenshots, 0 JS exceptions**. Existing warning: Obsidian desktop Settings popout at emulated 375px leaves just 175px content; not a mobile screen-reader/physical-device pass.

Original native screenshots (synthetic conflict content, no real user secrets or GitHub writes):
- [Desktop before decisions](ui-real-screenshots-2026-10-17/31-conflict-line-selection-desktop.png)
- [Individually selected lines, editable merged output](ui-real-screenshots-2026-10-17/32-conflict-line-selection-reviewed.png)
- [390px compact layout](ui-real-screenshots-2026-10-17/33-conflict-line-selection-compact.png)

Final sticky-action-footer screenshot set from rerun **102/102**:
- [Desktop, sticky command bar](ui-real-screenshots-2026-10-17/34-conflict-line-desktop-sticky-actions.png)
- [Reviewed lines, sticky command bar](ui-real-screenshots-2026-10-17/35-conflict-line-reviewed-sticky-actions.png)
- [390px compact, sticky command bar](ui-real-screenshots-2026-10-17/36-conflict-line-compact-sticky-actions.png)

## Exact-SHA independent clean acceptance (post-push)

**Code SHA:** `856302f298a4812f5f519b0dc082d477a3a7c723` (includes the line-selection feature commit `5fb98a1` and sticky-action-footer polish). A separate detached `.tmp/conflict-line-clean-20261017` checkout was created at this exact SHA, followed by `pnpm install --frozen-lockfile`. It completed:

- Native **Obsidian Desktop 1.14.4** CDP visual runner: **102/102 assertions, 21 PNG screenshots, zero observed JavaScript exceptions**; production build included.
- `pnpm test:fast`, `pnpm test:repeat` (**10/10 rounds**), `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`: all exit **0**.
- `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile`: all exit **0**.
- After running the gates, `git status --short --branch` in the independent checkout was exactly `## HEAD (no branch)`; `git rev-parse HEAD` matched the code SHA.
- Source screenshot images 35 and 36 were fetched **back from the pushed GitHub commit** and visually inspected, confirming per-line Keep/Omit states, editable merged output, sticky Apply/Cancel actions, and narrow stacked layout.

This verification did not access live credentials or mutate GitHub data. **A newly credentialed full GitHub E2E on the exact code SHA was not run**; an earlier full GitHub E2E at another source SHA remains blocked by intermittent encrypted delete/recreate failure. Hosted CI status and physical Android/iOS acceptance are not claimed.

**Remaining release gates:** hosted CI evidence, physical Android/iOS, independent review, and root cause/mitigation for the older encrypted delete/recreate failure. PR #8 remains Draft; no merge/release. The separate Files sidebar stays read-only without Remove / bulk Delete controls.
