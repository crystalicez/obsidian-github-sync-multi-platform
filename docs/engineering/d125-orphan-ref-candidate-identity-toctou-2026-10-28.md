# D125 — Pin and revalidate orphan Git candidate identity at create-ref boundary

Date: 2026-10-28. **Fail-closed Git publication hardening only. Re-encryption release gate remains BLOCKED.**

## Verified defect (RED→GREEN)

`publishV4ReencryptionOrphanRef()` checked `prepared.commitSha` and `prepared.treeSha` against the actual zero-parent Git commit before recording durable publication intent. It then awaited the external intent, WAL/lease checks, ref absence probes, and repository identity checks, but finally called `github.createGitRef(prepared.commitSha)` using the **same caller-owned object reference**. A caller-supplied/reconstructed structural `V4PreparedOrphanCommit` can be mutable, despite TypeScript `readonly` declarations.

A deterministic regression constructs a mutable copy of a real valid prepared orphan commit and changes its `commitSha` inside `assertDurablePublicationIntent`. **Before the fix the method returned success and called `createGitRef` using an entirely different commit SHA from the one that had been authenticated earlier.** The test failed with `Missing expected rejection`. This is a concrete check/use mismatch at an irreversible GitHub mutation boundary. Actual `prepareV4ReencryptionOrphanCommit()` normally returns `Object.freeze()`, which reduces the likelihood in the normal preparation path; this hardening also protects reconstructed or structurally supplied inputs and future callers.

## Runtime change

In `src/lib/v4/reencryption-orphan-publication.ts`:

- After validating the prepared orphan contract and **before any await**, capture an immutable value copy of the entire candidate receipt and its canonical serialized identity.
- Read and verify the exact **captured** Git candidate `commitSha`, `treeSha`, and zero-parent ancestry.
- Recheck that the caller's entire prepared receipt still matches its captured identity after asynchronous WAL intent/readback and **immediately before** calling `github.createGitRef`. There are no awaits between the final comparison and the Git POST.
- Use the captured commit SHA for the Git POST, double ref readback, and reported identity. Revalidate caller evidence after post-create observations before returning a successful acknowledgment.
- On any difference throw a fail-closed candidate-identity error. No retry, no branch overwrite, no silent WAL reset or new local cutover capability.

## Regression evidence

- First test injected a SHA replacement inside the durable-intent callback. **RED** before implementation, **GREEN** after; zero `createGitRef` calls after the fix.
- Second test injects the same candidate replacement from a WAL `assertHealthySnapshot` callback, **after** low-level Git commit readback but before the one-shot Destination ref POST. D102 must refuse creation, preserve exactly one pending WAL Destination intent for manual reconciliation, and grant no cutover.
- Focused orphan publication suite **49/49 PASS**, full Fast **930/930**, Fast repeat **10×930/930** (exit 0, no failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), metadata/package validation PASS. Cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS, exact reference SHA-256 matched.

These tests run against in-memory GitHub/WAL adapters to reproducibly exercise the exact asynchronous boundary; **no real GitHub ref was created**. This change does not make the caller-supplied WAL callback hardware durable, enforce an OS-wide vault write fence, or prove a power-failure-safe initiating-device settings transaction.

## Release blockers and owner decisions unchanged

D90/D91 topology is unchanged: independently writable old Source, immutable verified Backup at old-source SHA, new zero-parent orphan Destination in the **same** physical GitHub repository. No automatic branch deletion or other-device migration; no GitHub Actions. The Wizard stays Preview-only and `docs/release-gates/reencryption-wizard.json` stays `blocked`. Windows Node-only directory `fsync EPERM` prevents certifying physical power-loss WAL durability, OS-wide cross-process Vault editing exclusion is unproven, and crash-safe initiating-only Branch/Passphrase/Index cutover, new-key provenance/recovery, pinned numeric-ID live GitHub three-ref acceptance and installed Windows/mobile multi-device tests remain outstanding. Do not promote a Native OS Helper or waive these gates without explicit owner approval.
