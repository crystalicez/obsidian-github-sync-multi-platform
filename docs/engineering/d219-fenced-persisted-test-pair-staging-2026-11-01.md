# D219 — Non-authorizing persistent Receipt/Selector test-pair staging and crash windows

Date: 2026-11-01. Status: **internal adapter-backed staging**, not installed Wizard Run and **not a committed migration transaction**. First-public-release Re-encryption remains `blocked`.

## Release gap and scope

D182 constructs AES-GCM/HMAC-domain-separated Receipt and Selector **test vectors** only in memory. D183 separately attests the test contract's six SHA-256 digests against a fresh encrypted Source/Shadow/Prepared/WAL/Settings and full verified Git Destination; D184 can inspect a historical pair written to disk after restart, but until D219 there was **no production-module writer** exercising its actual directory/write/crash boundaries.

D219 adds `stageV4FencedCommitPairTestArtifacts` in `src/lib/v4/reencryption-fenced-persisted-test-pair.ts`. The function writes through an explicitly supplied local storage adapter, **not** to GitHub, active Source Index, Shadow Index, Settings or SecretStorage. It is available only to deliberate internal callers; the installed Wizard is unchanged. The output contains file paths and `linked-persistent-test-artifacts-uncommitted`, *never* "committed" or permission to operate.

## Ordering and checks

One external initiating-device holder encloses the entire transition. Nested D183 and D184 checks borrow that already-held lease; none reacquires an OS lock. Before writing, the function:

1. Requires the exact D142 three-branch migration identity, both original/new SecretStorage passphrases and 32-byte WAL journal key, D173 byte-exact active Sync Fence, authenticated best-effort WAL generation and independent old-Source/new-Destination Git content proof.
2. Derives a fresh D183 contract from authenticated live and local evidence, seals the two D182 AES-GCM test records under domain-separated keys, and recomputes the full D183 proof against the resulting pair. An old contract supplied by a caller is **not** trusted as a staging precondition.
3. Refuses any existing proposed Receipt directory/marker or Selector, never overwrites nor silently resumes a partially failed earlier attempt. Pins adapter, Git reader methods, migration run/remote config/receipts, identities, secrets and WAL callbacks across asynchronous boundaries.
4. Creates the separate proposed Receipt directory, writes encrypted `marker.json`, checks the WAL/lease/fence, then reads the exact bytes back. Next, and only after successful Receipt readback, writes encrypted `selector.json` in the already-prepared separate selector root.
5. Reads back **both** persisted records, authenticates the ciphertext-linked pair, and invokes the D184 restart observer. D184 must return `artifactWindow: pair-present`, `pairEvidence: cryptographically-linked-uncommitted`, and `reason: linked-test-pair-not-authoritative`. If any proof fails, refuse success and **preserve all existing bytes** for Manual Recovery.

If interrupted after `mkdir`, after Receipt write or after Selector write, residue is not cleaned or retried. Normal V4 Sync remains blocked by the persistent Sync Fence, including when the fence is damaged. A successful test pair remains **non-authorizing**: `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` are all fixed `false`.

## Proof

The D219 regression cases in `tests/v4/reencryption-destination-exact-commit.test.ts` use the existing real AES-GCM encrypted Source/Shadow/Destination fixture and a deterministic in-memory adapter with injected interruption. They exercise real production D183 derivation, D182 encryption and D184 readback rather than manually constructing staged bytes.

Cases cover successful full two-record staging under one holder; unchanged Source/Shadow indices, live Settings/SecretStorage, WAL and Sync Fence; second attempt refusing to overwrite; interruption after directory creation (`receipt-directory-only`), after Receipt (`receipt-only`), after Selector (`pair-present` but still uncommitted); WAL tampered after Receipt (Selector forbidden); corrupted Receipt readback; foreign residue refusal; **AbortSignal cancelled after writing Receipt (Selector forbidden, partial evidence preserved)**; and Git read-method replacement by the external holder after staging. All failures block Cutover and Sync Resume, preserve evidence and release the cooperative lease. A restart simulation reopens the logical pair through D184, which still reports Manual Recovery.

**Limits:** These tests do not establish actual filesystem crash durability, atomic writes across independent directories, mobile adapter semantics, resistance to noncooperating OS or Git writers, GitHub API E2E, Android/iOS/Desktop Obsidian acceptance, or protection from real power loss. The individual `adapter.write` calls may be interrupted; even two successful readbacks are best-effort, never fsync proof. D219 is a **test-artifact writer**, not a durable/authoritative production Receipt, Selector or commit point. It does not wire Wizard Run or modify any release gate.

## Still needed for Release

Specify and implement the **authoritative committed** Receipt+Selector format/transaction with independently observable best-effort checkpoints and explicit Manual Recovery. Prove restart-safe ordering for Branch/Passphrase/active Index, correct behavior of old Sync clients, post-crash manual recovery without data loss, and installed Desktop/Mobile acceptance with real Obsidian. Preserve the old Source, pinned Backup, encrypted orphan Destination, Git history and old passphrase. Do not introduce Native Helpers, GitHub Actions, force pushes, automatic branch deletion or real user-vault migration as part of D219.
