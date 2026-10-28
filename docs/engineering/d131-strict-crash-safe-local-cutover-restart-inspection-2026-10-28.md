# D131 — Strict crash-safe policy and a read-only local cutover restart inspector

Date: 2026-10-28. **Cross-platform pure TypeScript / no Native Helper / no runtime cutover activation. Production release remains BLOCKED.**

## New owner decision

The owner explicitly chose **A: strictly crash-safe Re-encryption** while prioritizing identical behavior across Windows/macOS/Linux/Android/iOS and avoiding OS-native helpers unless proven necessary. This reinforces D130's common best-effort Vault change *detection* (an accepted inability to exclude non-cooperating external file writers), but must NOT conflate it with the durability of local Branch/Passphrase/Local Index changes.

- **Best-effort file-change detection** is acceptable with visible residual-risk disclosure, immutable old Source and frozen Backup, no silent omission, and fail-closed checks on detected drift.
- **Best-effort power-loss persistence is NOT accepted.** WAL and local cutover must survive interruption/restart with exact evidence or refuse automatic continuation. Windows Node-only directory `fsync EPERM` remains a separate unresolved requirement. Do not interpret successful process-crash tests as hardware power-loss evidence.
- Keep exactly three branches in one physical GitHub repository, one user confirmation before execution, automatic **initiating-device-only** finish *when* independently verified crash-safe completion is proven, and manual/optional cutover for other devices.

## Why local cutover needs its own transaction

The current plugin persists a **sanitized settings record** through Obsidian `saveData()` and uses immutable SecretStorage IDs for changed credentials (`src/main.ts`). The V4 Local Index is a **separate sharded adapter data structure** (`src/lib/v4/local-index.ts`). Saving new settings and writing a new index sequentially does NOT grant atomicity across the two storage surfaces, and the storage backend for SecretStorage may have independent persistence ordering. A settings-file readback after rejected `saveData()` is useful for one record but does not establish an atomic three-resource migration. Conversely an invalid index loader result cannot be auto-repaired during an incomplete cutover without a separately durable recovery policy.

A cross-platform durable cutover will need a separately authenticated **nonsecret intent / phase marker** and a tested platform persistence contract, retained old/new secret IDs, pinned Destination commit identity, exact index/settings readback, and deterministic restart resolution. The ordering of index preparation, settings switch and compensation is an architectural design decision; do NOT choose an implementation that can erase the last working credentials, automatically re-run ambiguous Git mutations, or replace source notes before proving safety. In particular, do not include plaintext passphrases in a WAL, log, UI report, or test report.

## D131 safe implemented increment

New `src/lib/v4/reencryption-local-cutover-inspection.ts` implements **read-only inspection of a possibly interrupted local cutover**, independent of OS/Node APIs:

- Input is a copied, separately verified, **nonsecret** expected Source and Destination repo IDs (same physical owner/repo, different branches), exact Destination commit SHA, old/new distinct passphrase **Secret IDs**, and initiating device ID. No plaintext passphrase is an input.
- Load the actual sharded local index through existing `loadV4LocalIndex()` (including its per-shard SHA-256 content digest and size checks; these digests are not secret-key authentication), compare the index repo/mode/path layout/device and new Destination pinned commit with currently observed settings. A supplied SecretStorage read-only getter checks presence only; the secret value is never returned or logged.
- Return exactly `source-observed`, `destination-observed-unconfirmed`, or `mixed-or-unverifiable`. Missing keys, wrong commit, corrupted index, inconsistent branch or Secret ID, stale settings mutation and undecidable contents fail closed. A changed settings object during async index load or during the secret getter is rejected on return.
- **Every outcome returns** `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`. In particular `destination-observed-unconfirmed` is NOT proof of a committed durable migration, and `source-observed` does NOT authorize resuming Sync while an unresolved migration WAL may exist.
- No write APIs, no vault filesystem activity, no network operation, no branch deletion, no cleanup/repair, no re-encryption execution and **no wiring into the active runtime**. This is a reusable observation primitive that must later be combined with real WAL and durable settings/index/secret-storage receipts before deciding a replay.

## RED→GREEN / fault injection

New `tests/v4/reencryption-local-cutover-inspection.test.ts` exercises:
1. Correct Source and Destination settings+Secret IDs+indexed repo/commit readback, no writes or secret disclosure, and no implicit authorization even when all individual values appear correct.
2. Eight old/new settings/secret/index cross-combinations and fail-closed rejection of every mixed tuple.
3. Missing Destination Secret, unexpected pinned Destination commit, and malformed persisted index.
4. Settings mutation during asynchronous index reads.
5. Settings mutation triggered by the synchronous SecretStorage getter — **RED before second live-settings check**, GREEN after.
6. Invalid cross-repository refs, reused Secret ID, malformed commit and missing device rejected before reading disk.
7. Injected disk I/O failure rejects rather than silently assuming either side is safe.

The baseline focused test before creating the inspector failed because the module was absent; with initial implementation, secret-getter mutation exposed a **real false-positive `destination-observed-unconfirmed` return**. After a second live settings comparison, all targeted assertions pass. Tests do not prove a real durable local-cutover transaction: that is the next substantial feature, not a hidden claim of this stage.

## Remaining gates

Strict cross-platform cutover transaction and its interrupt/restart authentication, Windows Node-only WAL `fsync EPERM` power-loss durability, correct SecretStorage retention/rekey provenance, full destination ref/ciphertext verification, Wizard execution integration, numeric-pinned same-repository live GitHub three-ref qualification, and installed two-device desktop + mobile tests remain pending. Keep `docs/release-gates/reencryption-wizard.json` `status:'blocked'`. No GitHub Actions, native helper promotion, user Vault mutation or live remote writes.
