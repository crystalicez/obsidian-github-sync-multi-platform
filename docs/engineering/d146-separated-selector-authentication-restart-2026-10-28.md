# D146 — Authenticated isolated Option A selector test vector and restart readback

Date: 2026-10-28. The owner approved **A**, preserving the immutable Source Index and independent Shadow Index. The Re-encryption Wizard and release gate remain **blocked**. This is a prototype and non-authorizing readback, **not** a durable selector implementation.

## What this stage proves

`src/lib/v4/reencryption-separated-selector-prototype.ts` uses the existing D142 validated 14-field migration identity and exact authenticated WAL predicate. It creates only an **in-memory** bounded AES-GCM test vector for a distinct Selector root from D145. A domain-separated HMAC key derived from the V4 journal key and identity-scoped AAD prevent acceptance as the D142 hypothetical marker. The canonical payload fixes the selector to `destination-selector-test-vector-uncommitted`. The reader authenticates and rechecks the exact payload after a restart. It never writes files itself.

The read-only reader checks the Selector, unmodified original Source Index, separate Destination Shadow Index, new Destination Settings, presence of both old and new SecretStorage values and the authenticated prepared WAL. These are read twice under a caller-supplied exclusive lease with callback and identity pinning. It detects changed Index, Settings, WAL, key, callbacks, missing secrets, wrong branches/commits, torn or substituted Selector, and double or skipped lease-holder invocation. An independent Windows disposable directory test writes two Index roots and the test vector, reopens them through a read-only adapter and verifies missing-secret and torn-selector rejection. The source and shadow files are unchanged by every reader.

The positive observation `authenticated-selector-with-both-indices-uncommitted` is **not** a committed transaction. All outcomes hardcode `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, and `oldPassphraseCleanupAuthorized:false`. Authentication here means integrity under a supplied journal key; a caller can supply forged key or in-memory WAL proof. This helper is not wired into the normal Wizard or Sync path.

## Still required for real cutover

This module does not implement an authoritative persistent Selector writer, atomic transition, idempotent committed WAL receipt, rollback authority or cross-store Settings and SecretStorage reconciliation. The D142 identity alone is not a physical GitHub repository ID attestation or an installed-device proof. Directory fsync on Windows has shown EPERM with Node-only; physical power-loss persistence and real Obsidian Settings/SecretStorage semantics remain unqualified across Windows, macOS, Linux, Android and iOS. A readback after ordinary restart does not prove power-loss survival. The caller's `assertCrashDurable` and lease callbacks must not be mistaken for independent physical attestation or cross-process exclusion.

Next verify a **small independently crash-durable selector transaction** with a verifiable monotonic generation bound to exact WAL, Git physical repository ID and remote evidence. The transition must keep Source and Shadow immutable and reconcile arbitrary partial Settings, Selector and SecretStorage persistence after restart. Only qualified, authenticated evidence may ever enable cutover. Maintain strict Crash-safe requirements, no GitHub Actions or Native Helper rollout without owner approval, no secret deletion, branch rewriting, merge or release.

## D146 verification

Unchanged implementation passed focused **6/6**, full Fast **1054/1054**, isolated Fast repeat **10×1054/1054** (exit 0), Recovery **89/89** including Windows file-reopen, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, compile-only GitHub E2E **3 bundles**, metadata/package validation, and bounded **100,000,000 B** cryptographic soak with exact reference SHA-256 equality. No live remote mutation, Obsidian cutover or physical power-loss qualification.
