# D124 — Pin one authenticated source evidence set across all Destination publication guards

Date: 2026-10-28. **Production-adjacent three-branch safety hardening; Re-encryption Wizard RELEASE BLOCKED.**

## RED→GREEN: Source SHA can change between multiple live-vault guard calls

D123 copied each authenticated remote source index record *within one* `verifyV4ReencryptionInitiatorLocalParity()` invocation. However, the D100 publication and D102 journal coordinator call that verifier multiple times over async Git reads, local WAL intent writes, ref creation and remote readbacks, each time reading the **same mutable caller-owned Source record objects**. The later guard could therefore accept a **different local SHA-256 as if it had been authenticated from the original pinned Source**.

Two deterministic regressions in `tests/v4/reencryption-orphan-publication.test.ts` reproduced false successful Destination publication on the prior implementation:

1. **D100 direct publisher:** After the first complete local parity check, the durable-intent callback changes the initiating physical-reader bytes to a different, same-size note *and modifies the caller-owned source-record SHA to match*. The next guard accepts this second SHA despite the immutable Source/Backup remaining unchanged. On unpatched code the operation resolved successfully and called `createGitRef`; the test expected a pre-publication failure.
2. **D102 WAL-bound coordinator:** The callback after `recordRefIntent` has persisted the irreversible one-shot Destination intent makes the same substitution *before D100 even begins*. A snapshot taken only inside D100 is already too late; on unpatched code the run could still publish a ref and report success.

Both tests first failed with **Missing expected rejection** before their respective runtime fixes. The model GitHub endpoints are deterministic test doubles, not live GitHub requests.

## Runtime changes

- Add `captureV4ReencryptionInitiatorParityEvidence()` to `src/lib/v4/reencryption-initiator-parity.ts`. It synchronously makes immutable, by-value snapshots of each original authenticated source record and verified totals. The **live reader, signal, and all guard callbacks remain live**, rather than being replaced with stale observations.
- `publishV4ThreeBranchDestinationAfterBackup()` captures this pinned evidence **once before its first async Git or WAL boundary** and passes it to every full local-parity guard before and after the ref operation. Source SHA cannot be redefined between its checks.
- `publishV4JournaledThreeBranchDestination()` captures the same evidence **before its first WAL lease/read/intent await** and passes that unchanged snapshot into D100. The lower-level publisher takes its own defensive snapshot for direct callers, so the outer WAL capture is not bypassed.
- The original D123 two-pass physical SHA-256 verification, D122 no-open-editor rule, lock/durability gates and one-shot WAL semantics remain unchanged. A rejected WAL-bound operation leaves the signed Destination ref intent intact for manual recovery; no automatic retry or silent WAL discard was added.

## Verification and limits

- Focused D96-D124 publication suite **47/47 PASS**; both added cases RED before changes and GREEN after.
- Maximum Strict TypeScript PASS. Full Fast **928/928**, Fast repeat **10×928/928** (exit 0), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Production Build, GitHub E2E compile-only 3 bundles and package/metadata validation PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS with SHA-256 identical to the reference.
- This fix prevents *in-memory caller-controlled SHA substitution across publication checks*. It does NOT provide a filesystem snapshot, guarantee an external editor/process cannot modify files after the final check, prove hardware sudden-power-loss WAL durability on Windows, authorize local settings cutover, or claim that test-only no-op lease/durability callbacks are real OS protection.

## Still blocked, requiring owner decisions

Windows Node-only directory `fsync EPERM` still blocks physical power-loss durability. A genuine multi-process Vault writer fence, initiating-device crash-safe Branch/Passphrase/Index cutover, new-key provenance and recovery, numeric-pinned live GitHub same-repository three-ref acceptance, installed Windows/mobile multi-device qualification and GitHub old-history/key disclosure checks are still pending. **Do not** waive safety gates, promote a Native OS Helper, enable GitHub Actions or make branches auto-delete without owner approval. D90/D91 topology remains independent writable old Source + frozen Backup + zero-parent orphan Destination in one repository; Wizard stays Preview-only; `docs/release-gates/reencryption-wizard.json` remains `blocked`.
