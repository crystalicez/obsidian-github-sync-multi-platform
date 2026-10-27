# D128 — Exclusive physical WAL adapter write and immediate directory-proof revocation

Date: 2026-10-28. **Windows Desktop WAL integrity hardening; Re-encryption release remains BLOCKED.**

## Confirmed gap: one WAL lease permitted multiple independent raw adapter writers

D126 made journal `locked()` operations exclusive among journal instances sharing one adapter; D127 kept that adapter's lease alive while operations drain. But consumers can still call `V4DesktopRekeyWalStorage.adapter.write()` directly. That public method historically only checked that the owner's `.exclusive.lock` existed; it did **not** serialize multiple writes issued under that same lock, even to *different WAL slots*. Independent writes can perform temporary-file fsync and rename concurrently, violating the assumptions of an orderly two-slot WAL transition.

An initial same-slot race regression was **insufficient**: Windows itself rejected one conflicting rename, so that test passed on unpatched code. The test was strengthened to issue competing writes to **slot-1** (valid existing encrypted g1) and **slot-0** (initially absent). This version **FAILED before the fix**: BOTH concurrent adapter writes fulfilled, showing two slot mutations under one lease. It would also leave duplicate g1 snapshots on disk if blindly accepted. The test uses real Windows filesystem I/O, not a mocked adapter.

## Fix

`src/lib/v4/reencryption-desktop-wal.ts` now applies an additional private, synchronous `writing` claim on the public adapter's `write()` method, **before its first await**. A competing adapter write throws `V4DesktopRekeyWalLockError` without preparing a temporary file, renaming either slot or changing journal content. The claim is released in `finally`, including error/cleanup paths. All operations remain covered by D127's reference-counted live lease/drain.

Any new write also invokes `V4RekeyWalDirectorySyncProof.invalidate()` **synchronously before the first awaited file operation**. A previous successful leaf directory fsync cannot certify an in-progress WAL mutation. `assertCrashDurable()` additionally refuses an active physical writer, even if a flush result from an earlier WAL generation exists. Normal successful WAL writing still completes its file fsync, atomic rename and `syncDirectory()` in the existing order, so it may regain confirmed durability only if parent and leaf filesystem flushes genuinely succeed.

No WAL format change, no automatic WAL repair, no branch publication, and no local settings cutover.

## RED→GREEN verification

- Real Windows adapter test, differing physical slots: **RED before fix** (`actual: fulfilled`, expected `rejected` for the second write), GREEN afterward. The authenticated g1 snapshot survives, no extra slot exists, and `permissionToPublish:false`, `cutoverAuthorized:false`.
- New deterministic `V4RekeyWalDirectorySyncProof` test confirms `refresh(true,true)` can establish a proof, `invalidate()` immediately revokes it, a failed/unsupported leaf sync does not revive it, and a new fresh successful sync can establish a proof again.
- Focused Desktop WAL **24/24 PASS**, full Fast **936/936**, Fast repeat **10×936/936** (exit 0, zero failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), package and metadata validation PASS. Bounded crypto Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS, digest identical to reference SHA-256.

This mechanism enforces exclusivity for writers that use **this instance's returned Node adapter**. It cannot block a non-cooperative external process opening the same WAL files by pathname, nor an external application mutating Obsidian Vault notes. The `wx+` OS WAL lock remains the cross-process cooperative gate. Windows Node-only directory `fsync EPERM` remains a hard, UNWAIVED power-loss durability blocker.

## Outstanding production decisions/gates

D90/D91 owner policy unchanged: independently writable old-key Source, immutable frozen Backup pinned to original source commit, new-key zero-parent orphan Destination, all in the **same** GitHub repository. No automatic peer cutover or branch cleanup; no GitHub Actions, Native OS Helper promotion or release waiver. Physical sudden-power-loss WAL durability, Vault-wide independent-process writer fence, crash-safe initiating-only Branch/Passphrase/Index cutover, new-key provenance/recovery, numeric-ID-pinned live same-repo GitHub three-ref acceptance and installed Windows/mobile multi-device tests remain incomplete. Wizard stays Preview-only; `docs/release-gates/reencryption-wizard.json` remains `blocked`.
