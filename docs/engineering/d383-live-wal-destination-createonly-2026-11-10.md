# Stage D383 — WAL-bound create-only Destination publication with physical synthetic Initiator parity

Date: 2026-11-10. **Focused isolated Live GitHub E2E PASS; public Release BLOCKED.**

## Scope

Use only inherited D87 audit worktree and the previously owner-approved disposable GitHub test repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (numeric repository ID `1284153873`), with generated `obsidian-sync-e2e/local-*` Source, Backup and Destination branches confirmed absent twice before the run and absent twice after bounded cleanup. No production repository/default branch, actual installed Vault/Settings/Index, GitHub Actions, local commit/push/merge, or release tag.

## Test contract

The `wal-publish-encrypted` mode calls the **production** `publishV4BestEffortJournaledThreeBranchDestination` after same-WAL old-key frozen Backup (created and independently authenticated), seven new-key immutable Git blobs (SHA and AES-GCM verified), zero-parent candidate commit (remote commit/tree readback and sealed WAL manifest), and physical isolated scratch restore from the actual old-key Backup ref.

D383 creates a second test-only physical initiating-Vault directory under the disposable WAL root. Each logical path is mapped to an opaque SHA-256-derived filename and re-opened using `lstat/readFile/readdir` on each parity pass. The production `verifyV4ReencryptionInitiatorLocalParity` must inspect the complete original snapshot twice, reject a same-size one-byte local content corruption before any Git mutation, and pass only after restoring the isolated synthetic file. Its exclusive lease is backed by the held physical WAL; its no-open-editor/no-pending-edit assertions are **synthetic test guards**, NOT proof that an installed Obsidian editor or an external OS process can be fenced.

The producer must persist the exact one-shot Destination WAL ref intent before sending **one** create-only GitHub POST; independently recheck Backup and local parity across awaits; then independently read the new Destination branch ref/zero-parent commit, encrypted metadata and every new-key file via a fresh GitHub client. The reader must never mutate GitHub. On success the physical WAL must seal an exact Destination ref observation, have zero pending mutation intents and reopen from disk with source/backup/destination evidence unchanged. Even success does **not** authorize local Settings/Index Cutover, migration wizard release or power-loss durability.

## Verified local checks

- Maximum Strict TypeScript (production src): `efeebb40-6dfe-4493-8ecf-8153bf98a97c` EXIT 0.
- GitHub E2E bundle compile: `f11d80a6-5cc5-4719-a70f-6aabbda159dc` EXIT 0.
- `node --check scripts/run-github-e2e-disposable.mjs`: `98caf4c9-176b-4c8a-8d39-352e9357a3c2` EXIT 0.
- Feasibility 165/165 `fa5bade7-8f58-481b-ad5b-6c6453badc8a`, Recovery 93/93 `3748b7c6-ec46-470f-9473-884b338663a9`, Resource 11/11 `cbb07b97-9075-44e2-a09f-ea96835a1bb7`, all EXIT 0.
- `pnpm build` `eaff5516-b240-40e9-9906-93a4438d0f32`, `pnpm validate:package` `f5fcaddf-9db4-4927-9406-a50092004c28`, and `pnpm validate:metadata` `80f69c1c-63e0-4829-a0c6-e313ba7f47e2`, all EXIT 0.
- Git diff `--check`: EXIT 0. The current-source Full Fast qualification and Maximum Strict *of E2E mocks* are not green; normal strict-src does not cover the test harness.

## Live E2E

