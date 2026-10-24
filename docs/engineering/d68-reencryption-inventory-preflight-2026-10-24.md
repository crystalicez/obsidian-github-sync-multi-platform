# D68 — Re-encryption inventory from a pinned V4 source snapshot

Date: 2026-10-24 (Asia/Bangkok).

## Boundaries and purpose

The user requires a complete Re-encryption Wizard before first public release. Destination choice (A: new empty independent history, recommended; B: mutate the original branch) has **not** been approved. D68 introduces only `inspectV4ReencryptionInventory()`, a topology-independent, read-only, metadata-only source inventory. It does not connect to GitHub, read/write user vault files, create new keys, change settings, publish a branch, re-encrypt data, or imply any release qualification.

## Inputs and proof requirements

A future trusted collector must supply:
- A V4 encrypted `opaque-stable-v1` remote configuration.
- A head that has already been **authenticated/decrypted and pinned to one exact immutable Git commit SHA**.
- Every decoded remote index shard for that same commit, with its authenticated AES-GCM metadata and associated-data validation already complete.
- The corresponding authenticated keyring.

The inspector rejects missing/unexpected buckets, invalid bucket keys, noncanonical/duplicate or malicious logical records, invalid encrypted paths and incorrect fileId/pathId HMAC derivation. It recomputes the **logical shard signature**, matching `sync-session.ts`: sort remote records by `pathId`, JSON serialize, UTF-8 encode, SHA-256; compare against the pinned head's `shardHashes`. This hash is **not** a hash of encrypted shard bytes or referenced ciphertext blobs.

It refuses uncommitted `dirty` records, invalid live plaintext hash shapes, and non-pack shared ciphertext path collisions. Deletion tombstones are included in the authenticated shard-signature verification but excluded from the live logical-file/byte/blob counts. Multiple logical pack records legitimately sharing one pack blob are counted as one distinct remote object. The total logical byte count is accumulated using `BigInt`, serialized as a decimal string to avoid unsafe number precision.

The immutable result exposes only `fileCount`, `totalLogicalBytes`, `shardCount`, `distinctRemoteObjectCount`, `chunkedFileCount`, `packFileCount` and the pinned SHA. It intentionally excludes filenames, remote object paths, raw ciphertext, passphrase and KDF salt.

## What remains unverified

**The returned `integrityScope` is exactly `metadata-only` and `objectContentVerified` is always `false`.** No ciphertext objects have been fetched or authenticated, no end-to-end plaintext hash has been compared against the record, no backup has been verified, no concurrent other-device edits have been fenced, and the observed source branch ref has not been rechecked. For a safe migration, a later collector must fetch and verify every referenced immutable object (single/parts/pack), decrypt or otherwise authenticate it, compare expected plaintext hashes, prove an independent backup and new target cutover, and detect changes in the mutable source HEAD. Never let the existence of this inventory satisfy the release-gate `completeReencryptionAndIntegrityVerification` check.

## Regression tests

`tests/v4/reencryption-inventory.test.ts` covers complete snapshot inventory, bucket omissions and injections, mismatched logical shard hashes, forged remote paths, duplicate logical records, shared packed blob accounting, two-part chunked files, BigInt sums over Number.MAX_SAFE_INTEGER, rejected dirty records, deletion tombstones, missing keyring/invalid head/unpinned commit and non-disclosure of Unicode filenames. No network/GitHub mutation or native migration test was needed or performed for this pure helper.

D66 `docs/release-gates/reencryption-wizard.json` remains `blocked`. The architecture decision on new-history versus in-place migration, and destination repository/branch semantics, remains with the owner. Do not promote this purely structural audit to an executed re-encryption claim.
