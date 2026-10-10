# Production UX, UI, performance and rare-case audit — 2026-10-10

This is a **risk-based, code-path-driven** follow-up to the production-hardening audit, **not** a claim that every UI/device/network configuration has been tested. Source of truth: the GitHub audit branch `audit/2026-09-26-production-hardening`. The unrelated pre-existing local edit in `tests/v4/github-transport.test.ts` was not modified or staged by this audit.

Code and regression fixes were committed and pushed to the audit branch as **`bc61530`** (`fix: harden settings save UX and history previews`). This document and subsequent handoff updates are separate documentation-only follow-ups.

## Scope and observed paths

| Surface | Entry → state/side effect → user-facing outcome | Evidence and limit |
| --- | --- | --- |
| Settings persistence / UX | `SettingTab.updateDirtyState()` → `FastSync.saveSettings()` → runtime quiescence, SecretStorage rotation, `saveData`, settings-generation refresh → notice, controls | Instrumented end-to-end plugin entry-point tests, with a deliberately permissive runtime mock to expose the plugin-level gap; normal runtime separately blocks concurrent transitions |
| History preview / memory | Sync Center preview action → `V4HistoryService.previewChange()` → Git tree metadata → `GitHubClient.getBlob()` / codec read → display | RED/GREEN test proves early rejection for missing or known-over-limit external blob size; not a streaming-response memory guarantee |
| Sync Center error UX | Commit/history load → async provider rejection → `renderError()` → visible error + Notice | RED/GREEN test covers thrown `null` and nonempty string, in addition to normal Error instances |
| Progress UI / interaction | `V4ProgressStore` → observable snapshots → Sync Center live region, phase/counters/timings | Existing lifecycle/render tests and reviewed source; no physical Obsidian accessibility session |
| Realtime events / performance | Obsidian vault events → `V4PluginRuntime.enqueue()` → coordinator pending queue/debounce → progress count | RED/GREEN deterministic 300-event test proves bounded repeat coalescing; real 10k+ event-burst resource measurements remain outstanding |
| GitHub remote/crypto/recovery | Remote loader → sync-session authenticated publication → WAL/local IO/recovery | Existing deep hardening plus full tests; no destructive live GitHub run in this review |

## Confirmed issues and applied changes

### UX-110 — MEDIUM: Save can be submitted repeatedly while a prior Save is pending

- **Reproduction:** `tests/v4/settings-save-overlap.test.ts` calls the real plugin `saveSettings()` twice during delayed persistence using an intentionally permissive runtime adapter. Pre-fix RED observed two entries into quiescence instead of one. A second RED reproduced the Save button being recreated as enabled after the settings banner rerendered while an earlier Save remained in flight.
- **Actual runtime qualification:** `V4PluginRuntime.quiesceForSettingsChange()` already rejects a second transition. Therefore this review **does not claim** verified cross-repository corruption in the existing runtime. The confirmed defects are UI repeat submission, confusing error notices and a missing plugin-level invariant, plus the robustness risk from callers not sharing that runtime guard.
- **Fix:** `FastSync.saveSettings()` refuses overlap before side effects, and releases its guard even on rejected quiescence or failed persistence; Settings UI tracks pending Save across banner rerenders, disables Save **and Discard**, and restores controls after completion.
- **Regression:** overlapping submissions, failed save followed by a successful retry, and rapid double-click/re-render/discard interaction.

### RESOURCE-111 — MEDIUM: External Git history preview could fetch blobs without a verified size bound

- **Reproduction:** `V4HistoryService.previewChange()` previously checked `descriptor.size` (which external tree-diff generation can default to `0` when node size is absent), then fetched the full external Git blob. Thus missing-size or falsely-small descriptors could pass the 5 MiB preview preflight even when the current tree size was missing or known to exceed the limit.
- **Fix:** use the actual selected tree node and fail before `getBlob()` when its `size` is missing/invalid or larger than `V4_HISTORY_PREVIEW_MAX_BYTES`. This is a **pre-fetch shape/size gate**, not a proof that Obsidian `requestUrl` streams responses or that a dishonest GitHub response cannot exceed the advertised byte length.
- **Regression:** missing-size and 6 MiB external tree nodes with a stale `size:0` descriptor must cause **zero blob fetches**. Existing normal-sized history previews still pass.

