# D231 — Sealed Source/Destination Settings Switch Plan

Date: 2026-11-02. **Public Release still blocked. No Wizard Run.**

## Why this precedes an active Cutover

The installed runtime reads and saves its V4 Index at `V4_RUNTIME_INDEX_ROOT`, while `main.ts` persists Settings separately and `saveSettings()` may rotate and scrub secrets. Switching Settings and Index without an explicit per-run transition contract could leave an old-key Source Index paired with a new-key Destination branch after a crash. The existing Sync Fence intentionally blocks these halfway states.

D230 can prove an authenticated *decision* to activate, but it does not contain the exact migration-critical Settings fields needed to reconcile a multi-write transaction. D231 closes that gap without applying the transition prematurely.

## What is recorded

The new isolated `<indexRoot>-rekey-cutover-candidate-<runId>/settings-switch-plan.json` is an AES-GCM encrypted record with the unique domain-separated HMAC key context `v4-rekey-activation-settings-switch-plan-v1`. Its canonical phase is `settings-switch-plan-sealed-not-applied`. It binds the complete D183 transaction contract, SHA-256 of D230's exact activation decision ciphertext, the immutable Source and Shadow Index roots, the exact six-field Source Settings identity projection, and its exact Destination projection. Only the branch and passphrase SecretStorage *reference ID* may change in the target; no secret values are embedded. Both Settings serializations must hash to D183's authenticated `sourceSettingsSha256` and `destinationSettingsSha256`. Manifest, Intent, encrypted Candidate Receipt/Selector and D230 decision are independently authenticated before sealing. Wrong key, ciphertext, transaction, state, or endpoint fails closed.

## Fenced staging and Restart

`src/lib/v4/reencryption-activation-switch-plan-crypto.ts` defines the immutable encrypted data model and independent cryptographic inspection.

`src/lib/v4/reencryption-activation-switch-plan-stage.ts` reuses D230's authenticated fenced session (no second owner-lock acquisition). Under one exclusive Owner Lease, it requires no previous Settings Plan; runs the complete **D229 fresh Git and local persisted proof**; re-reads D230's signed decision, the old Settings and their original exact bytes; seals and writes just `settings-switch-plan.json`; checks the exact persisted ciphertext; then runs D229 **again** and reauthenticates the stored plan. It does **not** write active Settings, Source Index, SecretStorage, Git refs, WAL, physical Sync Fence, or runtime Selector. If interrupted after the single write, the bytes remain untouched and a retry refuses to overwrite them.

`inspectV4FencedActivationSettingsSwitchPlanAfterRestart` independently reauthenticates the stored plan with D230 decision and the four historical Candidate/Intent artifacts, confirms the original persisted Settings and current complete Git Backup/Destination plus local WAL/Index/Sync Fence, then checks exact byte readback again. It returns only `authenticated-settings-switch-plan-not-applied` or `manual-recovery-required`. Both explicitly deny Commit Decision authority, local Cutover, resumed Sync, rollback, remote write and old-key cleanup. Authentication is best-effort; it is not a durable power-loss test and cannot authorize live Cutover.

## Remaining work

The next stage must implement a *genuine active-selector transaction* using these exact Settings and immutable Source/Shadow roots, retaining an independently verifiable commit receipt, checking each write/crash window on restart and making runtime load the selected root only after proof. Existing `saveSettings()` cannot be reused unchanged for a migration because its secret cleanup policy is unsafe for a rekey. These six fields are not the entire Obsidian plugin-data record: unrelated UI preferences and connection settings still need safe preservation during a future actual save. The old Source, frozen Backup, orphan Destination, both keys and full Git history remain preserved. Multi-device stale-client rejection and native Desktop/Android/iOS Obsidian acceptance are still required. Six release-gate checks stay pending, no GitHub Actions, Native Helper or live test-vault writes.
