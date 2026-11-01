# D227. Authenticate a pending Cutover intent without selecting the runtime

Date: 2026-11-02. Scope: an additional encrypted intent artifact inside D223's isolated production-namespace Candidate root. **This is not an authoritative committed Cutover**. The installed Wizard remains Preview-only and `docs/release-gates/reencryption-wizard.json` remains blocked.

## Why the D224 Candidate is insufficient

D224 independently authenticates the complete old-key frozen Backup and new-key Destination Git contents around an isolated encrypted Candidate pair. The Candidate Receipt and Selector use `candidate-uncommitted` phases. They never establish a subsequent decision to switch to Destination. A future transaction must distinguish a fully staged Candidate from a separate, explicit intent to apply it, including across interrupted writes and restarts.

## Format and storage

`src/lib/v4/reencryption-cutover-intent-crypto.ts` derives a new HMAC-SHA-256 AES-GCM key from the held journal key using `v4-rekey-cutover-intent-pending-v1`. This namespace differs from D182 test vectors and D223 Receipt/Selector Candidate records. The bounded canonical plaintext contains the exact D183 snapshot contract and the SHA-256 of **both actual encrypted Candidate ciphertext strings**, not merely their plaintext contracts. The fixed phase is `cutover-intent-pending-uncommitted`. Any forged `committed` phase, foreign key, modified contract, torn Candidate, malformed base64, missing bytes, or mixed ciphertext pair fails authentication.

The only new disk path is `<indexRoot>-rekey-cutover-candidate-<runId>/intent.json`. D227 never writes the actual runtime Source Index root, Shadow Index, live Selector, plugin Settings, SecretStorage, Git refs, or the Sync Fence. Its adapter-backed writer refuses a preexisting intent file, authenticates the stored Manifest and Candidate pair, checks the held WAL lease and exact Sync Fence, writes only one additional encrypted artifact, then authenticates readback and rechecks Candidate bytes. Ambiguous writes leave all files intact for Manual Recovery. No automatic retry or overwrite is permitted.

## Independent source and destination evidence

`stageV4FencedLiveReencryptionIntent` uses the **same D224 outer initiating-device owner lease**. The first independent D216 frozen old-key Backup proof and D183 new-key Destination, Source, WAL and Settings proof finish before Candidate and Intent writes. The second full D216/D183 proof runs after both files have been staged. A remote Git reader method change, Backup or Destination HEAD drift, missing old or new key, lost WAL generation, or cancellation makes the entire attempted operation fail closed. `stageV4FencedLiveReencryptionCandidate` still exposes its original D224 Candidate-only path and report without writing an intent.

After a simulated restart, `inspectV4ReencryptionPendingCutoverIntentAfterRestart` reconstructs the contract from the on-disk Manifest. Under one lease it independently reads all four artifacts twice, authenticates the actual Candidate pair and pending Intent, checks pinned WAL generation, exact Sync Fence, original Source Settings and both keys, and performs a final readback. It does not trust a caller-supplied historical digest contract. A positive observation means only that the **historical local pending Intent** authenticates, not that current remote Git content still matches or a Cutover has committed.

## Safety and release limits

All successful and failed reports keep `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` equal to `false`. The old independently writable Source, frozen Backup, orphan Destination, original and new passphrases, and all Git history must remain available.

D227 still lacks a committed Receipt/Selector with active Source-to-Destination selection, a restart-safe atomic Settings/Index/SecretStorage transition, an independent stale-client cutover protocol, physical power-loss guarantees, external OS writer fencing, and installed Desktop/Android/iOS acceptance. This stage adds authenticatable evidence but never upgrades it into authority. Keep six release checks pending, and do not turn on Wizard Run or issue a public release.
