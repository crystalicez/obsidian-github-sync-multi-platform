# D398: recheck physical Source before installed Backup WAL handoff

Date: 2026-11-11. Local D87 audit worktree only. Release gate remains **blocked**.

## Why this test exists

D397 proved that an independently verified encrypted GitHub Source and frozen Backup can be bound to the same installed Windows Obsidian runtime and its OS-locked encrypted WAL, with a verified Backup receipt and one-shot Staging handoff at WAL generation 4. Its physical Source parity scan happened **before** WAL authoring. A local note might change between that scan and the Backup handoff.

D398 adds a second real `verifyTransferredAuthenticatedSourceParity()` scan with the **same `V4PluginRuntime` reader and initiating lease**, directly before opening the native WAL writer. This is a test-only installed integration requirement, not a new production migration entrypoint.

## Negative scenario

The approved disposable GitHub E2E parent uses the same preflight-absent Source and frozen Backup branches as D397. It independently authenticates both remote records and gives the installed child a SHA-256-bound, token-free manifest. In the new `backup-prehandoff-drift` mode:

1. The installed plugin arms its Sync fence and completes the first actual physical-Vault parity scan against the pinned GitHub Source.
2. The test mutates exactly one byte of the disposable note without changing its UTF-8 length. This happens **after** the first scan, **before** the second scan or any WAL writer creation.
3. The same runtime-owned physical reader performs a second scan and must reject the changed note by its SHA-256 content hash. The test checks both encrypted WAL slots are absent and no GitHub token is configured.
4. The installed test process closes; its temporary Vault and profile are deleted. The test parent and the outer wrapper must verify the GitHub Source and Backup branches are each absent twice. The refused run does not auto-resume Sync, publish Destination, or change local Settings/Selector/Index.

The positive `backup`, `backup-tamper`, and `backup-revoke` D397 modes also perform this second parity scan before WAL creation. They still check a real process restart and the generation-4 WAL readback. The D398 negative mode intentionally has **no WAL to restart/read back**.

The remote parent is the only entity with GitHub credentials and is responsible for authenticating the Backup. The installed child never gains a GitHub token or initiates remote mutation. A digest-bound manifest is not a production trust source and cannot grant Cutover.

## Validation

- `node --check scripts/run-obsidian-disposable-wal-authoring.mjs` task `20e96920-5ff6-4b7e-bcea-f170cfb6ca94` **EXIT 0**.
- `pnpm typecheck:github-e2e` task `52f4996d-949d-4db2-9d33-723310f458a8` **EXIT 0**.
- `pnpm test:github-e2e:compile` task `412f756b-5716-40a3-839b-f25c92928972` **EXIT 0** for all three E2E entrypoints.
- `pnpm typecheck:max-strict` task `cbc5aabe-e823-4345-9e30-6f49c8ae4adf` **EXIT 0**.
- `git diff --check` task `f0b7a6de-caf7-4dd3-9cde-22e572f17764` **EXIT 0**, with Windows LF/CRLF notices only.
- **LIVE E2E PASS:** `node scripts/run-github-e2e-disposable.mjs installed-source-backup-handoff-encrypted`, final task `e6e9a6e1-837a-4d8b-9c08-b7d20410af6c`, **EXIT 0**, one focused GitHub E2E **1/1 PASS**. The parent authenticated pinned encrypted Source commit `ae5ff5581b21590038b44687908f0cce9703abc3` and independently verified frozen Backup. Installed Windows Obsidian modes `backup`, `backup-tamper`, `backup-revoke`, and `backup-prehandoff-drift` all passed, with each temporary Vault/profile removed. The first three reopened the generation-4 encrypted WAL in a fresh Obsidian process, with Cutover and Sync resume denied. The fourth modified one note byte after first parity, rejected it on the second physical SHA-256 scan, confirmed **no WAL slots**, and intentionally did **not** restart or read back a WAL. Its test report correctly states `installedProcessRestartVerified:false`. There was no GitHub token or remote mutation inside Obsidian. Disposable Source `obsidian-sync-e2e/local-65046b2929db-d24-installed-source-backup-handoff-encrypted-6bc1afff84f0` and Backup `obsidian-sync-e2e/local-backup-c972b538350c46eafa8e74e353b6853d` were both `CLEANUP_VERIFIED_TWICE` on physical repo ID `1284153873`, followed by `LIVE_E2E_PASS`.
- Initial E2E task `f0bd0662-e38f-4d0e-ac80-45721743c497` also passed functional and cleanup checks, but its log incorrectly labeled the pre-handoff denial mode as restarted. The code was corrected and the final above Live E2E repeated successfully; do not reuse the earlier incorrect restart claim.
- **Other current-source checks:** `pnpm build` `e56d3c3d-3a5d-47c2-9523-603b78006b2f`, `pnpm typecheck:github-e2e` `ba666d76-e1cc-4841-b26a-ee54ac06f23e`, `pnpm typecheck:max-strict` `4ec3f118-f806-4b20-906b-43ddbcb9b281`, `pnpm test:feasibility` `458e8d75-c857-464b-b148-ee4cd8d9d3a6`, `pnpm test:recovery` `3e6cc0dd-2d41-4da6-8f5c-987121e8deb8`, `pnpm test:resource` 11/11 `398c7414-b766-4c98-be84-1413210d6d52`, metadata `cd15071a-bc90-466c-b9ae-5386a0d94d17`, package `bc22da3f-0170-45e9-9442-bc26cb5df0d9`, and `git diff --check` `529ec553-7371-44d7-8ba2-fd3995cc9fb1`: **all EXIT 0**. The Windows physical power-loss durability question remains unresolved.
- Full Fast current-source fingerprint: **pending** until one complete run exits 0 without fingerprinted source/docs changing.

## Limits

A second parity read is not a filesystem-wide lock: another local writer can still race after it completes. These tests use an explicitly disposable Vault, a synthetic owner-controlled lease and a test-only fixed WAL key. The installed runtime does not perform the actual GitHub Backup create-only POST, stage new-key Git blobs or publish an orphan Destination branch. Restart-safe local Cutover, stale devices, Android/iOS real devices, and true power-loss durability remain unproven. Keep Wizard Execute and Settings/Selector/Index Cutover disabled. No real user Vault or branch was touched, and no commit, push or merge is authorized by this stage.