### UX-112 — LOW: Sync Center error path could throw again or show “undefined”

- **Reproduction:** asynchronous history provider rejection with `null` causes `(error as Error).message` to throw; rejection with a string produces an undefined message.
- **Fix:** display a nonempty `Error.message` or nonempty string, otherwise a safe generic message. Keep the user-visible error panel and Notice.
- **Regression:** null/string rejection renders one understandable error and does not crash the view.

### PERF-113 — MEDIUM: Repeated debounce progress counting was quadratic for large vault event bursts

- **Reproduction:** A new real-runtime adversarial regression in `tests/v4/settings-secrets.test.ts` queues 300 distinct file modifications during the 5-second debounce and instruments `V4SyncCoordinator.pendingCount` so more than 128 full coalesces fail the test. The previous implementation requested the exact coalesced total for every event; RED failure proves work grew with every added queue item.
- **Fix:** `V4SyncCoordinator.pendingRawCount` exposes the raw queue length in O(1). `V4PluginRuntime.beginWaitingRun()` computes the exact coalesced progress count only for queues up to 128 events; larger bursts display an unknown progress total until flush. The actual queued events and final exact coalescing algorithm are unchanged.
- **Verification:** the new 300-event test is GREEN with exactly 128 expensive progress-count reads and 300 correct final coalesced entries. The Progress Store intentionally throttles sensitive progress display; the test checks the working state that the next throttle publication will expose. Physical 10k+ vault-event CPU/RAM measurement remains an independent performance qualification task.

## Follow-up risks and UX decisions (not confirmed defects in this pass)

| Priority | Concrete trace / scenario | Proposed evidence or decision |
| --- | --- | --- |
| P2 performance qualification | The quadratic repeated progress count was removed for debounce queues above 128 events (PERF-113), while exact coalescing remains at flush. | Measure 1k/10k/50k real event bursts, CPU time, resident memory, and final sync equivalence before treating the performance ceiling as validated on devices |
| P1 UX/target safety | Settings manual/Force actions continue to use **currently saved** credentials/scope even when fields are dirty. The dirty banner now explicitly warns of this, and Force confirmation names the saved target. | Maintainer decision: retain warning-only workflow or block these actions until Save/Discard; physical usability/target-review test still needed |
| P1 security/resource | General `createGitTree` semantic equivalence, buffered `requestUrl`, and remote metadata pre-parse ceilings remain prior documented residual risks. | Security sign-off or separately designed authenticated bounded proof / streaming transport; don't equate the new preview size gate with a global memory bound |
| P2 history performance | `V4HistoryService.previewChange()` currently requests a **recursive** Git tree to locate a historical blob; large repositories may trigger expensive reads or safe truncation failures. | Benchmark large-tree history navigation; redesign as authenticated bounded path traversal only if measurements support it |
| P2 UI feedback/privacy | Debug payload copies before the warning; sensitive-key redaction exists. Clipboard-paste feedback is now lifecycle-tracked with a current-view status region and cancellation on hide. | Maintainer decision: require explicit confirmation before copying diagnostic data; separately test real screen-reader behavior |
| P1 accessibility / destructive action | `FastSync.showForceConfirm()` uses a pointer-only `<div>` slider to unlock Force Push/Pull. No focusable slider, keyboard unlock handler or slider ARIA semantics are visible in this implementation; keyboard-only users may be unable to complete the guarded operation. | Maintainer UX/security design decision: provide a keyboard-accessible, equally deliberate confirmation path and validate it in real Obsidian with keyboard and screen reader before considering accessibility support complete |
| P1 platform readiness | Real Obsidian rendering, keyboard navigation, screen-reader labels, narrow Android layouts, offline/reconnect, large physical file round trip and recovery are outside the stub-based gate. | Manual platform smoke matrix and device evidence before public support claims |

## Exact-source deterministic verification

The follow-up fix commit **`bc6153061e3222d3c386f466e864df9fc171ed39`** was also checked out in a detached, clean Git worktree (`.tmp/release-audit-clean-20261010`), excluding the unrelated dirty test-helper edit in the main workspace. Git status before and after was `## HEAD (no branch)`, without modified tracked files. With Node `v24.11.0` and pnpm `9.12.3`, frozen-lockfile install, build, standalone fast test, 10 repeated fast test runs, recovery, resource, feasibility, metadata validation, package validation, and all three E2E bundles' compile-only gate **all exited 0**. This is clean audit-branch source evidence; not a passing credentialed live GitHub E2E or final master release qualification.

