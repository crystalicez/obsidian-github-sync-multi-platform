# D232 — First physical Cutover Selector write (Settings not yet activated)

Date: 2026-11-02. **Release blocked, Wizard Run remains Preview-only.**

## Engineering choice

D231 produced an AES-GCM authenticated six-field Settings Switch Plan, but it never changed a physical selection artifact. D232 makes the first actual two-write transition to the established separated-Selector path without touching the Source Index, Shadow Index, Obsidian Settings, SecretStorage, WAL, Git refs or the persistent Sync Fence. The existing runtime still loads its fixed original Source Index. This phase is **not a completed cutover** or permission to Sync, delete keys, or roll back.

The ordering is fixed: **authenticate D231 and the complete D229 old/new Git and local proof; write an authenticated Receipt; repeat complete D229 proof; write the actual Selector as the final write**. D229 intentionally fails if a real Selector appears, so it is not safe to rerun D229 once the Selector is written. After that final write, D232 performs source/shadow D183 digest checks, old persisted Settings, SecretStorage presence, WAL, physical Sync Fence and cheap fresh Backup/Destination Git HEAD checks, but it does **not** claim a complete second Git-content proof after Selector. A ref moving after the final write rejects the stage and retains both artifacts for Manual Recovery. Noncooperating processes or physical power loss are not OS-atomically fenced.

## Artifacts and crypto binding

- `<indexRoot>-rekey-cutover-candidate-<runId>/selector-commit-receipt.json`: AES-GCM `selector-commit-receipt-settings-pending` with unique HMAC key context `v4-rekey-selector-commit-receipt-v1`, D183 transaction ID and all six digests, SHA-256 of exact D231 encrypted plan and both immutable Index roots.
- `<indexRoot>-rekey-selector-<runId>/selector.json`: **real separated Selector path** (not a Candidate Selector) with AES-GCM `destination-selector-written-settings-pending` using distinct domain `v4-rekey-selector-write-v1`. It binds the D183 contract, Destination Shadow Index root and SHA-256 of the exact committed Receipt ciphertext.
- The Receipt is independently bound, via D231, to D230 Decision → D227 Intent → D223 Candidate pair → persisted Source/Shadow/Settings/WAL → current old-key Backup and new-key Destination Git proof at writing time. The Selector and Receipt never contain secret plaintext.

`src/lib/v4/reencryption-active-selector-commit-crypto.ts` seals/authenticates distinct Receipt/Selector records. `src/lib/v4/reencryption-active-selector-commit-stage.ts` owns the **one held initiating-device Owner Lease** for writing and read-only restart inspection. All result shapes explicitly have `commitDecisionAuthorized=false`, `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false`, `oldPassphraseCleanupAuthorized=false`.

## Failure matrix

| Window | Expected behavior |
|---|---|
| Before Receipt | No new artifacts, no runtime changes |
| Receipt write interrupted or Receipt-only | Keep Receipt bytes, never retry over them, Manual Recovery |
| Receipt saved, complete remote proof fails | Receipt-only residue, no Selector write, Manual Recovery |
| Selector write interrupted | Receipt plus partial Selector; read-only Restart refuses authentication |
| Both bytes valid, Source settings/Index or Shadow drifts | No Resume Sync; Manual Recovery |
| Both bytes valid, current frozen Backup/Destination HEAD drifts | No Resume Sync; Manual Recovery |
| Both bytes valid, keys/WAL/Fence lost | No Resume Sync; Manual Recovery |
| Linked pair survives Restart and current local + HEAD checks | `authenticated-selector-settings-pending`, still no Commit/Sync authorization |

The old Source branch remains independently writable. A valid local pair is *not* a cross-device or full-Git-current commitment. A Sync process ignoring the plugin's cooperative fence cannot be ruled out. D232 never removes or relaxes the startup fence. All writes are best-effort local adapter writes, not atomic OS flushes.

## Required follow-up before release

D233 must implement an **actual durable Settings/SecretStorage transaction and runtime Index routing**, separately verify post-selector current frozen Backup and new Destination Git content without incorrectly relying on pre-selector D229, restore/correctly classify crashes at each persisted write, and keep the Sync Fence until the entire Cutover is demonstrably coherent. Do not reuse ordinary `saveSettings()` because it can scrub the old Secret. Preserve unrelated Settings and both passphrases. Then verify stale clients / multi-device policy and installed Obsidian Desktop/Android/iOS acceptance. No GitHub Actions, Native Helper, live vault writes, merges, force push, branch deletion or public release.
