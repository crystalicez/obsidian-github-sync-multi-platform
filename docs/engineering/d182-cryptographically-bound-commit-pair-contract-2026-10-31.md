# D182 — Cryptographically bound Selector + Receipt contract test vectors (NOT a commit)

Date: 2026-10-31. Status: **internal in-memory contract prototype only**, no disk writes, not production-authorizing. Re-encryption Wizard remains **Preview-only** and release gate `blocked`.

## Security gap

D142/D147 provide independently authenticated **uncommitted test vectors** for a hypothetical receipt and a separated selector. D172/D176 provide a real **Prepared** AES-GCM marker, but no authoritative Selector/Commit Receipt. D180/D181 reject unexpected commit-looking residue on restart. A future committed transaction needs an auditable link between the exact receipt and selector bytes, plus the single Run's Source/Backup/Destination, Source/Shadow snapshots, encrypted Prepared Evidence, WAL generation and Settings states. Merely having two independently authentic AES-GCM blobs with the same Run identity is insufficient: they can be assembled from different attempts.

## Added prototype

`src/lib/v4/reencryption-commit-pair-test-vectors.ts` exports strictly named **in-memory test-vector** operations:

- `sealV4ReencryptionCommitPairTestVectors(contract, journalKey)` produces only two returned strings. There is **no persistent adapter, GitHub client, file writer or Runtime integration**.
- `inspectV4ReencryptionCommitPairTestVectors(contract, journalKey, pair)` authenticates them and returns `both-test-vectors-authenticate-uncommitted` or `manual-recovery-required` with nonsecret reasons: `both-absent`, `one-artifact-missing`, `invalid-or-mismatched-pair`. Even a successful match says `linked-but-not-authoritative`.
- The proposed contract has an externally supplied 128-bit transaction ID, the complete validated D142 `V4ReencryptionProposedCommitIdentity` (Run, WAL generation, Source/Backup/Destination refs/commits/trees, manifest, Index root, device, old/new Secret IDs), and six SHA-256 digests: immutable Source Index, Destination Shadow Index, AES-GCM `prepared.json`, WAL snapshot, Source Settings and intended Destination Settings. Every record has an exact canonical field set and its own `schemaVersion` and explicitly `test-vector-uncommitted` phase. The prototype **validates digest format, not their provenance**; actual production would have to independently derive and verify them under a stable lease.
- Receipt and Selector use **separate HMAC-SHA256 keys derived from the journal key with role-specific contexts**, distinct AES-GCM AAD, and canonical base64 + bounded 8 KiB ciphertext. The Selector additionally contains **SHA-256 of the exact encrypted Receipt string**, not only the shared Run. Random AES-GCM ciphertext from a second attempt cannot be swapped into an earlier Selector even if the underlying contract fields match.
- Both plaintext and intermediate keys are zeroed where possible. Mutation of contract/key/pair across awaited authentication fails closed. No key, SecretStorage values, passphrase or GitHub access token is written to a report.

## Evidence and crash/replay matrix

New `tests/v4/reencryption-commit-pair-test-vectors.test.ts` — **9/9 PASS**:

1. Real AES-GCM pair authenticates under separate key/AAD contexts and has **every Cutover/Sync/Rollback/Cleanup permission false**.
2. Both missing, one missing, torn/malformed/noncanonical/oversized Receipt or Selector deny success.
3. Swapping separately encrypted Receipts across *identical* contract/Run pairs is rejected by selector-to-ciphertext SHA.
4. Changed Source Index, Shadow Index, Prepared Evidence, WAL Snapshot, Source/Destination Settings, transaction ID, WAL generation, Run, Git ref/commit/manifest, Secret ID or device identity denies replay; wrong journal key denies decryption.
5. D142 hypothetical Receipt, D147 Selector and D172 Prepared markers cannot be substituted for either new test vector.
6. Same-key forged AES-GCM records with extra `cutoverAuthorized` fields, changed identities or a spoofed `committed` phase are rejected.
7. Invalid transaction IDs, digest lengths/cases, extra contract/identity fields and incorrect journal key length reject generation.
8. Even internally coherent **placeholder digests** never authorize an actual Cutover.
9. A caller that swaps supplied evidence while authentication awaits is detected.

One extra integration regression in `tests/v4/reencryption-prepared-selector-stage.test.ts` derives actual digests from runtime-root Source/Shadow Indices, Encrypted Prepared Evidence, WAL and mock Source/Destination Settings, generates valid D182 vectors, and puts them in the mock active Selector and proposed receipt paths. The **real D180 restart triage still returns `manual-recovery-required`**, preserves all bytes and the D173 Sync Fence, and refuses to Resume Sync or clean the old key.

**Total new D182 tests: 10. Full Fast: 1194/1194 PASS.** Maximum Strict TypeScript, Production Build, Recovery, Feasibility, Resource **11/11**, GitHub E2E compile-only **3 bundles**, release Metadata/Package validators and the bounded **100,000,000-byte** SHA-256 cryptographic soak all pass.

## Explicitly NOT proven

This is a prototype for a future transaction contract; it does **not** provide an authoritative commit point, durability, a persistent writer, guaranteed anti-replay storage, full content proof by itself, a cross-process/multi-device fence, Settings/SecretStorage transaction, an automatic recovery decision or permission to use new passphrase/Branch. Correct AES-GCM tags prove only that a holder of the journal key sealed matching records; they do **not** prove a real migration happened, that source digests came from independent storage, or that the bytes survived power loss. An attacker or noncooperating local writer could mutate+restore data between reads (ABA). Windows Node still cannot independently prove directory fsync. The installed Wizard does **not** invoke this API.

## Next boundary

A future D183+ **read-only independently verified snapshot provenance** should derive these digests from the pinned D179 Source, Shadow, Intent, WAL, Settings and live Git proof rather than accepting hash placeholders, and classify interleavings of a potential persisted pair under the D173 Fence. Only after **owner-approved ordering and Manual Recovery semantics** should a separate committed writer/selector be considered; no automatic cutover or fence removal until independently demonstrated. Preserve Source, Backup, original Git history and old passphrase. Do not add Native Helper, GitHub Actions, merge or release. Keep `docs/release-gates/reencryption-wizard.json` `blocked`.
