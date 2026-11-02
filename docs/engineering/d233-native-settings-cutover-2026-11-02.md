# D233 — Fenced native persisted Settings transition after physical Selector

Date: 2026-11-02. **Re-encryption Wizard Run remains Preview-only; first-public-release gate remains blocked.**

## Reason this stage exists

D232 physically wrote a linked authenticated Destination Selector and Commit Receipt but left Obsidian `data.json` on the old Source branch. The plugin's ordinary `saveSettings()` cannot be reused to persist the new branch because it may clear the old passphrase from SecretStorage after the save. Its behaviour is correct for an ordinary edit but unsafe for a reversible, best-effort re-encryption transaction.

D233 introduces an **actual native `Plugin.saveData()` write**, under the existing cooperative initiating-device Owner Lease and existing physical Sync Fence. The write changes **only** `githubBranch` and `encryptionPassphraseSecretId` inside the existing full wrapped plugin settings document, retaining all unrelated user preferences, the existing GitHub token ID, both old/new SecretStorage values, Source/Shadow Index roots, pinned Backup, orphan Destination and Git history. It explicitly does not clear the Fence or authorize Sync, key removal or automatic rollback. Runtime Index routing is **not** implemented yet; existing Sync would still select the fixed Source root, so leaving the Fence armed is mandatory.

## Implementation

- `src/lib/v4/reencryption-persisted-settings-cutover.ts`: `persistV4FencedDestinationSettings(input)`, `inspectV4FencedDestinationSettingsAfterRestart(input)`.
- `src/main.ts`: `persistFencedReencryptionDestinationSettings(input)` supplies the **native** `loadData()` / `saveData()` callbacks from the active plugin, pins the live plugin instance and vault adapter, and uses the same `settingsSaveInProgress` guard as normal Settings edits. This method is deliberately **not** exposed through the Wizard until Runtime routing/restart safety has been verified.
- The migration's original six-field Source projection must match the *actual* persisted document and independently authenticated D183+D230+D231 contract, not just an in-memory draft. It also reauthenticates the D232 physical Selector and Commit Receipt, WAL, Source/Shadow content digest, both keys and Sync Fence.
- Full post-Selector Git verification is now **independent of D229**: it re-decrypts the current frozen old-key Backup using D216 and the complete new-key Destination Git tree and file ciphertext using D137. D229 intentionally fails once a physical Selector exists; that failure must never be bypassed as though D229 still covered the post-Selector window. D233 rechecks both remote objects before the new Settings write and after saving, plus the physical Selector/Receipt and exact Settings readback. These are best-effort live observations, not OS-level atomicity or power-loss durability guarantees.
- The new non-secret forensic artifact `<indexRoot>-rekey-cutover-candidate-<runId>/persisted-settings-write-intent.json` is written **before** native Settings. It stores SHA-256 of the *entire* exact previous and target wrapped Settings records, SHA-256 of D232 Receipt/Selector ciphertexts, transaction ID and a keyed HMAC-SHA-256 with separate context `v4-rekey-plugin-settings-write-intent-v1`. No plaintext passphrases, GitHub tokens or file content are written. It is never overwritten by an automatic retry.
- An ambiguous `saveData()` rejection is **never retried or rolled back automatically**: the native file may have been completely written even though the Promise rejected. The Intent, Selector, both SecretStorage values and both Indexes are kept for Manual Recovery. Native `plugin.settings` remains pinned until a future fully authenticated activation; the on-disk state is deliberately **not yet authorized** as a functioning new Sync configuration.

## Focused regression reproduction

For the five encrypted Git fixture cases, use `node scripts/run-tests.mjs --tier=fast --filter=reencryption-destination-exact-commit --name-pattern=D233`. The optional `--name-pattern` is passed to Node's test-name filtering. Omitting it keeps the existing full-tier behavior unchanged.

## Crash-window and restart classifier

| Read-only observation | Meaning | Permissions |
|---|---|---|
| Intent missing | D233 not applied or startup evidence missing | All false; Manual Recovery |
| Authenticated Intent + exact old Source document | Settings write not applied, or failed before disk commit | All false; Manual Recovery; preserve evidence |
| Authenticated Intent + exact target Destination document | Settings saved and independently reverified | All false; no Sync |
| Intent/Selector MAC mismatch, changed preference, partial file, missing old/new secret, damaged Index/WAL/Fence, moved or corrupted Git Backup/Destination | Foreign or ambiguous | All false; Manual Recovery |

`inspectV4FencedDestinationSettingsAfterRestart` is read-only and compares the full Settings document hash against the HMAC-authenticated write-ahead Intent; it independently authenticates the D230/D231/D232 cryptographic chain and checks Source/Shadow Index hashes. On a matched Destination record it rechecks complete Git content, never just the branch HEAD. Every report has `commitDecisionAuthorized=false`, `localCutoverAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false`, `oldPassphraseCleanupAuthorized=false`.

## Verified offline gates

- Targeted D233 integration suite: 5/5 passing; full Fast: **1,379/1,379 passing**, including all five new D233 and existing D232/D231 regressions. The initial 460-second Full Fast invocation timed out without observed failures; a complete rerun with a 900-second process limit exited 0.
- `pnpm build` and `pnpm typecheck:max-strict`: exit 0.
- Recovery: **93/93**, Feasibility: **136/136**, Resource: **11/11**; GitHub E2E: 3 **compile-only** bundles, no live credentialed tests.
- Metadata and Package validators: exit 0. Bounded cryptographic 100,000,000-byte soak: 1/1, matching SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`.
- No native installed Obsidian acceptance, real power-cut durability verification, external live GitHub test vault write, actual release, or operational active Runtime Index switch is claimed.

## Remaining before release

D234 must route the real Runtime Index loader/writer to the immutable Destination Shadow **only after a verified selector + persisted Settings + complete Git proof**, and implement a restart-capable authenticated reconciliation path whose input can be reconstructed from persistent artifacts on installed Obsidian without prior in-memory initiating-device witnesses. The persistent Sync Fence must not be removed merely because D233 Settings saved successfully; stale-device rejection, complete crash-window behavior, non-atomic filesystem caveats and actual installed Obsidian Desktop/Android/iOS testing remain required. Never reuse ordinary `saveSettings()` for migration, never scrub old passphrase, never add GitHub Actions or Native Helper without user approval.
