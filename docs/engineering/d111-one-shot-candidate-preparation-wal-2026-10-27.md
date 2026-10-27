# D111 — One-shot encrypted WAL before orphan candidate Git metadata/tree/commit

Date: 2026-10-27. **Internal migration backend hardening; Re-encryption Wizard still blocked and Preview-only.**

## Gap addressed

D109 crash-durable barriers covered new ciphertext Blob staging; D110 WAL bound the final Destination ref to its exact commit/tree/new-key manifest. However, orphan candidate **PREPARATION** (new-key metadata blobs, Git tree and zero-parent commit) occurred **before** the Destination ref-intent was recorded. If a GitHub metadata Blob POST succeeded but the response was lost (or Windows lost power), the caller had no durable one-shot candidate-preparation evidence and could re-enter preparation without recognizing that prior remote Git objects had been created.

These unreferenced Git objects cannot replace user branches on their own, but blind preparation retries and mistaken candidate provenance are unacceptable for a safe migration.

## D111 implementation

- `src/lib/v4/reencryption-candidate-manifest-digest.ts` adds a **pre-commit**, domain-separated deterministic incremental SHA-256 digest over the pinned old Source Commit + Tree, destination repo identity/public KDF config, exact old Source config, new metadata Device ID/Journal ID/createdAt, every finalized destination record and staged ciphertext receipt. It cannot include the new Git Commit/Tree SHA because those do not exist yet; the separate D110 **post-commit** manifest digest continues to bind those afterward. Neither digest serializes passphrases, keyrings or note plaintext.
- `src/lib/v4/reencryption-recovery-journal.ts` adds `candidatePreparationSha256` to the existing **AES-GCM authenticated two-slot journal** (nullable for D80/D81 legacy records). `recordCandidatePreparationIntent(digest, expectedGeneration)` is **one-shot**, generation-CAS, requires verified frozen Backup + completed Staging, refuses unresolved Git Blob/Ref intents, and records the phase BEFORE Git metadata/tree/commit mutation. Further `recordUploadIntent` requests are prohibited; Destination Ref Intents require this exact phase. Encrypted payload validation rejects impossible phase combinations. A marker survives restart, but does not authorize automatic resumption/retry.
- `src/lib/v4/reencryption-ref-journal-coordinator.ts` adds `prepareV4JournaledOrphanCandidate`: it matches the authenticated WAL Backup ref and every exact staged receipt, computes the pre-commit digest, writes the one-shot marker, then **requires the SAME OS WAL lease + crash-durable barrier and healthy exact WAL generation before EVERY metadata Blob, Git tree and zero-parent Commit mutation**. If the response is lost, it leaves the one-shot marker and returns an error; no blind retry. The existing non-publishing low-level D96 helper remains for isolated tests; this is the guarded D90/D91 three-branch entrypoint.
- D102 Destination publication and D103 read-only restart reconciliation both require the exact persisted **pre-commit digest matching the reconstituted expected config/records/receipts**, in addition to D110's post-commit candidate fingerprint, Backup evidence, pinned commit/tree, full remote decrypt/readback and no-cutover guarantees.

## Actual test evidence

- Low-level journal tests prove zero-file/vault one-shot phase survives restart, rejects repeated/different intents, refuses subsequent Blob staging, and refuses candidate preparation while an upload remains pending.
- Guarded full in-memory Git fixture proves the encrypted WAL intent exists before metadata Git Blob/Tree/Commit, preserves the zero-parent orphan topology, cannot re-enter after restart and never creates a destination branch.
- Simulated Windows WAL `directory fsync EPERM` **after** sealing but **before** the first Git POST leaves the candidate marker and sends **zero remote candidate writes**. A real GitHub metadata Blob that accepted a POST but returned a lost response leaves the marker pending and is **not uploaded again** by the guarded helper. Publishing a candidate without a one-shot marker is refused before create-ref. An additional regression mutates a staged file's SHA-256 **after the WAL intent is sealed** but before the first metadata POST; the coordinator rehashes its input evidence at the mutation boundary, refuses all Git metadata writes, and retains the sealed one-shot intent for manual recovery.
- Additional fail-closed regressions reject staged-record or receipt substitution after sealing and changes introduced after the first metadata Git Blob, before further Git mutation. Torn candidate-preparation WAL slot never permits replay or a Destination ref.
- Real disposable Windows desktop WAL test confirms the marker persists across WAL release/reacquire and that its digest remains inside encrypted on-disk bytes.
- Full local qualification: Fast **902/902 PASS**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production build, GitHub E2E compile-only (three bundles), package and metadata validation **PASS**.

## Hard limits

- This is a **fail-closed stop / forensic intent**, NOT automatic recovery of unreachable metadata Git objects. A crashed preparation run requires operator/manual reconciliation; no candidate Git object graph can be safely presumed publishable merely from an intent.
- The WAL barrier is a structural interface; no-op callbacks exist ONLY in tests. On real unsupported Windows Node.js directory `fsync EPERM`, the coordinator refuses to proceed. It is **NOT** an OS power-loss durability proof or a cross-process Vault edit fence.
- Full migration coordination, secret provenance, actual local new-key/branch/index Cutover with durable rollback, physical power-cut validation, and installed Obsidian multi-device/mobile acceptance remain missing. The verified numeric disposable `GITHUB_E2E_EXPECTED_REPO_ID` pin is still required before any live GitHub E2E writes. No user vault, branch or live GitHub was mutated in D111.
- Owner D90/D91: old Source stays independently writable, old-key Backup frozen, new-key Destination is zero-parent orphan in same physical GitHub repo, no forcing old devices to pause/switch. No GitHub Actions, uncontrolled Native Helper, automatic cleanup or weakening safety checks.

`docs/release-gates/reencryption-wizard.json` **remains `status:"blocked"`**. Settings Wizard remains Preview-only.
