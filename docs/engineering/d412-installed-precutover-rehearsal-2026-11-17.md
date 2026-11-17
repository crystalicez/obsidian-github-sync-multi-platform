# Stage D412 — Installed-owner pre-cutover Re-encryption rehearsal and post-restart recovery

Date: 2026-11-17. Scope: connect the installed desktop `V4PluginRuntime` to the full pre-cutover three-branch Re-encryption sequence without authorizing Settings, local Index, or SecretStorage Cutover. Release gate `docs/release-gates/reencryption-wizard.json` remains `blocked`.

## Gap addressed

Before D412, `V4PluginRuntime` only exposed individual primitives (`armReencryptionSyncFence`, `createReencryptionInitiatorLocalReader`, `openNewReencryptionDesktopWalForArmedRun`), while the full Source to Backup to Staging to Scratch Restore to Candidate to Destination pipeline only ran in standalone Node E2E harnesses (`tests/github-e2e/v4-real-github-e2e.test.ts`). No installed Obsidian runtime session had executed that full pipeline or verified post-restart recovery without Cutover.

## Implementation

- `src/lib/v4/reencryption-installed-rehearsal.ts` models the pre-cutover rehearsal as a linear phase state machine (`idle`, `source-verified`, `fenced-and-wal-opened`, `backup-created`, `staged`, `scratch-restored`, `candidate-prepared`, `destination-published-no-cutover`).
- `runV4InstalledPreCutoverRehearsal` verifies repository identity and double-checks absence of both Backup and Destination branches before arming the Sync fence. It validates the three-branch draft and PBKDF2 policy (`>= 600,000` iterations), arms the persisted Sync fence and desktop WAL, creates and verifies the frozen Backup, stages new-key Git Blobs, executes isolated scratch restore, prepares the zero-parent orphan commit, checks physical Vault parity via `createReencryptionInitiatorLocalReader`, and publishes the Destination ref while holding the same live owner lease. All temporary key material is wiped in `finally`, and `cutoverAuthorized`, `localCutoverExecuted`, `resumeSyncAuthorized`, `oldPassphraseCleanupAuthorized`, and `powerLossDurabilityProven` stay `false`.
- `inspectV4InstalledPreCutoverRecoveryAfterRestart` performs read-only post-restart verification before any Cutover route or Settings intent exists. It requires `V4ReencryptionSyncFencedError`, `"fenced-before-routing-intent"` route observation, matching persisted fence identity, absence of partial Cutover artifacts (`contract`/candidate, shadow index, selector, runtime route), authenticated WAL receipts at the expected generation, full Backup readback, and 1:1 per-file and ciphertext-object cross-verification against the zero-parent Destination commit (including KDF iteration minimum and distinct salt).
- `src/lib/v4/runtime.ts` adds internal desktop methods `runFencedReencryptionPreCutoverRehearsal` and `inspectFencedReencryptionPreCutoverRecovery` that bind plugin settings, generations, `platformIo` isolated scratch staging, and `openV4DesktopPluginWalForRecovery` without modifying `V4ReencryptionWizardModal` execution gates or `V4SyncSession.cleanupStages`.

## Verification scope

- Offline RED to GREEN regression suite `tests/v4/reencryption-installed-rehearsal.test.ts` (4 tests) covers full happy path plus post-restart fence and recovery, pre-existing branch refusal before fencing, physical Vault drift rejection prior to Destination publication, and fail-closed post-restart rejection on wrong passphrase, partial Cutover artifacts, and corrupted WAL slots.
- Live disposable desktop verification `scripts/run-obsidian-disposable-precutover-rehearsal.mjs` exercises real Windows `Obsidian.exe` against the approved disposable repository ID `1284153873` (`obsidian-sync-e2e/local-*` branches with double-verified absence before and after cleanup), terminates and relaunches Obsidian, confirms `inspectFencedReencryptionPreCutoverRecovery`, and verifies Wizard Preflight blocks `Verify source` without leaking secrets.

## Remaining release blockers

This rehearsal does not authorize Cutover, Wizard Execute, or first public release. Six checks in `docs/release-gates/reencryption-wizard.json` remain `pending`: `safePreviewAndBackup`, `completeReencryptionAndIntegrityVerification`, `interruptedMigrationRecovery`, `multiDeviceCutoverAndStaleClientSafety`, `gitHistoryAndOldKeyDisclosure`, and `nativeDesktopAndMobileAcceptance`. Post-commit `V4SyncSession.cleanupStages` status reporting policy remains unchanged pending owner A/B decision.
