# D156 — Contain Sync errors at UI/host callback boundaries

Date: 2026-10-30. Scope: normal production V4 Sync entrypoints, without changing GitHub publication, recovery or re-encryption policy. Re-encryption remains Preview-only and release gate `blocked`.

## Problem

D155 handled detached coordinator-run Promises created by the five-second debounce and the after-active local-change follow-up. However, `FastSync` itself used `void` at application entrypoints that invoke asynchronous operations: Ribbon, Command Palette, Status Bar, 1.5-second Startup, Scheduled interval, and the Force Push/Pull confirmation action. The Sync Center's **Sync now** button also had an unobserved `manualSync()` Promise. Normally `V4PluginRuntime.execute()` catches operation failures, but an unexpected synchronous throw or Promise rejection from a runtime adapter/callback can escape and create an unhandled rejection in Obsidian/Electron.

## Change

`FastSync.runSyncFromUi(operation)` is a deliberately small, synchronous dispatcher. It starts the operation immediately, attaches one terminal catch to the Promise, and also handles synchronous throws. A static, generic notice advises reviewing Sync status before retrying manually. Raw errors, request URLs, Vault paths, credential values, ciphertext and source filenames are never inserted into the message. A secondary exception in a Notice implementation is also contained. If the plugin has unloaded, the dispatcher rejects stale callbacks and suppresses late notifications.

All production **Sync** entrypoints now use it:
- Ribbon and Command Palette Sync.
- Status Bar click.
- Startup one-shot timer and Scheduled Sync interval.
- Sync Center **Sync now**.
- Both **Force Push** and **Force Pull** *after* the pre-existing slider unlock and explicit confirmation.

The dispatcher does not retry or replay a GitHub operation whose network outcome might be ambiguous; does not alter how the V4 runtime handles normally reported failures; does not change scheduled policy or conflict handling; and does not weaken force confirmation. Other non-Sync asynchronous UI tasks are outside this scoped change.

## Behavioral verification

`tests/v4/main-ui-sync-errors.test.ts` creates an actual `FastSync` instance with an isolated Obsidian stub environment and invokes registered Ribbon, Command, Status, Startup, Scheduled and Sync Center callbacks. It injects an asynchronously rejected Sync Promise and verifies exactly one generic Notice per failed user operation without any hidden retry. It also tests synchronous executor throws from real Command callbacks, suppresses callbacks after unload, checks successful operations produce no failure notice, and exercises Force Push/Pull **both without unlocking and after slider unlock and explicit button confirmation**. Each approved force operation executes exactly once even with double-clicks or unexpected rejection.

The test stub adds a read-only `Modal.lastCreated` pointer to let a test interact with the actual slider control; this is test-only and not production code.

The fix only addresses event-boundary rejection containment. It is not an OS-wide external writer fence, physically durable power-loss proof, or a cross-store Cutover transaction, and grants no Re-encryption publication authority. No actual user Vault, SecretStorage or live GitHub E2E writes were performed.
