# D225 — Live Re-encryption Settings/SecretStorage preservation under Sync Fence

Date: 2026-11-01. Scope: **installed FastSync Settings Save and V4 runtime**, not simulated candidate diagnostics. The Re-encryption Wizard remains Preview-only and the release gate remains blocked.

## Production bug / concrete user impact

D173/D174 already blocked all normal, scheduled, startup, Force Push and Force Pull Sync operations when the persistent Re-encryption Sync Fence root was present, including an incomplete directory. D223/D224 staging retained the original Source branch, Source Index, old passphrase and both encrypted keys for Manual Recovery.

**But the installed Settings Save path was not fenced.** FastSync.saveSettings could persist a new Git branch or encryption passphrase during a paused migration and then synchronously clear the previously referenced passphrase in Obsidian SecretStorage. The user would remain blocked from Sync, but the *key needed for Manual Recovery* could already be gone. A Settings Save racing the one-way migration fence arming could also change the Source settings while the migration captured its local snapshots.

## Fix

- `src/lib/v4/runtime.ts` now exposes `assertReencryptionSettingsSaveAllowed()`. Before and after each asynchronous fence-root check, it rejects when a migration arm is pending or the runtime was fenced, when the runtime was disposed, when the physical Obsidian DataAdapter is missing or substituted, or when the **persistent** fence directory or marker exists. It reuses the same fail-closed `assertV4ReencryptionSyncFenceClear` that guards live Sync, not a new interpretation of candidate/test-vector contents. All throws are handled by the existing Settings UI, which retains the user's draft.
- `armReencryptionSyncFence` publishes a synchronous, in-process `reencryptionFencePending` reservation **before its first disk await**. It clears the pending flag and sets the already-existing one-way `reencryptionSyncFenced` barrier in its `finally`, including after ambiguous writes or errors. Arm refuses to begin when a Settings Save has already started; its pinned callback also checks the same condition before and after each awaited lease operation.
- `src/main.ts` exposes the read-only `isSettingsSaveInProgress()` flag to that arming guard. `saveSettings` captures/pins the runtime, claims `settingsSaveInProgress` synchronously, and calls the runtime's read-only fence gate **before any SecretStorage allocation**, **immediately before saving plugin data**, and **after the persisted settings readback but before publishing a new in-memory configuration or clearing old credentials**. If the fence appears during an ambiguous `saveData`, it preserves both old and new SecretStorage keys, leaves the in-memory Settings unchanged, and requires Manual Recovery of the on-disk Settings outcome. It never assumes a rejected disk write means the disk remained unchanged.
- `V4ReencryptionSyncFencedError` now explains that **Settings writes** are paused too, not just Sync and Force operations.

All Settings saves, including presentation-only changes, are intentionally blocked during this unresolved migration. An eventual **dedicated authenticated Cutover transaction** must use its own guarded Settings/active Index transition, not bypass this gate via a normal user Settings Save. The normal no-fence Settings behavior is unchanged.

## Behavior-driven tests

`tests/v4/settings-secrets.test.ts` uses the *real* installed `FastSync.saveSettings` method and a real `V4PluginRuntime` constructed against the same deterministic Obsidian DataAdapter/SecretStorage fixture (not an inert test-only guard).

1. A **fresh runtime after simulated restart** refuses Settings Save for each of: root-only Sync Fence, marker-only fence, both, and an unreadable DataAdapter. Neither plugin data nor original or replacement secrets are written.
2. A missing/swapped backing Obsidian adapter fails closed, including a swap performed from inside the asynchronous fence read.
3. When a migration is waiting on its initiating-device lease and the persistent fence **does not yet exist**, the synchronous pending-arming reservation refuses an interleaved Settings Save before allocating a key. After releasing the lease, the Sync Fence is present on disk.
4. When a real Settings Save is already inside its awaited disk write, a concurrent migration arming attempt is rejected *before* acquiring its lease or creating a Sync Fence; the Settings Save completes normally.
5. If an external fence appears **inside the settings disk-write callback** before its acknowledgement, Settings Save does not publish the new branch/passphrase or scrub the old key. Both old and candidate secrets are preserved for a manual comparison against the potentially updated plugin-data file.

This suite does not claim real OS power-loss durability, exclude non-cooperating Obsidian processes from changing Settings outside the plugin, or authorize an interrupted Re-encryption to resume.

## Release status / next critical work

D225 improves a **real installed runtime and Settings path** but still does not create authoritative committed Receipt/Selector records, a restart-safe Source→Destination Settings/SecretStorage/Active Index transaction, multi-device stale-client Cutover, a real Wizard Run, or native Desktop/Android/iOS migration acceptance. `docs/release-gates/reencryption-wizard.json` must remain `blocked` until each actual check passes. Preserve the independently writable old Source, pinned frozen Backup, new orphan encrypted Destination, old/new keys and Git history. No GitHub Actions, Native Helper, real user Vault or credentialed GitHub mutation, branch deletion, force push, merge or Release.
