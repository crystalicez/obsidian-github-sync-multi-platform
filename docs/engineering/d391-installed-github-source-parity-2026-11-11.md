# Stage D391 — authenticated GitHub Source parity inside installed Obsidian (LIVE PASS; RELEASE BLOCKED)

Date: 2026-11-11 (Asia/Bangkok). Scope: inherited dirty `.worktrees/d87-owner-rekey-policy` only. The approved GitHub test repository was `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned physical ID `1284153873`. Every installed Obsidian profile and Vault was disposable. No real user Vault, canonical or default Git branch, Release Receipt, GitHub Actions, Settings/Index Cutover, Wizard Execute, project Git commit or push, or release was changed. The live E2E did create and remove a synthetic Source commit on an approved disposable GitHub test ref.

## Verified boundary

The focused D391 scenario first pushes exactly one encrypted synthetic note to a previously absent disposable GitHub Source branch. A separate `GitHubClient` authenticates the immutable Source commit with the real old passphrase and reads the exact file inventory and plaintext SHA-256. A wrong old passphrase fails AES-GCM metadata authentication. A mismatched Source branch fails the repository and branch identity check.

The parent E2E process then passes a bounded, token-free, single-use inventory manifest to a separate installed Windows Obsidian process. That process uses the actual `V4PluginRuntime.createReencryptionInitiatorLocalReader()` and production `verifyV4ReencryptionInitiatorLocalParity()` to check the physical Vault. It arms the persisted Sync Fence and uses the same revocable owner lease to create an encrypted two-slot WAL containing only a pending Backup intent. The installed process never receives the GitHub token, does not write GitHub refs, and does not authorize local Cutover.

Three installed variants passed against the same independently authenticated Source inventory:

- **normal:** matching physical note, pinned commit, WAL readback after a new Obsidian process, Manual Recovery gate, and cleanup.
- **tamper:** one ASCII byte changed while preserving UTF-8 file length. Physical SHA-256 mismatch rejected. Encrypted WAL slots remained unchanged; the fixture note was restored.
- **revoke:** the same initiating lease was revoked. A second parity scan, a valid WAL-slot overwrite, and the WAL checkpoint all failed closed without altering the physical slots.

The JSON manifest is test-only transport. It is not independently authenticated inside the installed Runtime and is not a production source of authority. D391 does not prove an OS-wide filesystem snapshot, cross-device initiating lease, published Backup or Destination from the installed process, restart-safe Settings/Selector/Index Cutover, or Android and iOS migration.

## Recorded evidence

- Focused command: `node scripts/run-github-e2e-disposable.mjs installed-source-parity-encrypted`, managed task `05ebf76d-5b45-4b2e-868e-bc3b2229f94a`, **exit 0**.
- The test pinned Source commit `7c182192fbb0a7b284093cef3fd95249d7b11840` on branch `obsidian-sync-e2e/local-65046b2929db-d24-installed-source-parity-encrypted-129ff3f1c7a5`. One GitHub E2E case passed, with installed **normal**, **tamper**, and **revoke** modes all passing. Each reported `cleanup:temporary-vault-removed`, authenticated physical parity, a separate restarted process's encrypted WAL readback, and `cutoverAuthorized:false`.
- The outer wrapper reported `CLEANUP_VERIFIED_TWICE` for that branch on repository ID `1284153873`, followed by `LIVE_E2E_PASS`. The Source test client recorded 13 HTTP requests, 8 mutations to the disposable Source during initialization, no retries, and no reported network failures. Four 4xx responses were recorded; this is not evidence that all requests returned success.
- `pnpm typecheck:max-strict` exited 0 (task `a589a145-2a1e-4635-84ae-24119ef82980`). `pnpm typecheck:github-e2e` exited 0 (task `104a9455-d0de-40a1-8982-eee85b677a29`). `pnpm test:github-e2e:compile` exited 0 (task `aeac727b-e738-41f2-8d99-443f392481c6`). `node --check scripts/run-obsidian-disposable-wal-authoring.mjs` exited 0 (task `c676f52e-c903-4082-86ed-048a2cac0d73`).

## Release boundary

The policy remains **Sync and Re-encryption in the first release together**, encrypted part size **8 MiB**, Mobile initiation capability-gated to **32 MiB**, tests with single large files at most **100 MB**, best-effort Manual Recovery, and **no GitHub Actions**. Keep `docs/release-gates/reencryption-wizard.json` blocked.

Next safe work: demonstrate one installed, authenticated, journaled Backup → new-key Staging → create-only orphan Destination chain under the same owner, using disposable refs and a local test Vault. Do not enable Wizard Execute or committed Cutover until restart-safe Settings/Selector/Index and stale-device behavior have independent recovery tests.
