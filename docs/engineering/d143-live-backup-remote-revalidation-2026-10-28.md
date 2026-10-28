# D143 — Live frozen Backup ref revalidation around D138 authenticated Destination proof

Date: 2026-10-28. **Read-only evidence. Re-encryption Wizard stays Preview-only; release gate stays blocked.**

## Why

D138 binds the encrypted two-slot WAL to the Source and Shadow local indices, Source Settings and both accessible SecretStorage values and independently decrypts/verifies the full Destination Git commit and content. However the Backup observation in the WAL is historical: the frozen Backup Git ref might move or disappear between the original D99 verification and local cutover. Its old WAL receipt still authenticates, but it cannot prove a **live** Backup ref.

## D143 implementation

`src/lib/v4/reencryption-live-backup-cross-surface.ts` exports `inspectV4ReencryptionLiveBackupCrossSurface()`. It accepts the same D138 `restart`, `shadow`, `preparedCandidate`, and `withExclusiveInitiatorLease`, plus a **separately configured GET-only Backup reader** exposing repository identity/default branch, exact branch Git ref and immutable commit.

Before the expensive D138 full content proof **and again afterward**, while the **same** caller-supplied exclusive initiator holder remains active, D143:

- Requires the Backup reader's configured branch to match the pinned WAL Backup repo/ref exactly and to be **distinct** from Source and Destination refs in the same physical GitHub repository.
- Calls the live GitHub repository identity API and matches pinned physical repository numeric ID and full repository name.
- Checks the current default branch is neither frozen Backup nor Destination.
- Calls the live Backup ref and demands `refs/heads/<backup>`, type `commit`, and the exact original pinned Source SHA.
- Re-reads that immutable Git commit and requires the exact Source commit SHA and tree SHA. It validates parent identities but does not demand Source history stay frozen; the owner's D90 policy allows the Source Git branch to advance independently.

D143 composes the **unmodified** D138 cryptographic destination proof inside the same external holder via a one-shot nested callback; no nested independent OS lease or Git ref mutation is introduced. After D138, it reasserts lease/durability, re-reads the live Backup and **reasserts the lease/durability after the last awaited GitHub GET**. Input identity, remote plan/config/receipts and settings are fingerprinted across awaits; Backup and Destination Git GET function references, adapter `read/exists/stat`, authenticated WAL reader, SecretStorage callback, destination passphrase, signal and live holder are pinned *before the first Backup GET*. Any mismatch => `manual-recovery-required`; transport or lost lease exceptions propagate; no report grants write authority. In particular, a holder that skips the inspection body cannot forge a positive result.

Positive observation **`all-three-ref-evidence-coherent-uncommitted`** is a point-in-time read-only consistency statement. The historical Source **snapshot** is bound; the **live Source branch is not required to stay frozen**, as other devices can continue Sync. The Backup ref and verified Destination ref can still move *after* the final GET, and an external writer can edit the Vault after the last local scan. Therefore D143 must never become an automatic cutover or old-key cleanup gate by itself. Every returned report hardcodes `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, `oldPassphraseCleanupAuthorized:false`.

## Tests

Seven initial D143 behavioral tests plus **two RED→GREEN regressions** are added to the existing D83+D137+D138 AES-GCM / real Git blob simulator fixture in `tests/v4/reencryption-destination-exact-commit.test.ts`. They verify two separate live Backup revalidations (eight live Backup GETs), one held lease, no file writes or secret values returned; moved or missing Backup; wrong Source tree, default branch or physical repository; ref moved while decrypting Destination Git ciphertext; Backup reader swapped during first GET or while WAL is inspected; invalid configured branch; lost network response; and forged/missing holder. A new **RED** test swapped the Destination Git GET method **during the very first Backup GET**, before D138 began pinning its own remote reader. The first D143 implementation incorrectly reported coherent evidence. D143 was fixed to pin all five Destination GET method references and full remote scope at the **outer** boundary; the test is now GREEN. A second RED regression showed that a lease lost **during the final Backup GET** could return a positive observation because lease/durability checks ran only before that GET. D143 now reasserts lease and durability **after** the final Backup GET, before returning; this regression is GREEN.

The tests use a mocked Git transport, real V4 crypto and read-only local adapter. They **do not** perform a live three-ref GitHub mutation, installed Obsidian device acceptance, or hardware power-loss qualification. Passing a mocked `assertCrashDurable` callback is not platform durability.

## Remaining production gates

- Windows Node-only directory `fsync` remains `EPERM`; independently qualified power-loss durability on Windows/macOS/Linux/Android/iOS remains absent.
- Obsidian `saveData()`, selected active Index and SecretStorage ID still cannot be committed with an authenticated, durable, single authoritative selector and idempotent recovery.
- Need real platform writer exclusion, live disposable three-ref acceptance with no force-push/delete and installed two-device Obsidian acceptance.
- No native OS helper or GitHub Actions promotion, no local cutover, Vault/settings/secret writes, no release.

Do not interpret D143's second Backup GET as a permanent lock on GitHub refs. Keep the Wizard Preview-only and release gate blocked until separate actual cutover criteria are proven. **Final validation:** focused D83+D137+D138+D143 **30/30**, full Fast **1037/1037**, isolated ten-round `pnpm test:repeat` **10 × 1037/1037 PASS (exit 0, zero failures)**, Recovery **88/88**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, E2E compile-only three bundles, metadata/package validators and SHA-matched crypto soak of 100,000,000 bytes PASS. An earlier parallel repeat run encountered Windows Node test-runner `spawn UNKNOWN` when other suites ran concurrently; it was not treated as a code regression or a pass. Test result and commit identity are recorded in `HANDOFF-NEXT-SESSION.md`.
