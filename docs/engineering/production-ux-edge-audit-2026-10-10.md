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
| Realtime events / performance | Obsidian vault events → `V4PluginRuntime.enqueue()` → coordinator pending queue/debounce → progress count | Static risk analysis; large live vault-event burst benchmark not yet measured |
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

## Follow-up risks and UX decisions (not confirmed defects in this pass)

| Priority | Concrete trace / scenario | Proposed evidence or decision |
| --- | --- | --- |
| P1 performance | `V4PluginRuntime.markWaiting()` calls `beginWaitingRun()` on each idle local event; it reads `V4SyncCoordinator.pendingCount`, which re-coalesces all queued events each time. A burst of many distinct files could produce quadratic queue-processing work before the 5-second debounce expires. | Instrument 1k/10k/50k event bursts with CPU time and exact coalesced count; consider throttled/progress-only aggregation with a final exact count, without compromising sync causality |
| P1 UX/target safety | Settings tab's manual/Force operation buttons use **currently saved** credentials/scope even if visible settings fields are dirty and unsaved. The force confirmation names the saved target, but users may assume the edited target is already active. | Decide whether to disable these buttons while settings are dirty or display a prominent “Save/discard first” notice; verify exact target shown before any operation |
| P1 security/resource | General `createGitTree` semantic equivalence, buffered `requestUrl`, and remote metadata pre-parse ceilings remain prior documented residual risks. | Security sign-off or separately designed authenticated bounded proof / streaming transport; don't equate the new preview size gate with a global memory bound |
| P2 history performance | `V4HistoryService.previewChange()` currently requests a **recursive** Git tree to locate a historical blob; large repositories may trigger expensive reads or safe truncation failures. | Benchmark large-tree history navigation; redesign as authenticated bounded path traversal only if measurements support it |
| P2 UI feedback/privacy | `src/setting.tsx` copies debug payload before showing a sensitive-data warning; clipboard paste shows a 2-second message via an untracked timeout that can outlive a rerender/hide. Debug payload does redact sensitive keys. | Decide whether to ask for confirmation *before* copying debug diagnostics; add lifecycle-safe clipboard feedback when revisiting settings UI |
| P1 platform readiness | Real Obsidian rendering, keyboard navigation, screen-reader labels, narrow Android layouts, offline/reconnect, large physical file round trip and recovery are outside the stub-based gate. | Manual platform smoke matrix and device evidence before public support claims |

## Exact-source deterministic verification

The follow-up fix commit **`bc6153061e3222d3c386f466e864df9fc171ed39`** was also checked out in a detached, clean Git worktree (`.tmp/release-audit-clean-20261010`), excluding the unrelated dirty test-helper edit in the main workspace. Git status before and after was `## HEAD (no branch)`, without modified tracked files. With Node `v24.11.0` and pnpm `9.12.3`, frozen-lockfile install, build, standalone fast test, 10 repeated fast test runs, recovery, resource, feasibility, metadata validation, package validation, and all three E2E bundles' compile-only gate **all exited 0**. This is clean audit-branch source evidence; not a passing credentialed live GitHub E2E or final master release qualification.

## Verification contract

This review uses `node scripts/run-tests.mjs --tier=fast --filter=<suite>`, `pnpm build`, full fast, repeat, recovery, resource, feasibility, package validation and compile-only E2E as **non-destructive** gates. Test counts and exact SHA must be recorded in `HANDOFF-NEXT-SESSION.md` after completion. Never use `release:local`, `qualify:local`, or credentialed real GitHub E2E as routine audit smoke tests.

**Release verdict: FIX-THEN-QUALIFY.** Local code regressions can be closed through tests; final production sign-off still depends on reviewed PR #8, exact-SHA clean qualification, the disposable live GitHub target and verified cleanup, and the advertised-platform physical evidence.
