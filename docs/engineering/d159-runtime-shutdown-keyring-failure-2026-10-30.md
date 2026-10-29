# D159 — Runtime shutdown observes failed Sync and clears secrets after quiescence

Date: 2026-10-30. Scope: production normal V4 Sync lifecycle and best-effort Keyring zeroization. Existing owner-approved Node.js-first **strict** Re-encryption remains Preview-only with the release gate **blocked**. No Native Helper, GitHub Actions, real Vault/SecretStorage mutation, or live GitHub E2E.

## Confirmed failure path

`V4PluginRuntime.dispose()` calls `coordinator.dispose()` to abort active Sync and then schedules detached cleanup using `void coordinator.whenIdle().finally(() => keyringCache.dispose())`. This successfully invokes `keyringCache.dispose()` on success **or** failure, but JavaScript `Promise.prototype.finally` returns a *rejected* Promise when the original operation rejects. No caller observes the detached cleanup Promise. Thus an unexpected execution error during shutdown could generate a **second unhandled Promise rejection**, despite a caller already observing the original operation's rejection. The error path can be triggered even though most normal `V4PluginRuntime.execute()` errors are caught and reported internally.

## Narrow correction

Replace the detached `finally` with a two-branch `whenIdle().then(onResolved, onRejected)`, both invoking `keyringCache.dispose()`. This explicitly observes both completion outcomes without awaiting the shutdown from the host `onunload` callback. Secret wiping remains deferred until the coordinator active run has settled, so in-use key arrays are not zeroed prematurely. `coordinator.dispose()` still aborts active work and suppresses new work. No exception is swallowed in the original `run()` Promise returned to the caller, no remote mutation is replayed and no recovery or GitHub/CAS semantics change.

The memory wipe is **best effort**, as `V4KeyringCache` already notes: JavaScript runtime or WebCrypto may retain independent copies.

## Behavioral regression

New `tests/v4/runtime-dispose.test.ts` constructs an actual `V4PluginRuntime`, real `V4SyncCoordinator` and its existing `V4KeyringCache`, inserts five recognizable test key arrays, and controls the active executor's settlement with a deferred promise. Three tests assert:

1. **Unexpected executor rejection on shutdown:** previously in-flight keys remain intact until release; the active caller receives the original rejection, shutdown observes its own barrier rejection without throwing a detached failure, all five key arrays are cleared afterward, and no automatic retry occurs.
2. **Successful active run on shutdown:** key arrays stay intact while in flight, are cleared after completion; duplicate disposal is inert.
3. **Idle shutdown:** owned keys clear without initiating any Sync operation.

Focused suite: **3/3 PASS**.

## Limits

This corrects a specific detached error boundary and secret lifecycle. It does not prove an end-to-end OS power-loss recovery, full JVM/JS heap zeroization, external writer fence or cross-store atomic Re-encryption Cutover. Release gate remains blocked, unchanged.