### UX-114 — MEDIUM: Clipboard paste completion can overwrite a newer settings form or accept non-string credentials

- **RED proof:** `tests/v4/settings-clipboard-lifecycle.test.ts` reproduced (1) an older clipboard request overwriting a reopened form after `hide()`, (2) an earlier request overwriting the more recent successful paste, and (3) JSON containing numeric owner/object token/array branch mutating the typed settings draft.
- **Fix:** a monotonically increasing paste-generation token, identity checks against the current draft, and an editable-field snapshot prevent stale results from applying after navigation, competing paste requests, or user edits during clipboard permission/read. Validate the four clipboard settings as nonempty strings before applying them together. Clipboard tips follow the current rendered view and their timers are cleaned on hide; the status area is announced politely for accessibility.
- **GREEN:** all four focused cases including a human editing fields during an in-flight paste. Secret values never appear in tip text.
- **Scope:** this closes UI draft corruption; final persistence still validates owner/repo/branch syntax and credentials. It does not attempt to infer whether clipboard contents were meant for the target repository.

### UX-115 — LOW: Late Save completion could reopen Settings after the tab was hidden

- **RED proof:** a delayed `saveSettings()` promise resolved after `SettingTab.hide()` and the old callback called `display()`, repopulating a tab whose draft had been discarded.
- **Fix:** UI view-generation guard prevents obsolete Save completions from re-rendering after hide; pending-save state still clears so reopening works. The dirty banner also states that manual and Force operations use the **last saved repository/branch/scope** while edits are pending, without silently changing what target is used.
- **GREEN:** focused Settings Save suite validates this lifecycle behavior, pending double-click guards, failed-save retry, and the target warning.
- **Deferred product question:** whether actions should be disabled entirely until Save/Discard remains a maintainer UX policy choice. No Force operations were invoked in these tests.

### Post-performance-fix exact-source evidence

The pushed performance fix commit **`d108498252704946ee0f2c33cfc59e13d6323efe`** was checked out in the detached isolated worktree `.tmp/release-audit-clean-20261010`; the worktree had **no modified or untracked source files** after the full test run. With Node `v24.11.0` and pnpm `9.12.3`, frozen-lockfile install, production build, standalone fast suite, 10/10 repeated fast runs, recovery, resource, feasibility, release metadata/package validation, and three E2E harness bundles' compile-only check all exited **0** on this exact Git tree. The pre-existing WIP transport test fixture in the primary workspace was excluded from these results. These are deterministic audit-SHA checks, **not** a credentialed live GitHub E2E run, production master qualification or real-device performance measurement.

### Clean exact-source verification for clipboard/Save lifecycle fixes

The code commit **`d8d7d83e21c22ecbc2111887e4b25ca8aa406d8a`** was checked out in a detached clean worktree at `.tmp/release-audit-clean-20261010`. Git status after testing showed `## HEAD (no branch)` and no modified or untracked source files. Using Node `v24.11.0` and pnpm `9.12.3`, **all** of these gates exited 0: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test:fast`, `pnpm test:repeat` (10/10), `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, `pnpm validate:package`, and `pnpm test:github-e2e:compile` (three bundles). The unrelated uncommitted `tests/v4/github-transport.test.ts` WIP is excluded from this evidence. This is clean audit-SHA deterministic qualification, **not** a live GitHub E2E receipt, `master` qualification, or physical Obsidian accessibility test.

## Verification contract

This review uses `node scripts/run-tests.mjs --tier=fast --filter=<suite>`, `pnpm build`, full fast, repeat, recovery, resource, feasibility, package validation and compile-only E2E as **non-destructive** gates. Test counts and exact SHA must be recorded in `HANDOFF-NEXT-SESSION.md` after completion. Never use `release:local`, `qualify:local`, or credentialed real GitHub E2E as routine audit smoke tests.

**Release verdict: FIX-THEN-QUALIFY.** Local code regressions can be closed through tests; final production sign-off still depends on reviewed PR #8, exact-SHA clean qualification, the disposable live GitHub target and verified cleanup, and the advertised-platform physical evidence.