- **Initial live run did NOT pass:** `node scripts/run-github-e2e-disposable.mjs wal-publish-encrypted`, process `c6a915dd-08a0-44ae-86f4-194fcf1fd1e4`, EXIT **1**, one failing E2E assertion. The production coordinator advanced to a WAL observation list `["backup","destination"]`, but the old pre-D383 test asserted `["backup"]` before WAL close/reopen; that assertion was incorrect for successful Destination publication. This is **not** a D383 Live PASS or complete recovery proof. The parent test runner independently verified all three disposable Source/Backup/Destination refs absent twice.
- **First-run independent cleanup:** Source `ba9d1d50-224c-4f71-8a4a-67b7f563ebd5`, Backup `b8759c29-bcf6-4ea5-9a26-46978f56feca`, Destination `e74b709e-5438-4bd8-89e2-36360a6bd05a`; each checker EXIT 0 with `READ_ONLY_CLEANUP_VERIFIED_TWICE`. All used pinned numeric repo ID 1284153873.
- The old `live.verifiedRefObservations` assertion now expects both `backup` and `destination` **only when D383 actually published**; prior D378–D382 behavior still expects Backup only. Recompiled E2E process `862d2c4e-a997-415c-a7f6-44751bf87eb5` EXIT 0.
- **D383 focused LIVE PASS:** `node scripts/run-github-e2e-disposable.mjs wal-publish-encrypted`, process **f370e9f5-9d2d-4c6c-b2b9-1d188b563c7f**, **EXIT 0, 1/1 PASS**, final `LIVE_E2E_PASS`. Stage `D383_LIVE_WAL_DESTINATION_CREATE_ONLY_PUBLICATION`: `candidateRefPublished:true`; exact zero-parent orphan commit **c25fba422cb72d2cc30860b6b255ab548a7aae0b**; nine encrypted metadata Git objects, seven independently new-key decrypted staged Git Blobs, **7 full Destination file readbacks / 1,048,689 plaintext bytes**; isolated Backup Scratch Restore verified seven files; old key rejected; on-disk WAL **generation 22**, fresh WAL ownership reread unchanged; `createRefRetriedAfterUnknownResponse:false`, `cutoverAuthorized:false`, `crashDurabilityClaimed:false`. The E2E explicitly validates the destination create-only Git POST count is exactly **one**, a fresh read-only GitHub client independently reauthenticates the full destination, and the sealed WAL contains completed `backup` and `destination` ref observations with **no pending mutations**.
- **Source movement:** After Destination publication, ordinary encrypted Sync on the old Source advanced independently; the frozen Backup ref still pointed to the exact pinned original commit. The final backup full-content check was read-only.
- **Current LIVE cleanup:** Source `obsidian-sync-e2e/local-65046b2929db-d24-wal-publish-encrypted-2d8b43017f97`, Backup `obsidian-sync-e2e/local-backup-b4b8dc499fd5c60459df5841dec72fb6`, Destination `obsidian-sync-e2e/local-destination-791528cb71e4d3967b9c2f4f329a0a2c`. Child and outer parent both confirmed absence twice; the parent printed `CLEANUP_VERIFIED_TWICE` for all three.
- **Independent cleanup after rerun:** Three newly launched read-only checkers all pinned test repository numeric ID **1284153873**, performed two fresh absent ref observations and returned `READ_ONLY_CLEANUP_VERIFIED_TWICE`, **EXIT 0**: Source **6e589078-f71b-4ee9-8826-d984de5892d7**, Backup **28bda777-c58b-4834-9143-16045791b2db**, Destination **0148666b-346d-4891-a98c-bb20bf38b56a**.
- A diagnostic-only test-harness TypeScript expansion **91e349e6-f5d9-45dc-81c7-df89670fce53** EXIT 2 exposed pre-existing E2E fixture/mock errors, including Obsidian mock exports, env index signatures, and a stale old fixture missing new candidate fields; production-src Maximum Strict stays green, but **full test harness strict qualification is not green**. No unsafe silent fallback or disabled type safety was introduced.

## Remaining release blockers

This run is not proof of ambiguous/lost Destination POST response recovery, installed Obsidian desktop/mobile initiation, physical power-loss durability, large-file multipart re-encryption, Full Fast source-fingerprint qualification, or safe installed Settings/Index Cutover. The six release checks in `docs/release-gates/reencryption-wizard.json` must remain pending.
