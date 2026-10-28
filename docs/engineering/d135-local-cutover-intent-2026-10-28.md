# D135: isolated local Re-encryption cutover intent

Date: 2026-10-28. The Wizard is still preview-only. Release gate remains **blocked**.

## Boundary

`src/lib/v4/reencryption-local-cutover-intent.ts` prepares one independent, run-scoped, nonsecret **prepared-uncommitted** intent at `<active-index-root>-rekey-intent-<run-id>/intent.json`. It never changes Source/Shadow Index files, normal Settings, SecretStorage, the user Vault or remote branches. It does **not** resume Sync, commit a migration, approve local cutover or clear the old passphrase.

The record fixes schema/phase, run ID, exact Source/Backup/Destination repository identities, pinned Source/Destination Git commit SHAs, WAL generation, active Source Index root, Shadow Destination Index root, device ID and both SecretStorage **identifiers**, not their values. D136 hardened the existing D135 writer to refuse serialized Intent records larger than the shared **8 KiB** restart-reader limit before any Intent directory creation. Oversized but syntactically safe Git branch identities can no longer produce an Intent that the subsequent reader must reject. Its SHA-256 is a corruption checksum. It is **not a MAC, a trusted WAL receipt or authentication of local files**. A malicious writer able to rewrite the record can also recompute the checksum.

## Safe preparation

- Validate all input identities and three distinct Git branches in one repository, bounds for run/path/secret IDs and a positive WAL generation before I/O.
- Require a caller-provided exclusive initiator lease and a real crash-persistence assertion. Read both already-staged encrypted local indices via existing sharded index verification. Compare exact Source/Shadow repository IDs, commit SHAs, device ID, mode, path layout, complete shard records and absence of dirty/deleted records.
- Claim the stage synchronously **per adapter instance** to block same-process overlapping calls. Pin the adapter and lease/durability callbacks before the first await and check they are unchanged before any intent write and at completion. A RED test showed that replacing the adapter mid-lease otherwise wrote to an unintended store; fixed code rejects that attempt and reclaims the original adapter's in-process claim. Refuse any existing intent directory rather than reusing a partial or uncertain attempt. These checks **do not** create an OS-level exclusive directory claim or guarantee no other process can write the root.
- Write the complete nonsecret `prepared-uncommitted` record to its own directory, require persistence barriers, read back the **exact expected serialized bytes**, repeat lease/durability checks, recheck frozen caller fields and reread Source and Shadow indices. Any thrown error is fail-closed. A failed or ambiguous intent directory is retained for manual recovery; there is no automatic deletion, retry, rollback or intent commit.
- Never log, return or store actual GitHub tokens or plaintext passphrases. The old and new SecretStorage IDs remain referenced for future manual recovery; no SecretStorage API call occurs.

## Verification and limits

`tests/v4/reencryption-local-cutover-intent.test.ts` covers success without changing either index, reused/lost-acknowledgement intent, forged readback with recomputed SHA-256, wrong identities/missing indices, invalid lease/durability, mid-await mutation and concurrent same-adapter calls. `tests/recovery/reencryption-local-cutover-intent-windows.test.ts` uses an actual disposable Windows directory, persists bytes and then simulates acknowledgement loss. It verifies that both local index headers survive unchanged, and a fresh call refuses the ambiguous persisted intent. It is **not** a sudden-power-loss proof, because the test's barrier callbacks are stubs.

This is a useful staging/recovery prerequisite, **not** a transaction coordinator. No initial WAL attestation, verified live GitHub ref readback, authenticated key provenance, atomically durable Settings/SecretStorage/Index selection, OS-wide Vault writer fence, or restart reconciliation is implemented here. A future component may only treat the staged record as a hint while it independently authenticates exact identities and WAL state. No bypass of Windows Node directory `fsync EPERM`; no Native Helper promotion, GitHub Actions, live branch mutations or release gate changes.

Follow-up: independent read-only restart inspection binding this intent to the D132 authenticated WAL and D134 Shadow Index, then a physically proven platform durability design before implementing a commit or automatic initiating-device cutover. Retain both keys until durable commit/recovery is proven; after success, clear the obsolete **accessible value** as approved, not claim secure physical erasure.
