# D517 — Installed Recovery command native qualification

Exact audited HEAD 85528b7bc130581b56be1585bd6eda06393ef960; production code 0bca9c70e3c1c7122c53303773da53cc5cb53546. No source changes during the run. Actual Windows Obsidian with pinned disposable GitHub repository ID 1284153873 only.

`node scripts/run-obsidian-disposable-precutover-rehearsal.mjs --stage-secret --recover-via-ui` task 2e8610ae-5901-49c9-b095-8012e8367ed5 exit 0, 274.971s. All seven native phases through destination-published-no-cutover. Real forced process termination lost staged SecretStorage value. Disk-discovered read-only inspection returned manual-recovery-required, missing=true, failureStage=secret. Actual command opened password modal, empty submit disabled; input and button exercised; field cleared and modal removed; exact staged ID restored (restoredViaUi=true). Independent post-UI read-only recovery authenticated Backup, WAL generation 12, Shadow and Destination; original old key, token, Source settings and local bytes unchanged; 2 files/2116 bytes, UI exceptions 0, no Cutover/resume/cleanup authority, no physical power-loss guarantee.

Pinned Source/Backup 3a22a326b60e082c40a1bf284b5283c239c84114; Destination 42560d67919dd58a97768aaf9cabe3894464c928. All three disposable refs independently verified absent twice, each exit 0:
- obsidian-sync-e2e/local-85528b7bc130-6c34118ae75c76d8 — 547110f5-0a6d-4f5e-ae8e-4ac6b6d32edf
- obsidian-sync-e2e/local-backup-609f895369dae9b6aa0d58e82b79dbf2 — fd79e8c9-8b2c-44fe-9766-dfe388ff5db3
- obsidian-sync-e2e/local-destination-0ff4c946aa77b809e2ac5b98c3fb72ca — 098abed2-a45f-41f3-a0a8-0adbc9711488

Runner cleanup temporary-vault-removed, remoteCleanupErrors=0. Earlier D515 ASAR remainder unchanged.

Additional exact-source verification: Main UI suite 33/33 zero skipped (2dcd910b-eb2b-4079-b018-3ac8a34f356f); release metadata (2b165d2f-f524-46ba-bd6d-91a9dcf281f9), package validation (65a71df6-6aba-44a7-9ea8-d51ce4c32e66), GitHub E2E compile-only (9e910d68-135c-49f8-8b9a-577eac6a4455) all exit 0. Earlier focused 135/135, build and strict results still apply. Full Fast latest not yet qualified.

Remaining: actual owner-bound Cutover, settings and index activation, ordinary destination Sync and peer, Android migration <=32 MiB, final exact-source Fast and release. No weakening of existing fence or assertions, no real Vault/default branch/tag/release writes. Physical iOS waived; fixtures <=500 MiB.
