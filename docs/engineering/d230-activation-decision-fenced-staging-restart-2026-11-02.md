# D230 — Encrypted activation decision with fenced staging and Restart inspection

Date: 2026-11-02. **Release blocked. Wizard Run remains Preview-only.**

## Why

D229 can verify the current old-key frozen Backup, new-key Destination Git content, and D228 persisted local Source/Shadow/Settings/WAL/Intent under one cooperative Owner Lease. The result is ephemeral and cannot be replayed as an authoritative persisted decision after Restart.

D230 adds a distinct cryptographically authenticated decision record. It captures a decision to begin a future activation; it **does not** mean that the plugin has activated the Destination or that Sync may resume.

## Wire format

`src/lib/v4/reencryption-activation-decision-crypto.ts` writes a canonical AES-GCM encrypted payload with phase `cutover-decision-recorded-activation-not-applied`. Its key comes from a domain-separated HMAC of the already authenticated journal key (`v4-rekey-cutover-activation-decision-v1`); AAD binds transaction ID, run ID, both repository IDs and both commit SHAs. The payload carries the exact six-digest Cutover contract, SHA-256 of the persisted canonical Candidate manifest and SHA-256 of the exact pending Intent ciphertext. The original Intent independently binds the Candidate Receipt and Selector ciphertext. All layers must authenticate together. Forged phase, truncated ciphertext, wrong key, foreign manifest/Intent, changed contract or swapped Candidate pair fail closed. The encrypted record contains no passphrases.

One new artifact is written: `<indexRoot>-rekey-cutover-candidate-<runId>/activation-decision.json`. It does not replace Candidate `receipt.json`, `selector.json` or `intent.json`. It is never placed at the active runtime Selector path.

## Stage and Restart

`stageV4FencedCutoverActivationDecision` first acquires one initiating-device Owner Lease and rejects any pre-existing decision residue. D229 preflight is run **inside a borrowed lease**, verifying the full old-key frozen Backup, new-key Destination and persisted local Candidate/Intent/Settings/Indexes/WAL/Fence. After all four Candidate sources are independently reread and authenticated, the stage seals and writes only the decision ciphertext. It verifies exact readback and repeats the **whole D229 preflight after the write**, followed by an independent final read. A moved Git HEAD, WAL/Fence loss, partial write, changed key or competing writer rejects the stage. An ambiguous write leaves the bytes in place and a second attempt never overwrites them.

`inspectV4FencedCutoverActivationDecisionAfterRestart` requires a fresh owner lease, independently rereads and authenticates the decision with its four local source artifacts, repeats the complete live Git and local D229 proof, and rereads the exact decision a final time. It is **read-only**. A valid record reports `authenticated-decision-activation-pending`; otherwise `manual-recovery-required`. Both carry `commitDecisionAuthorized=false`, `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false` and `oldPassphraseCleanupAuthorized=false`.

A successful report is a *best-effort cryptographic readback*, not an OS flush guarantee, cross-process atomicity, or proof of a finished local activation. The Source stays active. The old Source branch stays independently writable, the frozen Backup stays pinned, the Destination stays orphaned, both passphrases are retained, and Git history is untouched.

## Next release blockers

A real committed activation still needs an independently recoverable active Selector/Index/Settings/SecretStorage transaction, persisted phases for crashes at every write boundary, conflict behavior for stale clients and a safe startup recovery path. Only after this and installed Obsidian Desktop/Android/iOS acceptance can the six pending release checks be reviewed. No GitHub Actions, Native Helper, live test-vault mutations, branch deletes, force push, merge or public release.
