# Full UI Surface Audit — 2026-10-10

**Repository:** `crystalicez/obsidian-github-sync-multi-platform`
**Branch:** `audit/2026-09-26-production-hardening` (draft PR #8)
**Scope:** Exhaustive **source-level** enumeration of UI entry points in `src/main.ts`, `src/setting.tsx`, `src/views/sync-center.ts`, `src/lib/v4/runtime.ts`, `src/styles.scss`, and the actually distributed `styles.css`; targeted RED/GREEN deterministic UI stubs where valuable.

**Important qualification:** This is **not** a claim to have visually tested all pages inside an isolated Obsidian deployment. The connected Windows host has an existing Obsidian window associated with a user's separate vault. We did **not** alter, navigate, or capture that unrelated workspace. Production plugin screens, device layout, real focus navigation, touch behavior, Obsidian theme interaction and screen-reader output still require a disposable dedicated vault and physical Desktop/Android acceptance.

## UI coverage inventory

Evidence labels: **T** = targeted deterministic RED/GREEN regression; **S** = reviewed source/state behavior; **V** = real Obsidian visual/interaction test still required. `T` and `S` do not imply `V`.

| UI page / surface | Entry points and states reviewed | Evidence | Remaining qualification |
| --- | --- | --- | --- |
| **Settings — General** | Enable synchronization; Show status bar; persisted-vs-draft dirty banner; Save, Discard; pending/failed/hidden Save | T/S | V: dark/light theme, zoom, keyboard focus, narrow/mobile |
| **Settings — GitHub Connection** | PAT URL, Paste remote configuration, owner, repository, branch, masked PAT field, remote namespace; invalid JSON; permission failure; stale/reordered async replies; user edits during await | T/S | V: clipboard permissions/feedback, mobile keyboard, secret masking |
| **Settings — Encryption** | Encryption toggle, conditional passphrase, unsaved edits, mode change rerender | S | V: password manager/autofill, switching modes, clear disclosure |
| **Settings — Manual & Force Operations** | Sync now, Force push, Force pull; saved target vs dirty draft warning; confirmation target/generation binding | S/T for dirty warning | V; maintainer decision warning vs blocking actions |
| **Settings — Automation & Exclusions** | Startup/local-change/scheduled toggles; conditional schedule interval; multiline ignore regex; configuration/bookmark/plugin scopes; mass-change threshold; conflict policy dropdown | S | V: all toggles/fields, validation feedback, conditional focus and mobile resize |
| **Settings — Support & Debug** | Verbose logging; Copy debug (successful redacted copy vs clipboard denied); developer console hint; Ko-fi link | T/S | V: clipboard UX, link navigation, privacy sign-off before share |
| **Sync Center — shell/nav** | Commits and Current file mode, active/pressed selection state; Sync now; progress area and lifecycle | T/S | V: keyboard navigation and 320px mobile width |
| **Sync Center — Commit History** | Loading, no commits, pages, prev/next, selected commit; out-of-page selected content; empty-file-change result | T/S | V: long commit names, slow connection, many commits |
| **Sync Center — Commit Details** | Changed file count, action/kind badges, rename path, list row interaction, no file changes message | T/S | V: long path wrapping, badges and contrast |
| **Sync Center — Current File** | No active file, unsynced file, loading versions, no versions, version rows | S | V: focus/active file behavior while Sync Center is open |
| **Sync Center — History Preview** | Loading, text, image object URL lifecycle, binary byte count, oversized/missing-size external blob rejection, stale requests/errors | T/S | V: image sizing, very long text, custom zoom/contrast, object-URL cleanup |
| **Sync Center — Live Progress** | Idle/waiting/active/success/no-change/failed, counters, paths, failure context, timings, live region subscription & throttling | T/S | V: screen-reader announcements, high-frequency updates, small-window scrolling |
| **Status Bar** | Status formatting, success/error/idle/active, visibility toggle, keyboard and pointer start, busy protection, unloaded plugin guard | T/S | V: native focus ring, screen reader, Obsidian status-bar density |
| **Ribbon** | Manual sync, Force push/pull, Open Sync Center, configured/unconfigured icon/labels | S | V: theme contrast, tooltip, touch/keyboard accessibility |
| **Command Palette** | Manual sync, Force push/pull, Open Sync Center via registered commands | S | V: discoverability and command navigation |
| **Force confirmation dialog** | Repo/branch/local count, slider/pointer/cancel/late-generation recheck, hidden confirm action | S | **P1 accessibility:** pointer-only unlock still has no keyboard-equivalent path; design and real-device safety testing required |
| **Conflict resolution dialog** | Keep both, Use local, Use remote, Cancel, closed/abort settlement | S + prior contract tests | V: keyboard focus, choice clarity, long paths |
| **Change-threshold override dialog** | Percentage warning, Cancel, one-operation Override/Force button, abort/close | S + prior contract tests | V: visual warning hierarchy and focus |
| **Notices & errors** | Saved/failed Settings, history-load null/string errors, runtime sync errors, unknown clipboard state, no-change notices, old secret scrub warning | T/S | V: notification timing/toast overlap |
| **CSS and layout — published asset** | Shipped stylesheet vs SCSS, Settings headings/dirty banner, responsive Save/Discard, Sync Center grid/long filenames, reduced-motion fallback, modal slider, no unrelated Markdown image selectors | T/S | V: desktop dark/light, mobile width, OS reduced-motion, CSS selector theme compatibility |

## Confirmed fixes in this pass

1. **UI-116 — MEDIUM CSS source/distribution drift:** `pnpm build` checks/compiles TS but does not regenerate `styles.css`. The distributed asset lacked Settings headings and dirty-banner styling present in `src/styles.scss`. SCSS also contained *global Markdown image selectors* that would alter unrelated note content if compiled. RED/GREEN stylesheet contract tests were added; the source global rules were removed, CSS shipped with the plugin now contains the missing Settings styles, mobile banner layout, and a reduced-motion fallback. Source force-confirm styling also restored, eliminating inverse drift for that component. `styles.css` no longer points to a nonexistent `styles.css.map`.
2. **UI-117 — MEDIUM Sync Center stale selection / empty state:** Paging could show a previously selected commit's file changes on a different page. A 0-change commit lacked an explanatory result. Targeted regression confirmed both RED; fix clears out-of-page selection and explains empty changes, with GREEN tests.
3. **UI-118 — LOW Status Bar keyboard access:** Clickable span was not focusable or keyboard-operable. Added `role=button`, `tabindex=0`, action label and Enter/Space handler sharing pointer/busy/unload guard; targeted RED/GREEN regression.
4. **UI-119 — LOW Copy Debug feedback and failure:** Clipboard write rejection escaped the click handler, and the success Notice did not explicitly confirm completion. Redacted-payload copy now reports success *after* the awaited write; unavailable/rejected writes show an explicit failure Notice and reenable the button. Targeted RED/GREEN tests.
5. **UI-120 — LOW Sync Center mode/long-path usability:** Mode controls lacked active-state semantics and wide header actions / long change paths risked clipping on narrow windows. Added `aria-pressed` for active mode and responsive header/action wrapping and long-path breaks to both SCSS and distributed CSS. Targeted mode and style contract tests.

## Unresolved and deliberately deferred

- **P1 / requires design:** Force Push/Pull confirmation slider requires pointer dragging, with no accessible keyboard/unlock route. Adding an easy bypass without a deliberate alternative could weaken destructive-operation consent. Decide an equally intentional accessible confirmation design and validate on real hardware before release.
- **P1 / physical validation:** No isolated Obsidian Desktop/mobile visual inspection on the exact branch, so no claim of full UI appearance, WCAG compliance, contrast ratio, touch target sizes, or mobile accessibility.
- **P2 / product decision:** Whether to forbid all Manual/Force operations while Settings has unsaved repository/branch/scope changes, rather than retaining current explicit last-saved-target warning.
- **Build workflow — resolved in follow-up:** Previously `pnpm build` did not compile SCSS and `devcss` called an undeclared Sass binary. The follow-up pins Dart Sass 1.93.2, generates `styles.css` during every production build, and adds an exact Sass-output-vs-tracked-CSS test. Future release checks must still verify a clean generated asset in the exact-source checkout.
- **P2 / functional performance:** Very long history previews can generate large `<pre>` DOM nodes; real-device profiling needed before changing preview limits/truncation UX.
- **P2 / communications/privacy:** Copy Debug still requires a maintainer decision whether warning/consent should appear **before** placing diagnostics on clipboard. Key sanitization was tested but metadata may still be identifying.

### 2026-10-16 independent quality challenge — reproducible published CSS

The previous selector-presence CSS tests were insufficient: when pinned Dart Sass `1.93.2` compiled `src/styles.scss`, its **complete output did not match** the tracked `styles.css`, even while all class-existence tests passed. This was a confirmed **RED**. The new `styles.css` content is built automatically through `pnpm build:css` (invoked from `pnpm build`) and checked byte-for-byte modulo Windows line endings using the same pinned compiler. It produces **GREEN 6/6** focused CSS checks, including a regression that enforces `styles.css text eol=lf` in `.gitattributes`. Both the missing Sass package used by the old `devcss` command and Windows `core.autocrlf=true` generated-file dirtiness have been addressed.

**Clean SHA evidence:** code commit `dccc9eaa8b6328dffd28f2aa1998a1decb46dc5a`, standalone detached checkout `.tmp/release-audit-clean-20261010` with Git status `## HEAD (no branch)` after `pnpm build`, Fast tests and repeat 10/10. A frozen install, `pnpm build`, Fast suite, Repeat suite, Recovery, Resource, Feasibility, `validate:metadata`, `validate:package`, and three E2E harness compile-only bundles all returned exit code 0. Primary workspace's unrelated `tests/v4/github-transport.test.ts` WIP was not staged, included or changed.

**Real-UI limitation:** a separate Windows Obsidian 1.14.4 process with isolated profile was launched, confirmed on CDP as an Obsidian starter page, and a project-local synthetic vault was prepared at `.tmp/ui-acceptance-20261010-vault`. The native Windows folder picker did not complete reliably; the **plugin's actual Settings, Sync Center and modals were not rendered or visually inspected**. A successful app launch is **not** a visual acceptance pass, and the user’s normal vault was not used.

### 2026-10-16 — actual Obsidian Desktop screenshot verification

A reproducible **visual smoke script** now exists: `scripts/run-ui-screenshots.mjs` (via `pnpm test:ui:visual`). It launches real **Obsidian 1.14.4 on Windows** with a strictly project-local synthetic vault and separate Electron profile, safely enables the plugin in that profile, discovers the **separate Settings popout** in CDP, checks DOM/layout/locked Force dialogs, and stores actual PNGs plus a structured `report.json`. **A fresh-profile run passed 29 protocol/DOM checks and captured 12 images, with no observed JavaScript exceptions.** Selected synthetic-only screenshots and invocation guidance: `docs/engineering/real-obsidian-ui-visual-evidence-2026-10-16.md`.

**Confirmed visual findings:** UI-122 MEDIUM, Sync Center's real 300px sidebar had only 276px of layout width, but demanded 220px+300px columns; its detail overflowed beyond the dock. Sidebar-relative container queries now keep the pane inside its bounds (verified `detailRight === layoutRight` at 1012px), RED/GREEN. UI-123 LOW, redundant inline-error Toasts obscured controls; the inline error remains but the duplicate Toast is gone, RED/GREEN. **Open:** UI-124, Obsidian's desktop Settings at CDP-emulated 375px retains its navigation and leaves only 175px for the plugin form; **not** Android/iOS acceptance. UI-125, unconfigured Force modal shows `Repository: /` and still uses pointer-only unlock; the runner checks locked state and only clicks Cancel.

Screenshots and deterministic checks are **not** credentialed GitHub E2E, native mobile/device accessibility proof, or stable release qualification.

## Acceptance checklist in a disposable vault

- Windows Desktop: dark and light themes, 320–480px narrow pane, 100%/200% zoom; Settings all sections and dirty/clipboard/save states; every Sync Center state; error/empty/failed; status bar, ribbon, command palette.
- Keyboard: Tab/Shift+Tab, Enter/Space through all non-destructive buttons, focus retention on async transitions, Cancel/Escape in modal; **Force slider is a known P1 blocker** until designed.
- Android: Settings scroll/soft keyboard overlays, button hit targets, portrait/landscape, responsive master/detail, image/text history previews, touch slider/cancel.
- Real network: missing auth, offline/reconnect, rate-limit, slow responses, massive commit/file history, recovery notice and conflict/cancellation.
- Document evidence with exact source SHA, screenshots from **test data only**, host/Obsidian version/theme/window/OS, passes and reproductions before changing advertised platform claims.

### Completed clean-source verification

Pushed implementation/report commit **`13dce59e3364ae7ec360c35435f074115bf3628a`** was checked out in detached worktree `.tmp/release-audit-clean-20261010`. `git status --short --branch` showed exactly `## HEAD (no branch)` **after** the gate run, with no other modifications. Node `v24.11.0` / pnpm `9.12.3`: frozen install, build, fast **571/571**, fast repeat **10/10**, recovery, resource, feasibility, release metadata/package validation and three GitHub E2E compile-only bundles all returned **exit code 0**. No credentialed E2E mutation, hosted CI qualification, master merge, UI screenshot validation or physical device test was performed. The pre-existing uncommitted `tests/v4/github-transport.test.ts` WIP in the **primary** workspace was excluded from this clean Git tree.

## Verification and PR gates

Run focused `ui-styles-contract`, `sync-center-progress`, `main-progress`, `settings-debug-copy`, `settings-save-overlap`, and `settings-clipboard-lifecycle` tests, then `pnpm build`, `pnpm test:fast`, repeat x10, recovery, resource, feasibility, metadata/package and compile-only E2E. Verify in a **clean detached checkout** of the pushed code SHA. This is a local code audit; it does not authorize live-GitHub mutations, merging PR #8 or a stable release.
