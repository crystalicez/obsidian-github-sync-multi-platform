# D78 — Complete logical-record parity before any re-encryption publication

Date: 2026-10-24 (Asia/Bangkok). Isolated audit branch from clean/pushed D77 `6e74bdb3794d86574fd96b8b80e24c216dbc42b4`.

## Problem and exact assurance

D68–D73 proved authenticated source metadata/object reads. D76–D77 proved one-file source-to-destination AES-GCM transcode, correct rest-safe part sizes and full per-file finalization. Neither verifies that the **whole vault** is represented after transforming every logical file: a migration could silently omit a file, add an unexpected one, duplicate an entry, resurrect a deleted path, change timestamps, or accidentally reuse old opaque file identity/object coordinates. Counting files and total bytes alone cannot establish parity.

New **pure read-only** `assertV4ReencryptionVaultParity` in `src/lib/v4/reencryption-vault-parity.ts` performs a full logical inventory comparison between a **pinned, already authenticated V4 encrypted source** and a complete list of candidate destination records. It does not read GitHub or modify the vault, secrets, refs or release state. Its output expressly states:

- `integrityScope: "metadata-parity-only"`
- `destinationContentVerified: false`
- `permissionToPublish: false`
- `cutoverAuthorized: false`

No caller may promote this preview into write/ref or cutover authorization. Independent **object-by-object destination ciphertext verification at its exact new orphan commit** and second-device restore are still mandatory.

## Checks

1. Validate the owner-approved **same-physical-repository/new-orphan-branch** plan shape, pinned source 40-digit SHA, matching old/new encrypted V4 config identities, 600k–1.2M new KDF iterations, fresh salt and distinct old/new path/content key bytes.
2. Invoke D68 `inspectV4ReencryptionInventory` over **every source index shard** to verify the authenticated HEAD logical shard signatures, all expected buckets, normalized safe paths, source per-record keyed HMAC/remote object coordinates, no dirty records and original logical total. This check presumes upstream GitHub readers actually authenticated the source head/shards from one immutable pinned commit.
3. Reject dirty/deleted target records, then validate the **entire** destination logical record set with existing production `assertV4RemoteRecordSet`, including keyed new pathIds/fileIds, normalized canonical case/Unicode path safety and file/directory collisions.
4. For **every live source logical path** require **exactly one** destination path, identical plaintext SHA-256, logical size and original `mtime`. Detect missing/extra/duplicate/resurrected records regardless of whether totals happen to match. Require new opaque `fileId` and `pathId` and reject any destination object path referencing an old live ciphertext object.
5. Count new distinct object paths once. Allow sharing only for records that intentionally refer to the same validated packed object/packId; reject unsafe cross-file aliasing. Use `BigInt` decimal strings for total bytes to avoid integer precision errors.
6. Count **source tombstones separately** but do not synthesize destination tombstone identities. A clean orphan root need not carry the old Git commit ancestry; whether historical tombstones and old-device stale writes must be fenced is a **separate unresolved cutover policy**. This parity proof never asserts historical deletion/cutover correctness.
7. Return only a **frozen, sanitized summary**, without file names, plaintext, passwords, salts or key material.

## Fail-first and tests

Fail-first source module missing → failing focused suite. Once implemented, added 8 focused regression cases: complete real V4 signed source shard set + Unicode/empty/binary files and tombstone, missing/extra/duplicated/resurrected files, altered hash/size/mtime/old file identity, incomplete/forged shard signatures and old/new config/key/salt errors, unsafe/colliding output paths and dirty/deleted output, source shared-pack + multipart storage layouts, tombstone-only snapshot, and **virtual huge metadata-only** byte totals with `BigInt` (no >100 MB physical test file).

The completed tests are **8/8 PASS**, strict TypeScript/esbuild `pnpm build` PASS, full `pnpm test:fast` PASS, resource/recovery/feasibility suites PASS, GitHub E2E three-bundle compile PASS, metadata/package validators PASS. D78 does not exercise native installed Obsidian or live GitHub because no migration writer/cutover is connected to this contract.

## Important trust boundaries and remaining release gates

- A caller could manufacture a seemingly complete list of output *records* without having uploaded or authenticated their ciphertext; D78 deliberately **does not** establish record provenance. A trusted coordinator must require every D76 stream to fully consume and `finalize()`, record its immutable object upload receipts, and separately verify all destination objects at the new pinned Git SHA **before any device switches**. Backup and crash recovery require independent proof.
- Existing D76 source readers receive callbacks that must use D70–D73 immutable exact-SHA Git verification; D78 does not wrap or replace those readers. The pre/post source HEAD checks can still miss ABA and do not fence stale old-device writes.
- Same-repository new orphan ancestry cannot erase old Git objects or revoke old clients/keys. Retained old source must stay available for recovery, but old source branch writes during migration are a risky policy decision, **not yet approved**.
- D66 first-public-release Wizard gate remains `status: blocked`; only `ownerApprovedMigrationTopology: passed`, six acceptance checks pending. No GitHub Actions, no master merge, no user vault mutation or destination creation in D78.

## Next safe step

Develop a trusted whole-vault **per-file finalized-output manifest + staged upload receipt journal** with exact-commit readback and independent backup evidence, without choosing stale-device fencing/cutover policy. Run real synthetic GitHub E2E only on approved disposable branch after guards. Do not switch user connection settings or create migration refs until all explicit gates are satisfied.
