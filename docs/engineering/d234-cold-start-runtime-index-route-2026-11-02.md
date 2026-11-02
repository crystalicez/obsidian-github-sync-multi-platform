# D234 — Cold-start Runtime Index routing discovery and sticky Sync blocker

Date: 2026-11-02. **Release remains blocked. Wizard Run remains Preview-only.**

## Problem

D233 can persist Obsidian's destination Git branch and passphrase SecretStorage ID, but V4 Runtime still loads and saves only `github-sync-v4-index` (the old Source cache). The original Re-encryption Sync Fence safely blocks writes during Cutover. If that single fence directory is accidentally removed, ordinary Sync could interpret destination Settings against the old Source Index root and create a fresh cache there. Furthermore, a restarted plugin must discover the target Shadow Index root without retaining an initiating-device JS object graph.

## Persistence and failure boundary

D234 adds a *fixed-path*, never-overwritten routing **intent**, `github-sync-v4-rekey-runtime-route/intent.json`, before D233's native `saveData()`. It is a separate independently domain-separated HMAC-SHA-256 record (`v4-rekey-runtime-index-route-intent-v1`) keyed with the original migration journal key. It binds the exact D183 Candidate Contract manifest hash, D232 physical Selector ciphertext SHA-256, D233 Settings write-ahead Intent SHA-256, run/source/destination IDs, immutable Source Index root and distinct Destination Shadow Index root. It contains no passphrases, file paths, file content, or GitHub tokens.

Ordering within the one held initiating-device lease:
1. Reverify D230/D231/D232, physical Source/Shadow cache digests and full old-key Frozen Backup and new-key Destination Git ciphertext.
2. Write and read back D233 Settings write-ahead Intent.
3. Require absent routing residue; create the fixed routing-intent directory, write HMAC-bound routing record, read back and authenticate it before touching native plugin Settings.
4. Persist exact native Settings document with only `githubBranch` and `encryptionPassphraseSecretId` modified. Reread native Settings, routing pointer, Selector and full Git proof. No automatic retry after an ambiguous write.

The normal Sync entrypoint and regular Settings writes now require **both** the primary Sync Fence and the D234 route root/file to be absent. This is a **sticky additional blocker**; deleting the primary fence alone can no longer restart Sync when D234 routing evidence survives. A torn route directory or marker is itself sufficient to block Sync, even after a lost or deleted original fence. This is cooperative filesystem best-effort, not an OS-wide lock or real power-loss fsync guarantee.

## Installed Runtime cold-start routing diagnostics

`inspectV4ReencryptionColdStartIndexRoute` starts from the fixed routing marker and native `loadData()`, *without the historical D233 in-memory initiator*. It independently rereads the original Sync Fence marker, bounded Candidate Contract, physical Selector/Receipt, D233 full Settings digest Intent, Source and Shadow Index cache contents and SHA-256, both passphrases' presence (if SecretStorage is supplied), and exact native plugin Settings twice. It also rechecks physical pointers and local files at the end. Optional original journal key verifies both the D234 and D233 HMACs. On ordinary installed startup the key is not yet independently reconstructed; the result is explicitly an **untrusted read-only diagnostic**, never a completed Cutover or an excuse to clear the fence.

`V4PluginRuntime.inspectFencedReencryptionIndexRoute()` runs on plugin startup. When a partial or target-Settings routing artifact exists, the plugin warns that Sync remains paused and Manual Recovery is necessary. `V4PluginRuntime.readFencedReencryptionDestinationIndexForRecovery()` can load the actual Shadow root using two matching on-disk observations, solely for **read-only diagnostics**; it does not change the active Sync cache root, write Index, clear Fence, select new keys for a Sync writer, or authorize rollback.

All cold-start report shapes set `commitDecisionAuthorized=false`, `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false`, `oldPassphraseCleanupAuthorized=false`. Even a correctly MAC-authenticated route is not a full current remote Git verification and cannot unlock Sync.

| Crash / tamper window | Expected behavior |
|---|---|
| Re-encryption fenced, D234 route not yet written | Report pre-route fence; Sync stays blocked |
| D233 Intent written but route mkdir/write interrupted | No native Settings write; partial routing marker kept, Sync blocked; Manual Recovery |
| Route written but native `saveData()` rejects before write | Old Source native Settings; retain both Secrets and all evidence; Manual Recovery |
| Native `saveData()` commits before rejecting | New Destination native Settings; read-only local diagnosis; still no Sync |
| Route/Selector/contract/Settings Intent/Index changed or key missing | Manual Recovery; no Index writes |
| Main Sync Fence directory accidentally removed while route persists | D234 route root independently blocks Sync |
| Route HMAC authentic but no current Git/WAL/stale-device approval | No Sync authority, no cleanup |

## Verified offline gates

- D234 targeted integration **5/5 PASS**, Full Fast **1,384/1,384 PASS** (zero failures), production `pnpm build` and `pnpm typecheck:max-strict` PASS.
- Recovery **93/93**, Feasibility **136/136**, Resource **11/11**. GitHub E2E **three compile-only** bundles, no live credentialed GitHub calls.
- `pnpm validate:metadata`, `pnpm validate:package` PASS. Cryptographic soak **100,000,000 bytes 1/1 PASS**, SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` matches reference. Existing 8 MiB chunk policy unchanged.

## Tests and limits

Five new D234 integration tests use real AES-GCM git-fixture migration evidence: cold-restarted file adapter route, actual V4 Runtime diagnostic Shadow read, torn route write, original fence deletion, and adversarial marker/contract/Selector/Settings/Index/SecretStorage mutation. Existing D233/D232 integration cases continue to test the complete Settings and Selector transitions.

**Not implemented:** authorizing the active mutable Sync Index root to become Destination after a fully committed Cutover. The Runtime writer remains on the original Source root and is blocked by the two independent fences; this is deliberate. Before release, a future D235 stage must reconstruct trusted journal key and current Git/WAL proof independently at cold start, prove a committed Settings/Index transaction across crash windows, safely transition active Runtime writers, define stale-client safety and carefully justify any fence clearance. This stage does not authorize live test-vault Git writes, GitHub Actions, Native Helper, branch deletion, or public release.
