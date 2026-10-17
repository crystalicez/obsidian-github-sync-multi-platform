# Scalable line-level conflict review — engineering acceptance (2026-10-17)

The maintainer explicitly approved replacing the original 256 KiB / 600-line / 180,000-cell UI limitations, rather than retaining those ceilings.

## Changes

- **Diff algorithm:** replaced whole-document quadratic LCS with a patience-style sequence of unique common-line anchors and a longest-increasing-subsequence pass, with bounded LCS **only within small gaps** (≤160,000 cells per local gap). Widely separated edits across 20,000 common lines remain distinct, while 30,000 completely different lines on each side never allocate a 900-million-cell matrix. Duplicate-heavy/ambiguous regions remain one difference hunk whose **individual lines can still be selected**.
- **Cooperative execution:** large text diffs now use a generator advanced in chunks (counting/anchoring, local matrix computations and long common regions) with event-loop yields and abort checks. The synchronous version stays available for deterministic tests. Cancel during preparation returns a no-op; the final merge still uses the existing staged sync and recovery protocol.
- **Bounded DOM:** instead of mounting an entire large conflict as a DOM tree, large reviews show one change/hunk at a time, with **48 local + 48 remote line controls** per page and explicit Previous/Next change and Previous/Next lines navigation. Each line's decision is keyed by original immutable section/side/index, so paging cannot overwrite earlier decisions. Hunk-level shortcuts apply across all its pages. Large identical context is shown in a short, bounded before/after excerpt rather than thousands of DOM lines.
- **Text budget:** separate per-input text preview memory budget increased from **256 KiB to 16 MiB per side**. The editable UTF-8 merge-result budget is now **32 MiB**, replacing 512 KiB. There is **no fixed line-count rejection limit**. Non-UTF-8/binary, unsupported formats, unusually large packed groups and inputs above the in-process memory budget still keep conservative whole-file conflict choices. These budgets protect Obsidian's main process and are **not promises that every device can handle all 16 MiB inputs**.
- **Sync integration:** Ask policy now validates reviewable text extensions independently of the 2 MiB **automatic three-way merge** policy. The original automatic merge policy is unchanged. No credentialed remote deletion, content publication, or Notes Vault writes occur by merely opening the review.
- **Editing:** per-line Keep/Omit and merged-text editor remain fully supported, including preserving manual text edits across line decisions, explicit Reset, clear all-decisions-required guard, abort/Cancel semantics, and sticky Apply/whole-file actions.

## Regression evidence

The following deterministic cases were added or extended:
- 20,000 common context lines with two distant edits → two distinct hunks and round-trip to either side.
- 30,000 unrelated lines per side → one fully line-selectable hunk without large allocation.
- 250,000 unchanged context lines → no JavaScript spread/argument overflow, full local/remote roundtrip.
- 120 seeded random small pairs → all-local/all-remote hunk decisions reconstruct exact inputs.
- Generator-scheduled asynchronous review returns identical results to synchronous diff and aborts cleanly.
- 900-line-per-side native modal stub → only 96 line DOM controls at one time, navigation to line 49 works; whole-hunk shortcut finishes all decisions.
- Manually edited output over new 32 MiB UTF-8 ceiling still blocks Apply; Cancel cannot write.
- Actual native Obsidian Desktop 1.14.4 12,000-line-per-side fixture → 96 mounted rows, later page retains immutable line IDs, Cancel is a no-op.

## Verified pre-commit acceptance

- `corepack pnpm build`, `test:fast`, `test:repeat` (10/10), `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package` and `test:github-e2e:compile` all returned **exit 0** on the Windows workspace.
- Native **Obsidian Desktop 1.14.4** visual runner **108/108 assertions**, **22 screenshots**, **zero JS exceptions**; the synthetic 12,000-line-per-side conflict computed and mounted its 96 visible rows with later-line pagination functioning correctly. Cancel did not write to the vault or remote. The standing Desktop Settings 375px/175px warning remains unrelated.
- Screenshot: [real Obsidian paged conflict with a 12,000-line synthetic fixture](ui-real-screenshots-2026-10-17/37-conflict-12000-lines-paged.png).
- Source-changing tests `tests/v4/conflict-review.test.ts`, `tests/v4/sidebar-conflict-ui.test.ts` and native Electron harness are retained for repeatability, not just screenshots.
- A separate clean exact-code-SHA qualification and pushed-repository verification must be appended after committing.

**Release caution:** native visual runner uses a disposable synthetic vault, not private files. Physical Android/iOS, hosted CI, independent sign-off, and earlier intermittent encrypted delete/recreate full GitHub E2E remain open. The current API still buffers network response bodies before the preview gate; this change does not solve global GitHub transport buffering for files much larger than the review budget. No Merge/release; PR #8 remains Draft. Keep the unrelated `tests/v4/github-transport.test.ts` user WIP unstaged.
