# D400: validate Desktop WAL identity after reading physical bytes

Date: 2026-11-11. Scope: local Windows audit worktree `.worktrees/d87-owner-rekey-policy`. First release Re-encryption gate remains blocked.

## Problem

The Desktop WAL adapter opened the encrypted slot and compared its pathname and descriptor inode **before** reading. It read up to 2 MiB through the pinned descriptor, then returned decoded bytes without checking whether the underlying file changed during the read. The D399 write epoch rejects overlapping *cooperating* WAL writes at the best-effort checkpoint boundary, but an uncooperative external process does not update that epoch.

On a real Windows disposable WAL directory, an external direct `writeFile()` replaced a slot's contents with the **same UTF-8 byte length** while the adapter's `handle.read()` was paused. Before the fix, the adapter returned changed bytes rather than rejecting a physically modified read. The authenticated journal would normally reject invalid ciphertext, but the lower-level storage layer had not honored its file-identity contract. Content changes during a valid authenticated read should not be quietly accepted by the storage boundary.

## Fix

`src/lib/v4/reencryption-desktop-wal.ts` now compares descriptor and pathname metadata including exact size, inode, device and nanosecond mtime/ctime **before** reading. After the bounded read, it checks the descriptor and pathname again against that first snapshot and checks that exactly the original number of bytes was read. If either identity, size or time changed, the read fails before bytes leave the adapter.

The implementation still uses the same pinned file descriptor, preserves bounded reads, requires regular singly linked files and the existing OS WAL lease, and does not delete or repair uncertain evidence. These checks detect an observed change; they do not create a filesystem snapshot or OS-level foreign-writer lock. An external attacker that can mutate files while preserving every checked attribute, or race again after the final stat, is outside the proven guarantee. The journal remains the cryptographic authority for WAL authenticity.

## Reproduction and verification

- **RED:** `node scripts/run-tests.mjs --tier=fast --filter=tests/v4/reencryption-desktop-wal.test.ts --name-pattern=^D400`, task `bb0fdaf9-5dc4-449b-a1ca-e4d6eb77ecdb`, **EXIT 1** with `Missing expected rejection`. A deterministic Node file-handle read barrier lets the test modify the real on-disk slot through a foreign write while the handle stays open; the original adapter returned data without rejecting.
- **GREEN:** identical focused test task `a178e0e3-6671-4936-bfec-efc6d88015bc`, **1/1 PASS, EXIT 0**. Entire Desktop WAL suite task `ca69c784-5c2f-4e73-9656-73ccb08db782`, **29/29 PASS, EXIT 0**. `pnpm typecheck:max-strict`, task `5b211e51-0efa-4a5d-b72f-12a6f0681d21`, EXIT 0.
- `pnpm build` task `96768f7b-a7e2-480e-8096-4b7b668df76e`, `pnpm typecheck:github-e2e` `7f5848da-97fd-4759-9648-9dc6639ce5d1`, `pnpm test:github-e2e:compile` `50f61e66-5c48-4b0d-acc3-6da8d9c80e9e`, `pnpm test:feasibility` `7be0cc50-12fd-441d-9226-f03ad1f085ef`, `pnpm test:recovery` `2f83a13b-d49a-4be3-a47d-7ef46fbe8c50`, `pnpm test:resource` `0171745f-fd98-4baf-bd33-d1c13fade317`, release metadata `0b0059aa-2bd1-4071-86de-3a5ddd38a43a`, package validation `82743c29-7f4b-4c07-8cc0-d14fc3217dcc`, `git diff --check` `c0d8a32d-a96c-4fa0-bc23-94d259a814a3` all EXIT 0. Resource tier remains **11/11 PASS**; Windows directory fsync is still insufficient proof of power-loss-safe local Cutover.
- Live GitHub disposable E2E, installed Windows Obsidian E2E, and complete current-source Fast qualification must each be recorded as passed only after terminal exit 0 and cleanup. The handoff contains the final results, which supersede this pending note.

## Release and recovery boundary

No Production Wizard Execute, Settings/Selector/Index Cutover, automatic lock reclaim, personal Vault, default GitHub branch, GitHub Actions or deployment was touched. Only approved disposable GitHub repository ID `1284153873` and preflight-absent `obsidian-sync-e2e/local-*` branches may receive integration test writes. Every created test branch must be removed and independently verified absent twice.

The first release continues to require Sync and Re-encryption together, 8 MiB encrypted part size, Mobile initiation capability-gated at 32 MiB, and best-effort recovery with Manual Recovery when evidence is insufficient. Native Android/iOS device acceptance, source-to-destination publication from one installed initiating Runtime, multi-device stale-client protection and restart-safe local Settings/Selector/Index Cutover remain unproven.
