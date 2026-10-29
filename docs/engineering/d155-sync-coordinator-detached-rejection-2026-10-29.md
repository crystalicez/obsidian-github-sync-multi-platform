# D155 — Contain detached automatic Sync errors (normal Sync)

Date: 2026-10-29. Scope: existing production V4 Sync Coordinator, **not** Re-encryption execution. Owner-approved A remains Node.js-first strict crash-safe, Re-encryption Preview-only, release gate `blocked`. No GitHub Actions, Native Helper, live GitHub writes or actual vault mutation.

## Finding

`V4SyncCoordinator.enqueue()` schedules a debounce callback that executed `void this.flushLocalChanges()`. A second `void this.flushLocalChanges()` occurs in the `finally` handler of an active run to replay local changes received while the first run was active. Both are detached: if `options.execute()` fails exceptionally (including a synchronous throw converted to a rejected Promise by `start()`), there is **no observer for that background Promise rejection**. Node/Electron can treat this as an unhandled rejection, potentially destabilizing the plugin. The normal runtime usually catches and reports operation errors, but this escape path exists for unexpected failures or custom execution adapters.

## Fix

Both detached launch sites now pass the returned Promise to one `observeBackgroundRun()` helper. The handler attaches a terminal rejection observer immediately; while the coordinator is still running, it reports a **generic fixed Notice through the existing `options.notice` hook**. It never interpolates raw errors, vault paths, encrypted names, passphrases or token-bearing HTTP response data. The detached notification handler is also exception-contained so an unusual throwing Notice adapter does not cause a secondary unhandled rejection.

Crucially, the handler **does not retry** after an ambiguous failed GitHub mutation, does not silently restore the consumed causal queue, does not alter Sync planning/CAS semantics and does not modify caller-observed `run()` Promise rejection for Manual/Force operations. When a run is disposed, pending queues are cleared as before and stale detached failure Notices are suppressed. Existing progress/error UI within `V4PluginRuntime.execute()` remains authoritative for normal operation failures.

## Regression proof

`tests/v4/sync-coordinator.test.ts` now tests:
1. A real FakeTimers debounce callback whose `execute()` rejects unexpectedly: one generic sanitized Notice, exactly one execution, no automatic replay, then a new user-initiated Sync succeeds.
2. Local file rename arriving during a manual Sync, and a follow-on after-active run rejects: the first run succeeds for its caller, the follow-up has no unhandled rejection or blind repeat, user can explicitly start another run.
3. An explicitly requested Manual Sync still rejects to its caller without a background Notice; after disposing with a detached error in flight, no stale Notice appears.

These tests exercise the real asynchronous coordinator and event loop rather than replacing the rejection handler with a mock. The suite was initially verified as **25/25 PASS**.

## Limits

This only contains an unexpected error from *automatically detached coordinator work*. It is not a remote write retry policy, proof of overall normal Sync crash safety, nor an OS-wide writer fence. Other explicit `void` callers must be audited separately, particularly where application callbacks call `manualSync()` and rely on the runtime's existing catch path.
