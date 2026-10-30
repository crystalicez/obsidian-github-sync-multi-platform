# D174 — Atomic-in-runtime Sync quiescence reservation before Re-encryption fence

Date: 2026-10-30. Status: internal guarded preparation, **release blocked**.

## Problem

D173 added a persistent one-shot Sync Fence checked by normal V4 Runtime before GitHub I/O. Its arming helper had no guarantee that a new Manual Sync or queued debounce could not start after an idle check but before the first asynchronous filesystem operation. A prior Sync may already have unknown remote publication outcomes; automatically cancelling it or dropping its pending local changes would not be safe.

## Implementation

`src/lib/v4/sync-coordinator.ts` now exposes `reserveReencryptionQuiescence()`, an **irreversible synchronous reservation for the current runtime**. It refuses an active Sync, pending file changes, a debounce timer, an after-active follow-up, an existing reservation, or disposal. Reservation happens before the caller's first `await`, so subsequent Manual/Force requests are refused as busy and Startup/Scheduled runs are skipped; automatic local-change flush cannot start. A local change arriving after reservation marks the evidence **dirty**, not silently successful. The returned assertion refuses any dirty, disposed or newly busy state. There is deliberately no automatic reservation release, including if fencing fails.

`src/lib/v4/runtime.ts` adds the internal method `armReencryptionSyncFence({runId,destinationRepoId,assertExclusiveInitiatorLease})`. It first requires the exact persistent Obsidian storage adapter captured at Runtime construction (not a changed backing adapter), a configured encrypted Source identity, a usable old-key Secret ID, and no UNC vault, active Sync, pending queue, debounce or staged file set. It captures the Source connection identity and credential generation. Then it synchronously reserves the coordinator and invokes D173's existing **one-shot** `armV4ReencryptionSyncFence()`. The lease callback rechecks quiescence and the pinned Source **before and after** each awaited lease. Even after the on-disk marker readback succeeds, it checks both conditions again before returning the nonauthorizing fence result.

Whether it succeeds or rejects after reservation, the runtime marks itself fenced and disables file watching; a failure **must not** silently unlock Sync or retry a filesystem write. It does not create a remote Backup, Destination or commit, switch SecretStorage/Settings/Index, authorize Cutover, or delete the Source/old passphrase. It is not yet connected to the Preview-only Wizard. Existing D173 startup/manual/force checks remain in place for newly created runtimes that find an on-disk fence.

**Limits:** This reservation blocks only this live V4 Sync Coordinator, not other OS processes or a second Obsidian instance. The caller-supplied cooperative lease is not a universal OS writer fence. File events that are not reported by Obsidian remain outside this specific proof; subsequent initiating-vault parity and closed-editor checks are still mandatory. If the filesystem rejected arming *before* any marker write, an in-memory reservation can remain for this runtime lifetime; a restart without a persisted fence may resume ordinary Source Sync because no migration mutation was started. A failed marker write is never retried or cleared automatically. This stage does not attach D170/D172 local Cutover to the installed Wizard; the runtime's single-segment active Index root needs an explicit, compatible mapping to the D170/D172 root validation before integration.

## Verification

- D174 Coordinator tests: an already-active Sync finishes normally and reservation refuses it; a debounce timer with queued changes must be processed rather than silently discarded; after reservation, a new local edit invalidates the proof and Manual/Startup/Scheduled/Force cannot execute.
- D174 live V4 Runtime tests: successful encrypted Source preflight writes exactly one D173 fence under the plugin adapter while Manual/Startup/Force/Scheduled calls interleave; no additional GitHub ref calls; Watch remains off; queued edits suppressed afterward; pending edits refuse arming before lease/I/O; Source settings changed during the awaited lease refuse publication; a change between the marker write and final readback refuses completion while retaining the on-disk fence; no persistent Obsidian adapter or an adapter substituted during the awaited lease refuses arming.
- Focused Coordinator/Runtime and Full Fast **1144/1144 PASS**. Recovery, Feasibility, Resource **11/11**, maximum strict TypeScript, Production Build, metadata/package validation, E2E compile-only and bounded 100,000,000-byte SHA-256 cryptographic soak are local-only qualification checks. No credentialed GitHub mutation or installed Obsidian Desktop/Mobile migration was performed.

## Next steps and release gate

There is still no independent authenticated committed local Selector/receipt, real Settings/SecretStorage/Index Cutover, installed Obsidian Wizard Run, Manual Recovery UX, cross-process fencing or Desktop/Mobile acceptance. Preserve the Source and frozen Backup; never automatically delete old secrets/branches. Keep `docs/release-gates/reencryption-wizard.json` `blocked`, with Wizard Preview-only. No Native Helper or GitHub Actions.
