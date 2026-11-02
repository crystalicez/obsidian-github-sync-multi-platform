# D241: Open only an existing Desktop Re-encryption WAL for Recovery

Date: 2026-11-02. This is a read-only, isolated Desktop recovery component. The first public Re-encryption Wizard release is still blocked.

## Problem

The D164 Desktop WAL factory, `acquireV4DesktopRekeyWalStorage`, is primarily a writer for a newly initiated Re-encryption run. It can create its WAL directory. Reusing that factory without an explicit mode during recovery could create a fresh empty WAL when the old one has disappeared or when the caller selected the wrong physical root. This must not happen when the missing data may be essential for Manual Recovery.

## Change

`src/lib/v4/reencryption-desktop-wal.ts` now supports an explicit `recoveryExistingOnly` option. The normal WAL writer remains unchanged. In existing-only mode the factory checks that every directory component already exists, rejects symlinks and junctions, and requires exactly `slot-0.json` and `slot-1.json` as ordinary singly-linked files within the 2 MiB slot limit. A missing directory, missing slot, stray file, oversized or linked slot fails closed **before acquiring a lock or creating any WAL data**.

The existing exclusive lock is still acquired using `wx+` and its pinned inode/token is checked on each operation. After lock acquisition the factory lists the directory again and requires precisely the two slots plus the lock it created. It never deletes a pre-existing lock or unknown temporary file. The lock itself is a temporary, intentional filesystem write that is released by the caller. A cooperating lock is not protection against an unrelated OS writer and does not prove physical power-loss durability.

`src/lib/v4/reencryption-desktop-wal-recovery.ts` provides `openV4ExistingDesktopWalForRecovery`. It exposes only `adapter.read`, `adapter.exists`, the exclusive lease assertion, best-effort checkpoint, lock path and release. It does **not** expose `adapter.write`, `adapter.mkdir` or `assertCrashDurable`. The caller must supply the actual previously trusted absolute private root and relative journal root; this module does not discover either from Vault paths, native Settings or an untrusted local hint.

## Validation

Tests in `tests/v4/reencryption-cold-start-wal.test.ts` check that a missing directory is not created, both existing encrypted slots survive an actual Windows Node lease release/reopen unchanged, the public recovery adapter has no write or mkdir operation, a missing predecessor or foreign interrupted temporary file fails closed, and an existing lock is not reclaimed. The D239 complete WAL-to-Destination Git readback test was also switched to this existing-only opener for the reopened WAL. Its full encrypted file and fence checks remain read-only.

The tests do not simulate a physical power cut and do not establish Android/iOS filesystem or installed Obsidian behavior. The normal writer path is deliberately unchanged. No installed recovery command has been connected, no old passphrase has been deleted, no branch has been changed, and no Sync fence or release gate has been lifted.

## Next

D242 should establish the trusted persisted Desktop WAL root from the actual installed plugin/vault lifecycle without guessing and run D236+D239 within one authenticated owner and exclusive recovery lease. Android and iOS need their own safe recovery adapters, plus stale-device and Manual Recovery acceptance before an active mutable Destination Index or first release.
