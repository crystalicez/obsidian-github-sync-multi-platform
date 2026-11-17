# D379 — Live verified Backup to WAL-bound immutable new-key Staging

Date: 2026-11-10. Status: **focused isolated GitHub E2E PASS; public Release BLOCKED**.

## Scope, consent and non-actions

Only the inherited D87 audit worktree was modified. The owner previously authorized GitHub writes in the dedicated synthetic repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (immutable numeric repo ID `1284153873`) using generated and preflight-absent `obsidian-sync-e2e/local-*` Source, Backup, and Destination refs. No real Vault, canonical source/default branch, installed Settings/Index Cutover, production Wizard Execute, GitHub Actions, native helper, commit, push, merge, or release tag was touched. The new mode and helper changes are **test-only**, not an enabled product execution route.

## Evidence

Focused command: `node scripts/run-github-e2e-disposable.mjs wal-stage-encrypted`, process `8ca19c09-2c19-4728-a350-3fdcfc87e06d`, **exit 0, 1/1 test PASS**, `LIVE_E2E_PASS`. Actual GitHub encrypted Source full-read authenticated 7 files and 1,048,689 plaintext bytes; the production `createV4BestEffortJournaledFrozenBackup` wrote an exact WAL Backup intent before the create-only ref POST and subsequently recorded independent Backup readback. Under the **same physical Windows OS-exclusive two-slot WAL**, production `stageV4BestEffortJournaledThreeBranchVault` handed off the verified Backup generation 3, uploaded **7 new-key immutable Git blobs** for 7 files, and wrote sealed staging receipts through WAL generation **18**.

The independent Git Blob read-only reconciler verified every staged blob SHA and receipt against the exact remote repository; zero new-key Destination refs were created. The original Source then advanced by ordinary old-key Sync while the frozen Backup remained at the pinned old-key Source commit. After closing the WAL OS handle, a **fresh storage owner and journal instance** reauthenticated both physical encrypted WAL slot hashes, generation 18, all 7 receipts, zero pending intents and unchanged Backup ref observation. It still reported `permissionToPublish:false` and `cutoverAuthorized:false`. This is a best-effort checkpoint and **not** an electrical power-loss/fsync proof, installed Obsidian migration, fully decrypted new-key published Destination, manual Recovery after a real restart, or user data Cutover.

Runner checked each of these three scoped refs absent twice after cleanup:
- Source `obsidian-sync-e2e/local-65046b2929db-d24-wal-stage-encrypted-c87905a8e651`
- Backup `obsidian-sync-e2e/local-backup-44008cc81712bf496546a5b8ed86df14`
- Destination `obsidian-sync-e2e/local-destination-21aea211cdef12b390e82860a887db02`

The runner emitted three `CLEANUP_VERIFIED_TWICE` events. **Three separate fresh read-only GitHub absence-check processes** then independently reported `READ_ONLY_CLEANUP_VERIFIED_TWICE`, each EXIT 0: Source `baf11614-b82c-493d-ba7c-01c11da0d534`, Backup `3a76d819-4052-4913-82ae-fbc125792d4e`, Destination `3dc8f249-0daf-45c1-831c-8d95b8d8c106`. Each checker pinned the numeric physical repository ID and read its exact branch twice; none performed a GitHub mutation.

## Local gates

After D379 test-only edits: Maximum Strict TypeScript, E2E compile-only, wrapper JavaScript syntax, `git diff --check`, production build, release metadata, and package validation all exited 0. Feasibility **165/165**, Recovery **93/93**, Resource **11/11** all PASS. A Full Fast fingerprint-qualified run started on this inherited worktree, but was **stopped without completing** at heavy cohort D230–D239; it is not valid Full Fast evidence, and was begun before final D379 edits.

## Next safe work

Connect the **same WAL's verified 7 staged object receipts** to a zero-parent orphan candidate preparation intent/receipt and create-only Destination publication in another isolated branch test, with full independent new-key decrypt/restore and explicit unknown-response/restart recovery. Keep `docs/release-gates/reencryption-wizard.json` **blocked**, all six checks pending. Actual installed initiating-device owner-scoped transaction, Settings/Index crash-window Cutover, and Android/iOS acceptance are still missing. Do not infer a green full native release gate or reconfigure old-key devices automatically.
