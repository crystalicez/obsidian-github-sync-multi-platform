# D396: pin the Frozen Backup Git ref writer through creation and readback

Date: 2026-11-11. This is a local change in `.worktrees/d87-owner-rekey-policy`. The first-public-release Re-encryption gate remains **blocked**.

## The error

`createAndVerifyV4FrozenBackupRef()` and its explicit best-effort variant call the same `createAndVerifyBackup()` function. This function verifies the old encrypted Source and the selected Backup branch, persists the caller's WAL intent, probes GitHub for an absent Backup ref, and then sends a create-only Git ref POST. It later reads and decrypts the complete frozen Backup. Every path leaves local Cutover disabled.

The function checked the initiating lease immediately before the POST, but it retrieved `backup.createGitRef` from a mutable caller-owned GitHub client **after** that awaited lease check. A caller could replace the method while the lease callback was pending. In a mock, this allowed a different writer to create a matching ref and the function to report successful Backup creation without ever invoking the original approved writer.

A second problem remained after the first guard: a Git ref writer could finish the original POST, replace its method before returning, and still receive a successful Backup report. Neither case proves that an actual installed GitHub client is mutable during normal production use. Both expose a real unsafe boundary if an adapter or caller's method changes during an async migration.

## Scope of the change

`src/lib/v4/reencryption-backup-create-verified.ts` captures the original `createGitRef` method, original Backup branch, and Backup client instance when the call starts. It compares those values to the caller's current references before the irreversible POST, after the original writer returns, after the source creation helper finishes, after the independent encrypted Backup readback, and after the final lease check. The POST invokes the captured method with the original client as its receiver.

If any checked writer identity changes, the function throws a Manual Recovery error and does not issue a second POST. A writer change after a successful POST is still an **uncertain local outcome**, even when GitHub holds the branch. This check does not add a remote atomic lock, verify an arbitrary in-place mutation to the GitHub client, or confer power-loss durability.

## Behavior tests

- **RED before any fix:** D396 pre-POST test `dd7fc4c6-7d76-44fe-b2f6-09c3430cd34f`, exit 1, observed `Missing expected rejection`. The replacement writer was accepted after GitHub preflight.
- **GREEN after the first fix:** D396 pre-POST test `1dbb528b-0dba-4d9d-9f84-d3f3dc01ceac`, exit 0. The original writer and replacement writer both had zero calls after the prohibited change.
- **RED for the second failure:** D396 post-POST test `0a8f2419-0e35-46b4-9f75-00b495bad35e`, exit 1. The original POST completed before the writer was replaced, yet the function returned success.
- **GREEN for both cases:** D396 focused suite `44221172-e536-4ffd-abb6-6e9f7efb9024`, **2/2 PASS**, exit 0. The post-POST test verifies one original create attempt, zero replacement calls, and failure rather than an unsafe success report. The entire Trusted Loader test file `1a0fb6a4-a722-40d9-a3ea-f8de46e527d7` exited 0.
- `pnpm typecheck:max-strict` task `02f4d156-66d7-43fb-a99b-1d44af6c69e2` exited 0. `pnpm build` `1221c662-6bf4-4228-8912-a8cdfc4c4dcb`, `pnpm typecheck:github-e2e` `fd22f019-8579-4fcf-9c60-54a537c370f3`, and `pnpm test:github-e2e:compile` `df1aed1a-0711-4a64-a682-1c27df8bf42a` all exited 0.
- Staging `28c734e8-ccb7-40d5-8fb3-085b6b077493`, Orphan Publication `78110d14-4363-47cb-a9e2-b5af9ef0a175`, Feasibility `96b0a4a3-8d1d-4a2f-ad20-78e9c7a01e1a`, Recovery `3691dc97-d71d-403e-9721-431f567f8d36`, Resource `71761c12-6ba2-426f-9aa8-1e2bbf051819`, Release Metadata `f1e8e6e6-b093-42e9-a7f8-b27c4c9ce4f5`, and Package Validation `500a59eb-65ed-4703-8d12-5612fc162f70` all exited 0.
- **LIVE GitHub PASS:** `node scripts/run-github-e2e-disposable.mjs wal-publish-encrypted`, task `092b9db0-0658-4b33-92ea-6133d6d0da36`, **EXIT 0**, one focused E2E PASS. The real GitHub test created a frozen Backup pinned to the original Source SHA even after the Source branch advanced. It staged **7 new-key objects for 7 files (1,048,689 plaintext bytes)** and published a zero-parent create-only orphan Destination commit `f4584e066474e115e535fb1b702c15fea8d9b69b`. All seven files were independently read back and restored in scratch with the new key; the old key was rejected. The encrypted WAL reopened unchanged at generation 22. No local Cutover or power-loss durability was claimed. Disposable Source `obsidian-sync-e2e/local-65046b2929db-d24-wal-publish-encrypted-01fe6620f51c`, Backup `obsidian-sync-e2e/local-backup-98b3d33e905e754f91b6101b4f5731a5`, and Destination `obsidian-sync-e2e/local-destination-7cad4f53ae2e5fd837ad02dc2f8e7097` each ended `CLEANUP_VERIFIED_TWICE` on approved physical repository ID `1284153873`, followed by `LIVE_E2E_PASS`.
- The Full Fast source-fingerprint result is recorded in the handoff only after the complete command terminates with exit 0. Do not use D395's prior fingerprint for this source.

## Release boundary

A verified old-key Backup branch, new-key Staging, orphan Destination, and authenticated WAL **do not** authorize local Settings, Selector, or Index Cutover. An installed Windows Obsidian process has not yet exercised the entire remote mutation sequence in one runtime owner session. Android and iOS device acceptance, stale-client recovery, and power-loss-safe local Cutover remain unproven.

The user-approved policies remain unchanged: first release contains Sync plus Re-encryption, encrypted part size 8 MiB, Mobile initiation capability-gated to 32 MiB, physical single-file test limit 100 MB, best-effort Manual Recovery when needed, and GitHub Actions disabled. Only approved disposable test Vaults and repository branches may be written.
