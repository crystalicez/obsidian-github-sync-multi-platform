# D138: Cross-surface read-only Re-encryption evidence under one externally held initiator lease

Date: 2026-10-28. Wizard remains Preview-only. First public release gate stays **blocked**.

## Scope and invariant

`inspectV4ReencryptionCrossSurfaceProof()` composes the existing D136 source/Intent/encrypted WAL restart inspector, D137 remote-verified Shadow reader, and the D110 deterministic candidate-manifest digest. It operates under one caller-provided `withExclusiveInitiatorLease(async () => ...)` callback. That callback **must actually hold** a live exclusive initiator lease for the full asynchronous body and must not return before it finishes. The supplied `assertExclusiveInitiatorLease` and `assertCrashDurable` barriers are checked throughout. A JavaScript callback or a passing mock **cannot** prove OS-wide writer exclusion or physical power-loss persistence.

The proof coordinates these identities without writing anything:

- Same run ID, Source Index root, Shadow root, local adapter, device ID, exact Source/Backup/Destination refs and source/destination Git SHAs across both inspectors.
- Destination SecretStorage value read under the lease exactly matches the passphrase used by the cryptographic Git proof. Old SecretStorage value remains accessible. Neither value is returned or recorded.
- Complete Source and Shadow Index snapshots are compared before and after remote verification. The D135 run-scoped Intent, Source settings and D132 WAL are checked twice via D136, before and after D137; a separately read authenticated WAL snapshot also brackets the whole cross-surface operation.
- The prepared orphan candidate must match the independent D83 remote plan, pinned Source Git commit/tree, Destination commit/tree and physical repository identity. The complete staged Shadow record set plus Destination config and ciphertext receipts are recomputed into the exact D110 candidate-manifest SHA-256. This digest must equal the prepared-candidate and verified Destination ref receipts inside the independently authenticated encrypted WAL, including Backup source-commit/tree receipt.
- D137 independently verifies the exact Git branch, orphan commit and tree, decrypts encrypted HEAD/shards using the new passphrase, verifies all records against Shadow, checks ciphertext Git blob identity and every plaintext SHA-256/size. Changes to WAL, Source, Shadow, Git reader, Intent, secret presence or input identity fail closed.

The only positive observation is `all-surfaces-coherent-uncommitted`; every outcome has `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, `oldPassphraseCleanupAuthorized:false`. When local evidence is inconsistent, report `manual-recovery-required`. Hardware/lease/Git transport errors propagate without returning positive proof. The callback must invoke the inspection exactly once; skipping it or returning a fabricated report cannot produce success.

## RED to GREEN evidence

Extended the full encrypted Destination verifier test fixture, retaining the actual production AES-GCM + Git blob code and simulated GitHub GET transport. This uncovered three correctness/test-isolation defects:

1. The preexisting D83 synthetic fixture shared the same `receipts` array among test cases. A D138 tamper test accidentally contaminated later test cases. Fixed by defensively copying receipt objects per fixture before any tests mutate them.
2. A D138 test changed Source Index generation after the first local read but during remote Git fetch. The first implementation returned a false-positive coherent report because it compared only Shadow+WAL across the outer boundary. Added an exact Source Index readback comparison before and after remote verification; the test is now GREEN.

3. The D138 outer proof originally pinned the GitHub client object but not its five GET method references. A reader replacement while the first WAL inspection was in flight could slip through before D137 started pinning its own reader. A new RED test reproduced the false-positive, and D138 now pins and compares all GitHub GET methods across the whole outer proof. GREEN 21/21 focused cases.

Tests cover full positive proof with zero adapter writes, WAL receipt digest mismatch, tampered Backup tree, lost authenticated WAL receipt while Git read is in flight, Source change while Git read is in flight, torn Intent, wrong new SecretStorage value, changed candidate/identity, transport failure, absent holder invocation and lost lease/WAL reader exceptions. Focused D83+D137+D138 tests **21/21 PASS** on final source. Maximum Strict TypeScript, production Build, Fast **995/995** on initial D138 source; final exact-source Fast repeat includes one additional regression and is tracked separately, Recovery **85/85**, Resource **11/11**, Feasibility **136/136**, GitHub E2E compile-only 3 bundles, package/release validations and bounded 100,000,000-byte SHA-256 soak PASS. Final-source ten-round Fast repeat **10 × 996/996 PASS, exit 0, zero failures**, after all D138 hardening and nine new D138 tests. Recovery 85/85, Resource 11/11, Feasibility 136/136, Maximum Strict TypeScript, production Build, GitHub E2E compile-only three bundles, release metadata and package validations, and 100 MB SHA-matched cryptographic soak also PASS. No live GitHub or installed Obsidian migration was run.

## Strict boundaries and next steps

The authenticated WAL contains earlier verified Backup/Destination ref observations. D138 rereads the live **Destination** ref inside D83 but does **not** reread the live Backup ref, so its result is not proof that the frozen Backup branch remains unchanged at the end of the check. A future activation gate must independently revalidate Backup and physical repository identity at the commit boundary.

The positive result is ephemeral, point-in-time, and uncommitted. It is not an authenticated durable *local cutover commit receipt*. The current implementation is not wired into production Wizard/Sync and does not change Git branches, Vault, Settings, SecretStorage, WAL, Index or any GitHub object. The local simulated lease and GitHub test client do not substitute for real adapter-backed platform tests.

Production blockers remain a strict power-loss-durable commit transaction spanning Obsidian settings + selected active Index + SecretStorage reference, post-crash idempotent restart reconciliation, Windows Node-only WAL parent directory `fsync EPERM`, physical Android/iOS and desktop qualification, and live same-repository three-ref Obsidian multi-device acceptance. Old Source/Backup and both secrets remain retained until **after** separately proven commit/recovery and owner-approved old-accessible-value cleanup. Do not add Native Helper, GitHub Actions or relax the strict release gate without explicit owner approval.

Next safe stage: design/implement **non-authorizing, power-loss fault-model transaction state machine and read-only recovery proofs**; do not promote D138 observation to cutover permission. Confirm real platform crash durability before implementing an enabled local switch.
