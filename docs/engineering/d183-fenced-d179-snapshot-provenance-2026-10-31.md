# D183 — Fenced read-only D182 Snapshot Provenance against full D179 proof

Date: 2026-10-31. Status: **read-only internal evidence derivation and in-memory test-vector revalidation**. NO persistent committed Selector/Receipt, NO Cutover, NO Sync resume. First-release Wizard stays Preview-only; release gate stays `blocked`.

## Problem

D182's Selector/Receipt contract cryptographically binds six SHA-256 fields and the exact encrypted Receipt SHA, but D182 deliberately only validates the hash *syntax*: a caller can submit internally consistent hashes of imaginary Source/Shadow/WAL/Settings contents and still produce a correct test-vector pair. Those ciphertext tags are **not** provenance.

D179 already independently validates a pinned D142 migration Run; D170 Intent, D173 canonical Sync Fence, D176 authenticated AES-GCM Prepared Selector, encrypted WAL and SecretStorage; D178/D177 live three-branch refs and complete encrypted Destination Git content; D138 Source and Shadow consistency. D183 must carry these proofs into D182's *six exact hashes*, under the same initiating-device cooperative lease and with pre/post observations.

## Implementation

New `src/lib/v4/reencryption-fenced-commit-pair-snapshot-provenance.ts` exports:

- `deriveV4FencedCommitPairSnapshotTestContract({readiness,transactionId})`: reads actual local Source Index, Shadow Index, D176 `prepared.json` ciphertext, journal's authenticated WAL Snapshot and Source Settings; derives the intended Destination Settings by changing **only** the Git branch and new passphrase Secret ID in the observed Source settings. Independently hashes all six with SHA-256. Returns the frozen, validated-run D182 *test contract* from observed snapshots only, never from supplied digest values. Caller supplies a nonzero 128-bit transaction ID; the function refuses substitution or mutation during an awaited read.
- `inspectV4FencedCommitPairSnapshotTestVectors(input,contract,pair)`: recomputes all six hashes from fresh independent reads; compares the complete contract exactly, then verifies both D182 AES-GCM test-vector roles and the Selector's SHA-256 link to the exact encrypted Receipt. A forged digest, separate attempt, wrong key, swap or changed readback is rejected. **This is not a committed pair verifier.**

Both use the *same* single outer cooperative initiating-device lease, with checked borrowed callbacks for nested D179 verification (no nonreentrant OS lock reacquisition):

1. Require exact D142 Run/Index/Device/Source/Backup/Destination and owner-approved best-effort WAL Risk acknowledgement, the same adapter, journal/WAL, secrets, journal key, branch readers and D178 Github object; pin functions and publication/remote config/receipt values against mutation across all awaits.
2. Verify the canonical D173 Fence, no active `selector.json` or proposed `marker.json`/root, and capture Source Index, Destination Shadow, bounded authenticated AES-GCM Prepared bytes and prepared WAL snapshot.
3. Run **D179 under the borrowed lease** for full authentic Source/Intent/Secrets/Prepared, twice observed three-branch refs and full Destination Git encrypted HEAD/shards/Blob/decrypted SHA-256 verification.
4. Re-capture local snapshots and check they equal initial bytes, then compute the *actual* six D182 SHA-256 fields from those snapshots and the exact pinned Source/derived proposed Destination Settings; inspect the cryptographic pair when supplied.
5. Run full D179 again; compare a third Source/Shadow/WAL/Prepared snapshot and exact Fence, and finally require the outer Holder to execute precisely one callback and return its exact report. Post-holder Git Client method, publication, Settings, Run or SecretStorage drift invalidates even a previously positive result.

All success statuses are explicitly `snapshot-contract-derived-uncommitted` and `snapshot-bound-pair-authenticated-uncommitted`, with `evidence: best-effort-wal-readback-not-power-loss-durable`. Failure is `manual-recovery-required` and **contract=null**. Every report, including success, has **five fixed false permissions**: Local Cutover, Resume Sync, Rollback, Remote Writes and Old Key Cleanup. No writer, Git ref change, index selection, Settings/SecretStorage update, manual repair, automatic retry, Fence clear or stage transition is invoked. Returned Contract contains no passphrases, GitHub tokens or source plaintext; it exposes identities and six hashes only.

## Verification

Eight new D183 integration tests are in `tests/v4/reencryption-destination-exact-commit.test.ts`, based on the existing D179 fixture: real AES-GCM encrypted metadata, Unicode, empty and >8 MiB file payloads, actual local Shadow/Source Index/Intent/Fence/Prepared evidence, authenticated WAL, and mock GitHub Source/Backup/Destination readers with real encrypted content:

- Positive independent six-hash derivation matches separately reloaded Source Index/Shadow, Prepared ciphertext, WAL, Source/derived Destination Settings; zero mutation and one holder acquisition.
- A D182 in-memory cryptographically bound Selector/Receipt pair authenticates against newly recomputed D179 provenance but **never** confers Commit/Cutover/Sync permissions.
- Forged Source/Shadow/WAL/Prepared/Source Settings/proposed Destination Settings digests or changed transaction ID, including a valid but mismatched encrypted receipt from another attempt, are rejected.
- Stale WAL, torn Prepared, changed Source Settings, wrong new SecretStorage value, torn Sync Fence or unexpected commit residue fail before any authorization.
- Source Index, new SecretStorage value or Destination Git ref mutated *during* a real encrypted Git Blob read invalidate all snapshot claims, without inspector writes.
- A holder that fabricates a result without invoking the body fails closed.
- A Source Git reader method or D100 publication value modified **in the outer Holder epilogue** invalidates a previously good report.
- A transaction ID mutated while awaiting encrypted Git content fails closed.

**Full Fast 1202/1202 PASS** (+8), Maximum Strict TypeScript, Production Build, Recovery and Feasibility PASS, Resource **11/11**, GitHub E2E compile-only **3 bundles**, Metadata/Package validation and bounded **100,000,000-byte** SHA-256 cryptographic soak PASS. No credentialed live GitHub migration, installed Obsidian Desktop/Mobile migration or real power-loss test performed in D183.

## Limits / release blockers

This proves **snapshot provenance relative to the separately validated D179 reader under the cooperative lease**, not persistent transactional or physical power-loss durability, a real OS multi-process fence, or exclusion of a noncooperating external Git writer that changes and restores a ref (ABA). D179 checks Backup/Source current refs/Commit/Trees; the full Backup ciphertext set is not freshly re-read in this module. The D182 proposed Contract hashes current Source/Shadow/Prepared/WAL/Settings; **local Intent is validated by D179, but its raw bytes do not yet have a separate D182 hash field**. The intended Destination Settings hash does not prove successful persistence or SecretStorage cutover.

The valid D182 records are test vectors and cannot be installed as an authoritative committed selector or receipt. Windows Node directory fsync is unsupported; best-effort WAL readback must never be mislabeled durable. Need owner-approved real commit ordering/crash recovery across Settings, SecretStorage and Active Index; persisted independently authenticated receipt/selector, cross-device stale writer protection, guided Manual Recovery, full installed acceptance and real GitHub E2E before enabling Wizard Run. Preserve Source, Backup, Git history and original passphrase. No Native Helper, GitHub Actions, merge, release or automatic cleanup. `docs/release-gates/reencryption-wizard.json` remains `blocked`.
