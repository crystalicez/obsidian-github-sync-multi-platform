# D110 — Domain-separated candidate/manifest fingerprint bound to encrypted Destination ref WAL

Date: 2026-10-27. **Internal backend safety, NOT end-user or release qualified.**

## Owner-approved topology and issue

D90/D91: independently writable old Source branch, immutable old-key Backup branch pinned to one authenticated original commit, and a new zero-parent orphan Destination with fresh encryption in the SAME physical GitHub repository. Independent old clients continue syncing; only the initiating device may eventually opt into the new branch after separately qualified Cutover. No GitHub Actions or unapproved Native Helper.

D101–D109 WAL persisted exactly the target Destination Git Commit SHA and Tree SHA and each staged Git Blob receipt. But after a crash, the D103 read-only recovery controller still accepted **caller-supplied reconstructed new metadata file records, Git receipts and encryption configuration** that were not explicitly fingerprint-bound in the destination ref intent. Correct commit/tree references alone do not prove that the reconstructed manifest belongs to the same new-key migration run. A structurally plausible yet different record/config set could pass the initial ref-intent comparison and only fail later during complete remote verification.

## Implementation

- New `src/lib/v4/reencryption-candidate-manifest-digest.ts` computes a domain-separated SHA-256 `v4-reencryption-candidate-manifest-v1` fingerprint over exact prepared orphan candidate (including source pinned commit/tree, destination SHA/tree and zero-parent evidence), authenticated old-source tree SHA, expected **public** destination crypto configuration/KDF parameters, and every expected encrypted metadata record and staged ciphertext Blob receipt.
- Canonical object property ordering and sorted record/receipt paths make the digest deterministic after JSON deserialization and insensitive to in-memory map iteration order. Incremental SHA-256 absorbs one record/receipt at a time rather than serializing the entire Vault into a new large buffer. No passphrases, plaintext note contents or derived keys are serialized by this helper. Logical file path strings appear only in transient digest input, and the resulting digest is kept INSIDE the already AES-GCM-encrypted WAL payload.
- `V4ReencryptionRefIntent` now requires a strict 64-character lowercase `manifestSha256` for the Destination role and disallows it for the Backup role. Both encrypted WAL intent/readback comparisons and the D102/D103 same-run/restart coordinator compare this digest **in addition to Commit SHA, Tree SHA and repo/branch identity**. Missing/wrong fingerprints are rejected; no GitHub ref creation, automatic retry, overwrite or local Cutover occurs.
- D110 corrects a trust-boundary oversight found by its own regression: the journal-side exact-ref comparator initially understood the digest but the coordinator-level `sameRef` still compared only role/repo/commit/tree. The coordinator now includes `manifestSha256`; a changed recovered manifest fails **before** remote recovery readback rather than merely failing downstream.

## Tests and scope

- New tests in `tests/v4/reencryption-orphan-publication.test.ts` verify deterministic digests across changed object property/manifest list ordering, detect changes to a record plaintext SHA-256, Git receipt SHA, and PBKDF2 salt, and refuse mismatched restart recovery while leaving the existing exact Destination WAL intent pending, with **zero Git ref create calls**.
- New low-level journal test rejects absent/non-hex/wrong-length Destination manifest fingerprints without modifying the WAL and refuses a mismatched readback. Existing real Node OS filesystem WAL test now asserts the stored Destination fingerprint remains encrypted and can be read from the WAL after release/reacquire.
- Full local qualification: **Fast 891/891 PASS**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, build, GitHub E2E compile-only (three bundles), package and metadata validation PASS.
- This is an **unkeyed but domain-separated** manifest consistency digest stored within an authenticated encrypted run WAL. It is not an independent proof of correct initial source provenance, a crash-safe storage guarantee, a new crypto key, permission to publish, or device Cutover. Source, Backup and Destination *cryptographic content* checks must still independently run.

## Remaining blockers — no safety waiver

- D86 Windows Node-only directory `fsync` fails `EPERM`, so power-loss durable WAL is not established; this blocks actual three-branch remote publication in production.
- The complete reliable migration coordinator, persistent new-key provenance, real cross-process Vault write fence, crash-safe initiating-device-only Branch/Passphrase/Index Cutover and installed Obsidian Windows two-device/mobile tests remain outstanding. No user Vault mutation or live GitHub ref creation occurred in D110.
- Real disposable GitHub E2E still requires the mandatory verified numeric `GITHUB_E2E_EXPECTED_REPO_ID` in locally ignored credentials; do not fabricate/bypass the pin, do not exceed the 100 MB physical test-file cap or introduce GitHub Actions/Native Helper without owner approval.

`docs/release-gates/reencryption-wizard.json` stays **`status:"blocked"`** and the Settings Re-encryption Wizard remains Preview-only.
