# Stage D381 — zero-parent orphan candidate under the same physical WAL

Date: 2026-11-10. **Focused isolated Live GitHub E2E PASS; public Release BLOCKED.**

## Scope and safety boundary

Only the inherited D87 audit worktree and the owner-approved isolated GitHub test repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (numeric ID `1284153873`) may be modified. The generated `obsidian-sync-e2e/local-*` Source, Backup and Destination refs must be absent twice before use and absent twice after bounded cleanup. No canonical source repository, real Vault, GitHub default branch, GitHub Actions, installed Settings/Index switch, Wizard Execute, migration Cutover, local commit/push/merge or release tag.

## Test-only design

The `wal-candidate-encrypted` focused mode first exercises authenticated old-key Source and frozen Backup under a physical two-slot Windows best-effort WAL. It stages seven independent new-key immutable Git blobs and verifies real remote SHA, length and independently derived AES-GCM new-key decrypt against all original source paths. The old-key negative test must specifically fail WebCrypto AES-GCM authentication, not accept arbitrary transport rejection. Then production `prepareV4BestEffortJournaledOrphanCandidate` consumes the exact prior staging result and WAL receipts to persist its one-shot preparation digest **before** uploading encrypted metadata and constructing an immutable zero-parent Git tree/commit. A fresh GitHub reader must verify the prepared commit SHA, tree SHA and **zero parents**, while Destination ref remains absent. The physical WAL must be released and reopened under an independent new storage/journal owner, retaining exact candidate preparation digest, sealed prepared commit/tree/manifest SHA receipts, all seven staged ciphertext receipts, no pending refs/intents and `cutoverAuthorized:false`.

This exercises **candidate preparation only**: no create-ref POST, no local Settings or Index writes, no actual installed Obsidian migration, no durable fsync/power-loss certification. It also does not establish authorized Destination publication or manual recovery after an unknown destination POST response.

## Verification evidence

- Static validation after candidate-only changes: `pnpm typecheck:max-strict` process `43aa3877-c701-4de3-92d9-5f94332ad150` EXIT 0; `pnpm test:github-e2e:compile` `cc3dc619-7d4d-4079-a675-27abfddfabc1` EXIT 0; `node --check scripts/run-github-e2e-disposable.mjs` `3e96375d-e6cf-4961-a7f9-f5a94d0ed4ed` EXIT 0.
- Local Feasibility 165/165 `471bd7f6-4518-4e1b-bfcc-c289303d6f6e` EXIT 0, Recovery 93/93 `402a58e8-3513-4325-a969-1dd91df1f472` EXIT 0, Resource 11/11 `809e71ae-caf6-4152-bb50-4012cb6406ce` EXIT 0; `pnpm build` `36d98f6a-41f0-4b62-93d1-24c6d5f3485d` EXIT 0.
- Focused Live E2E: `node scripts/run-github-e2e-disposable.mjs wal-candidate-encrypted` process `078d5e5d-be33-4783-8d16-64ae64305183` — **EXIT 0, 1/1 PASS**, final `LIVE_E2E_PASS`. Stage `D381_LIVE_WAL_ZERO_PARENT_ORPHAN_CANDIDATE`: `candidatePrepared:true`, unreferenced zero-parent commit `cbea4122c2f62082d355035d911ced8766b9cd51`, **9 encrypted metadata objects**, `candidateRefPublished:false`, 7 staged new-key ciphertext Git Blobs / 7 files / 1,048,689 original plaintext bytes, `independentNewKeyDecryptVerified:true`, `oldKeyRejected:true`, physical WAL generation **20**, `WALReopened:true`, `WALReadbackUnchangedAcrossReopen:true`, `cutoverAuthorized:false`, `crashDurabilityClaimed:false`. The regular old-key Source advanced independently while its frozen Backup ref retained the original commit.
- Exact test Source ref `obsidian-sync-e2e/local-65046b2929db-d24-wal-candidate-encrypted-56ad95107ea7`, Backup `obsidian-sync-e2e/local-backup-5284ee56619cf5bcfd348b565150754f`, Destination `obsidian-sync-e2e/local-destination-0d94d7959e2b8a7d532d4c43088a7e4f`. Inner and parent runner verified all three absent twice after cleanup, with Destination never published.
- **Independent cleanup proof**: three fresh read-only processes independently pinned numeric test repo ID **1284153873** and returned `READ_ONLY_CLEANUP_VERIFIED_TWICE`, **EXIT 0**: Source `7809e03f-6439-42e6-b749-ee73a11502ed`, Backup `2e76d56d-95ff-458e-a2a5-5ad5d91f12e9`, Destination `6b71d042-2c16-491c-802b-215c4ff90838`.
- `pnpm validate:package` `4017f7a2-d9ee-441f-a8e1-0fdd54d0beed` EXIT 0; `pnpm validate:metadata` `d5c298ad-8c45-4783-aa93-60c865a03975` EXIT 0; Git diff `--check` EXIT 0. A first attempt using nonexistent command name `pnpm validate:release-metadata` failed at CLI resolution and was corrected using the actual package script. It was not a metadata validation failure.
- Full Fast current-source fingerprint qualification: **NOT COMPLETE**. Release gate `docs/release-gates/reencryption-wizard.json` remains `blocked` with six pending checks.

## Next

Continue from WAL-backed, authenticated prepared candidate toward guarded create-only Destination publication with Source/Backup/local initiating-device parity, zero-blind-retry recovery and full remote readback. First release remains blocked by native installed initiating-device migration, durable Settings/Index Cutover, actual Android/iOS acceptance and unfinished Full Fast qualification. Do not promote this candidate-only test as proof of remote Destination publication or electrical power-loss durability.
