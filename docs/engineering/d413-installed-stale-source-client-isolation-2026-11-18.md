# Stage D413 — Installed two-vault stale Source client isolation before Cutover

Date: 2026-11-18 (Asia/Bangkok). Scope: release-critical multi-device integration evidence and clear Wizard UX, **without Cutover or public Execute**.

## Prior state and user impact

D412 already proved the installed Windows Obsidian Source → immutable frozen Backup → new-key encrypted Destination rehearsal plus post-restart Recovery in a single synthetic initiating Vault. D376 had proved stale-client branch isolation via standalone GitHub E2E fixtures, but no two **separately installed and simultaneously running Obsidian Desktop Vaults** had proven the scenario. A real user can leave an older device on the old-key Source; edits made after the pinned migration snapshot are not automatically copied into the new-key Destination. The Wizard's initial Preflight and Finish pages did not communicate the potential data divergence clearly enough.

## RED → GREEN: preview warning

Added the `D413 Wizard warns stale Source-device edits do not migrate automatically before verification and at planned finish` regression in `tests/v4/reencryption-wizard-ui.test.ts`. Before the UI patch, Preflight did not disclose this risk; focused test `1dbbeabd-93d1-4f59-8710-ff67b796c413` exit 1 (true RED). Changed `src/views/reencryption-wizard.ts` to warn at **Preflight**, before any remote source I/O, and at **Finish**: stop Sync on other devices; they can continue writing old Source after snapshot; such changes do **not automatically cross into Destination**; preserve branches and review divergence before reconfiguration. Wizard remains Preview-only, no new action, cutover or secret storage writes. D413 focused test `d0335987-4f14-46b1-87f8-36eec128e090` **1/1 PASS**; full Wizard `10de706d-da69-443a-85b1-b633c10ac21a` **34/34 PASS**.

## Installed native two-device acceptance extension

Extended `scripts/run-obsidian-disposable-precutover-rehearsal.mjs` with an explicitly opt-in `--stale-client` mode. The original default D412 behavior is retained. The native mode:

1. Uses **only** preapproved disposable repository numeric ID **1284153873** with unique `obsidian-sync-e2e/local-*` Source, frozen Backup and orphan Destination refs. Verifies all three refs absent twice before any write; never targets canonical/default or an actual user's Vault.
2. Creates **two independent temporary Obsidian Vaults and Electron user-data profiles**, starts two actual `Obsidian.exe` processes on distinct preflight-checked local debugging ports, installs the production bundle in both.
3. Seeds the old-key encrypted Source from the initiator. The second installed client performs a real authenticated old-key Force Pull and retains its old Source branch, old passphrase and pre-rekey local Sync Index in memory **while the initiating Obsidian executes the D412 pre-cutover sequence**.
4. The initiator creates an authenticated frozen Backup, new-key staged blobs, scratch restore, zero-parent Destination, persisted WAL and active Sync Fence; closes and restarts. Verifies the installed pre-cutover recovery proof again, without enabling Settings/Index/Selector/SecretStorage Cutover.
5. The **still-live second old-key client** modifies a real note and invokes installed `manualSync()` to publish a new commit on old Source. Independently rereads GitHub refs and requires old Source HEAD to advance, while verified Backup remains the original pinned commit and Destination remains exactly its new-key candidate. No automatic reconfiguration or cross-branch merge occurs.
6. Restarts the initiating Obsidian *after* the old Source advances and confirms the persisted Fence still blocks Settings/Sync/Cutover, original Source settings and passphrase remain selected, the initiating note stays unchanged and no Sync begins.
7. Kills **all** tracked synthetic Obsidian PIDs even on failure; confirms each of the three test-only GitHub branches is absent on two independent reads after deletion; removes temporary Vaults and profiles. A failed or uncertain cleanup forces failure and preserves uncertain local artifacts for manual inspection, never claiming success.

## Negative evidence and careful interpretation

An initial version tried to SIGKILL the newly configured stale profile immediately after its first Force Pull, then restart it after migration. It observed saved old Source branch and SecretStorage IDs but **no hydrated GitHub token or old passphrase after abrupt termination**. The test **failed closed before attempting the stale-client write**, and verified all remote test branches deleted twice; process `2fadfab9-7c34-47af-94e1-e7a59eb61eac` exit 1, `remoteCleanupErrors:0`. This shows the limitations of process-kill persistence for freshly created Obsidian SecretStorage in this synthetic profile; it does **not** establish whether a normally shut-down device would lose secrets. Do not remedy this by persisting plaintext credentials or claiming physical power-loss durability. The final acceptance uses the **intended stale-client scenario**: the older device remains active, preserving its own connection, while the migration occurs on another device.

## Actual live pass

`node scripts/run-obsidian-disposable-precutover-rehearsal.mjs --stale-client`, managed process `338ca5a5-ca8b-4d39-ba2d-bdcea4a71fe7`, **EXIT 0**, terminal `D413_LIVE_OBSIDIAN_STALE_SOURCE_ISOLATION_PASS`. The JSON report confirms `secondInstalledObsidianVault:true`, `staleClientUsedOldSourceAndKey:true`, `staleSourceCommitAdvanced:true`, `frozenBackupUnchanged:true`, `destinationUnchanged:true`, `initiatingDeviceStillFencedAfterRestart:true`, `autoCrossBranchMerge:false`, `finalWalGeneration:12`, `verifiedFileCount:2`, `verifiedPlaintextBytes:"2116"`, `postRestartObservation:"authenticated-pre-cutover-destination-still-fenced"`, `cutoverAuthorized:false`, `uiExceptions:0`. The Source, Backup and Destination refs `obsidian-sync-e2e/local-3f3bec138e88-ade10daaad328f7c`, `obsidian-sync-e2e/local-backup-fca61476695dd40b074a34d6727a504e`, `obsidian-sync-e2e/local-destination-1cb832081dc78bfb8dbace58a1f8e27c` were all `CLEANUP_VERIFIED_TWICE`; final `status:"PASS"`, `cleanupState:"temporary-vault-removed"`, `remoteCleanupErrors:0`.

## What this does *not* prove

This is a Windows Desktop **pre-cutover isolation** test. It does not show an installed old device safely joining a completed Cutover, fresh-device new-key Sync after persisted branch switch, restart-safe local Index/Settings/SecretStorage activation, physical Android/iOS acceptance, or guarantees across actual sudden power loss. `docs/release-gates/reencryption-wizard.json` must remain `"status":"blocked"`; no Wizard Execute, automatic Cutover, old-secret deletion, or release is authorized. The owner's unresolved post-commit `V4SyncSession.cleanupStages` status reporting policy is not changed.

## Next release-critical milestone

Integrate and prove an **isolated, restart-safe initiating-device Cutover transaction** (Settings, Index/Selector, SecretStorage and startup routing) after full Destination integrity verification, with manual-recovery behavior for interrupted phases and a test stale client. Keep public Wizard Execute disabled until actual release criteria and cross-platform acceptance pass.
