# Stage D382 — isolated GitHub Backup scratch readback under the D381 WAL (2026-11-10)

**Release remains BLOCKED.** This stage is a focused disposable test, not installed Obsidian migration, Destination publication, power-loss durability or Cutover.

## Test boundary and action

The former provisional `wal-publish-encrypted` runner mode was **disabled** and removed from advertised usage because it did not connect Local Vault parity, real Scratch Restore and authenticated WAL intent. In its place, `wal-scratch-encrypted` uses the user-approved dedicated test repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (numeric ID `1284153873`), and fresh `obsidian-sync-e2e/local-*` Source/Backup/Destination branch names verified absent twice before any mutation. No GitHub Actions, canonical repo/default branch, installed Settings/Index, real Vault writes, Cutover or release mutation.

After the existing same-physical-WAL, old-key Source / pinned frozen Backup / independently SHA-verified new-key Git Blob staging / zero-parent orphan Candidate preparation, the new test calls the production `verifyV4ReencryptionBackupRestoreRehearsal` through a disposable disk-backed V4 staging store. It must verify the entire authenticated old-key frozen Backup manifest, decrypt each old-key Git Blob obtained from the pinned Backup commit, hash each plaintext stream, write to the isolated test scratch directory and reread/have SHA256 equality verified before removal. It asserts all scratch files have been deleted; no Destination ref may exist afterward and WAL is reopened independently with sealed candidate and stage receipts unchanged.

This scratch helper intentionally uses whole-buffer reads with a 2 MiB scratch staging ceiling suitable only for the current seven-file, approximately 1 MiB synthetic baseline. It is **not** proof for multi-part large-file restores, an OS-wide edit fence, physical disk independence, electrical crash durability or a user-facing migration execution.

## Verification evidence

- Maximum Strict TypeScript for `src`: process `60d32846-37c3-4993-9a6c-866566970d44`, EXIT 0.
- GitHub E2E bundle compile: `d593fc5f-a512-4d0a-949b-ab7b156661cd`, EXIT 0. Disposable runner `node --check`: `3759c4be-c348-4673-826b-d27472ea2bad`, EXIT 0.
- Feasibility **165/165**: `17efac3c-761c-4e3b-9965-6bdf8c9c9c31`, EXIT 0. Recovery **93/93**: `b98352d4-6b9e-4416-a6dc-c30136605012`, EXIT 0. Resource **11/11**: `02bc4e39-d0c6-4f99-a989-fd1dac0e9218`, EXIT 0.
- `pnpm build`: `152bba19-2334-4e5e-8e35-1eee28c60d25`, EXIT 0. `pnpm validate:package`: `9b21a6bc-2d39-4563-8dbc-7a40e40e0926`, EXIT 0. `pnpm validate:metadata`: `02c33d91-96b1-4ba4-8e90-5b30c3d026a0`, EXIT 0.
- A **diagnostic-only** temporary `.tmp/tsconfig.d382-e2e-audit.json` (not a release gate) reveals existing TypeScript errors in E2E mocks, harness, old test fixture and strict configuration; therefore **E2E TypeScript is NOT maximum-strict green**. This is separate from the source-only Maximum Strict pass.
- **Focused Live E2E PASS:** `node scripts/run-github-e2e-disposable.mjs wal-scratch-encrypted`, process **97faf7d8-dff1-4812-a0a7-473af8b42b47**, **EXIT 0, 1/1 PASS**, final `LIVE_E2E_PASS`. Stage `D382_LIVE_WAL_BACKUP_SCRATCH_RESTORE` reported `scratchRestoreVerified:true`, `scratchRestoredFiles:7`, `candidatePrepared:true`, unreferenced orphan commit `693bce931194f8b5cc762d58c7c2511d36282656`, **9 encrypted metadata objects**, seven staged ciphertext Git Blobs / seven plaintext files / **1,048,689 verified bytes**, `independentNewKeyDecryptVerified:true`, `oldKeyRejected:true`, sealed WAL **generation 20**, `WALReopened:true`, `WALReadbackUnchangedAcrossReopen:true`, `candidateRefPublished:false`, `cutoverAuthorized:false`, `crashDurabilityClaimed:false`.
- Source disposable ref `obsidian-sync-e2e/local-65046b2929db-d24-wal-scratch-encrypted-161f7a192c84`, Backup `obsidian-sync-e2e/local-backup-57c59b572e42157b82123a809ac7eec7`, Destination `obsidian-sync-e2e/local-destination-ddbe26c2271c66c1c5532f372da30d6f`. Both child and parent verified all three absent twice, with Destination never created.
- **Independent cleanup confirmation:** fresh read-only checker processes on pinned test repository ID **1284153873** each independently verified twice and EXIT 0: Source `e38a7f62-0932-48fd-8f7c-dbcc7f5f61c6`, Backup `fb3465ce-cc5c-4a38-a72b-6abc4a6d62a2`, Destination `dd558fa3-030c-4d73-98d6-b9aea3417581`, all `READ_ONLY_CLEANUP_VERIFIED_TWICE`.
- Final E2E bundle compilation after removing unused D382 publication scaffolding: process `6b3c1df9-ad0d-47b7-a098-8d9fb53021e7` EXIT 0.
- **Fail-closed D382 runner guard:** invoking the intentionally disabled `node scripts/run-github-e2e-disposable.mjs wal-publish-encrypted` produced only the usage message and EXIT **2**, process `870847f4-b1ee-464a-8903-c6b4f3800ed5`. The wrapper's mode validation rejects this before credential loading, network preflight, or Git mutation; the nonzero exit is **expected**, not a failed release gate.

## Remaining blockers

Full Fast source-fingerprint qualification not completed; destination publication with complete WAL-bound initiating-vault parity, one-shot intent/ambiguous response reconciliation, installed Settings/Index Cutover, real Windows/Android/iOS acceptance and explicit release-gate review remain pending. Continue with D383 only after rechecking local-parity and publication policy boundaries; D382 terminal cleanup is independently verified. `docs/release-gates/reencryption-wizard.json` must stay `blocked`.
