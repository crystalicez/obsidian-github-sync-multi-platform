# D247 — One-owner read-only old Backup + encrypted WAL + complete Destination verification

Date: 2026-11-03. Owner choice **B** remains in force: first stable release must include a fully qualified Re-encryption Wizard; the six acceptance gates remain **pending**.

## Why

D236 independently rederives and authenticates the old journal key against a pinned full encrypted Frozen Backup and an HMAC-bound persisted local routing contract. D239 independently authenticates adjacent AES-GCM WAL slots, their receipts and complete new-key Destination Git/Shadow content under a recovery lease. Neither report alone proves the other surface. A stale or relocated journal key, forged local manifest, changed Backup ref, or revoked lease during remote verification must never promote Re-encryption to a completed, writable state.

## Change

`src/lib/v4/reencryption-cold-start-complete-recovery.ts` exports `inspectV4ColdStartCompleteRecovery`, a strictly read-only three-surface orchestrator:

1. Require one shared, live plugin owner callback for Backup, WAL and Destination, **the same Index adapter** for D236 and D239, **the same SecretStorage reader**, a valid saved contract, a 32-byte original journal key and a caller-provided **one exclusive recovery lease**. Pin contract serialization, key bytes, adapters/method identities, Git branch/method identities, checkpoint and holder callbacks across all awaits.
2. Enter that one caller-held lease, verify the old frozen Backup's physical repository ID matches the proposed Destination's physical repository, and run the full two-pass D236 old-key/Backup proof **binding the exact same contract and key supplied to WAL/Destination**. D236 also authenticates the persisted D234 route and D223 manifest, actual native Settings and both encrypted passphrases. A missing/mismatched key or contract returns `manual-recovery-required`.
3. Without releasing or reacquiring the outer lease, run D239's independent encrypted WAL adjacency/receipt validation, two full new-key Destination Git/Shadow reads and exact Sync Fence readback. The inner D239 lease callback only asserts the existing outer lease, never creates a second independent lease.
4. Re-run the **entire** D236 frozen old Backup/key proof after Destination verification, recheck local owner/inputs, checkpoint and the exact physical Backup identity. A source ref or client-method drift during new-key readback invalidates the whole report.
5. Return only a frozen, nonsecret diagnostic report. `commitDecisionAuthorized`, `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized`, and `oldPassphraseCleanupAuthorized` are always `false`; `powerLossDurabilityProven` is always `false`. Failure never repairs, retries a write, deletes a passphrase or changes Git.

The module does **not** infer a valid exclusive recovery lease from arbitrary callbacks. A trusted installed Obsidian caller must still provide the actual platform-appropriate single-owner protection. A receipt that passes a simulated holder is **not** proof of OS-wide exclusion. The original source and frozen Backup are not released from their fence. No automatic recovery/rollback or user-visible Write/Run/Cutover flow is installed.

## Verification

`tests/v4/reencryption-destination-exact-commit.test.ts` adds a genuine cross-surface fixture: real PBKDF2-derived original journal key, D235 persisted native Settings + authenticated original Backup and D234 route/manifest, a real AES-GCM encrypted adjacent WAL pair that matches the existing saved contract, and existing D238 full new-key Git content and Shadow readbacks. Both old Backup scans are actually repeated. The test checks one outer lease, zero Index/WAL mutations, unchanged original secrets and all authority flags `false`. Additional cases intentionally break common owner, Index and SecretStorage identity, original key, WAL ciphertext, frozen Backup ref or Backup Git client method during Destination scan, and revoke the lease during a remote ciphertext read.

A second test copies the exact same persisted old Index to disposable Windows files and the two ciphertext WAL slots to a real D164 Desktop WAL directory. It releases the writer, reopens through D241 existing-only OS-exclusive Recovery and runs the **same** D247 proof with an actual lock-checked read-only adapter. WAL/Index bytes are compared before and after. This does not prove fsync/power-cut durability and is not an installed Obsidian UI acceptance run.

## Remaining before release

The current installed Wizard still exposes Preview-only. D247 is an internal read-only verifier, not an active cross-platform migration coordinator or a Cutover decision. Connect this proof to the real trusted plugin/vault owner and D242/D241 platform WAL location; demonstrate that no stale other device can continue old-key Sync after choosing Re-encryption, complete the create-only orphan destination migration and safe local Settings/Index Cutover, and pass installed Obsidian Windows/macOS/Linux/Android/iOS acceptance with documented best-effort Mobile and Manual Recovery. The six existing release checks remain pending and the owner-approved first-Release choice B still blocks a Sync-only release.
