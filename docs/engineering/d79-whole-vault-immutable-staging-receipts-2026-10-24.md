# D79 — All-file re-encryption staging and verified immutable Git blob receipts

Date: 2026-10-24 (Asia/Bangkok). Based on clean/pushed D78 `c5cdb9b4899637cdcd59ba3e0cf5aef0043d6ba3`. Isolated worktree `.worktrees/d79-rekey-staging-receipts`.

## Why this stage exists

D76–D77 re-encrypt **one file at a time**, and D78 compares candidate destination logical records against an authenticated source inventory. Neither proves that **each declared ciphertext part was successfully staged**, nor that its returned Git object SHA is consistent with the bytes the client tried to upload, before accepting a complete destination manifest.

New `src/lib/v4/reencryption-staging-receipts.ts` exports `stageV4ReencryptionVaultObjects()`, a bounded per-file, one-object-at-a-time staging coordinator, with an **injected** `stageImmutableObject(opaquePath, ciphertextBytes): Promise<sha>` callback. No actual GitHub network writer is wired into the production plugin by this stage; the tested adapter is entirely in memory. The callback may later write otherwise-unreachable Git blobs; **this module must never create a Git branch/ref, new index/head, alter user settings, mutate a vault, or authorize per-device cutover**.

## Controls

1. Verify the source pinned SHA, all HEAD shard signatures, encrypted path HMAC and complete metadata via D68 **before invoking any staging callback**. Check a trusted source HEAD/repository observer at start, during D76 per-file source reading, before/after each file and at the end. The caller MUST supply D70–D73's exact-commit transport and authenticated observers; arbitrary callbacks are not trusted by this helper.
2. Enumerate every **live** source record in a deterministic pathId order; do not migrate tombstone objects. Invoke D76 `createV4ReencryptedObjectStream` with the approved D74 same-repo orphan plan and new destination keyring. Read old single/pack/chunked ciphertext, hash authenticated plaintext and prepare new 8 MiB REST-safe ciphertext.
3. Require every yielded opaque destination object to match exactly the declared object path sequence and count, be distinct, and have a positive ciphertext length <=8 MiB. Compute actual **Git blob SHA-1** from the complete bytes (Git object identifier, not a replacement for AES-GCM/SHA-256), await the injection, and reject malformed/mismatched receipts or any mutation of the supplied byte buffer during the callback by **re-hashing after upload** without cloning whole blobs. Release the stream's resource reservation in `finally`.
4. Require all objects to be consumed and every source-file stream `finalize()` to succeed before admitting its destination record. A failing later part, missing shard, an interrupted callback or changing source fails the entire staging attempt; no completed manifest is returned, even if some immutable objects were already staged and are now unreachable.
5. After all files, repeat the source HEAD observation and invoke D78 **whole-vault logical parity** on the complete destination record set: each live path, hash, size, mtime, fresh opaque IDs, no old object reuse, no duplicates or unexpected files, and BigInt logical totals. Confirm all expected object paths have receipts.
6. Return an internal snapshot with frozen completed records (which **contain sensitive logical paths** and must never be logged), immutable object receipts and a separate sanitized/frozen preview. That preview **always** says `integrityScope: "staged-immutable-blobs-only"`, `backupVerified: false`, `destinationReadbackVerified: false`, `permissionToPublish: false`, `cutoverAuthorized: false`.

## Regression proof

- Fail-first absent staging-coordinator module.
- **8/8** test cases with the **real V4 AES-GCM codec** and simulated staging receipts: complete two-note Unicode/empty vault with fresh destination decryption; fake/wrong/malformed SHA receipt; missing authenticated shard with **zero writes**; source HEAD change; failure of later staging callback; changed ciphertext array during awaited callback; corrupted later multipart part after earlier staged objects without any complete result; 8 MiB+ multipart successfully split and independently decrypted; and cancellation before any stage.
- Strict TypeScript production `pnpm build`, full `pnpm test:fast`, resource/recovery/feasibility suites, E2E three-bundle compilation, metadata/package validation all PASS.

## Explicit boundaries / remaining work

**Git blob receipt is not Git reachability or durable backup proof.** A dishonest/unreliable injected callback can return the correct SHA without actually persisting the object. This stage **does not read back from GitHub**, verify that the root Git tree references every blob, authenticate complete destination metadata at a new pinned orphan commit, or restore the new vault on another physical Obsidian device. It also has **no durable/resumable journal**: after a crash/failed upload, prior immutable objects may remain unreachable and their receipts may be lost. A future coordinator must bind the write to a specific authorized repository, persist an authenticated crash-consistent progress journal, reconcile ambiguous Git API failures, check backup integrity, and perform an independent SHA-pinned readback before publishing/cutover.

The owner approved **option A** (fresh zero-parent orphan branch within the same GitHub repository, preserving old branch for recovery). The owner has **not** approved a specific old-device Sync freeze/fencing or reconciliation policy yet; none is inferred here. D66 first-public-release Re-encryption Wizard gate remains **blocked**: only `ownerApprovedMigrationTopology: passed`, six checks pending. No GitHub Actions, live GitHub mutation or user-data migration in D79.
