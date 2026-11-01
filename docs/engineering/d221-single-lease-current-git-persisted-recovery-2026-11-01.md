# D221 — One-lease current Git and persisted historical test-pair recovery proof

Date: 2026-11-01. Scope: internal **read-only** Re-encryption recovery evidence. The installed Wizard remains Preview-only; the first-public-release Re-encryption gate remains **blocked**.

## Why

D220 can recover a D182 cryptographically linked *historical* Receipt/Selector test pair from its canonical, untrusted `contract.json` on disk after restart, without relying on a surviving D183 in-memory contract. But a historical record alone cannot attest that the actual Backup/Destination Git refs, commit trees and ciphertext are still the originals.

D217, conversely, independently decrypts every current old-key frozen Backup and every current new-key Destination ciphertext under one initiating-device lease, but its D184 local verification historically required a caller-supplied D183 contract.

Neither independent report alone captures the entire recovery situation. D221 joins both witnesses and closes that conceptual gap **without granting authority to change anything**.

## Implementation

New internal module `src/lib/v4/reencryption-fenced-live-persisted-test-pair-recovery.ts` exports `inspectV4FencedLivePersistedTestPairAndBackupAfterRestart`. Its input contains:
- The reconstructed D176 Prepared/WAL/Fence/SecretStorage local reader (no historical D183 contract parameter).
- The D178/D177 full encrypted Destination and three live Git refs reader.
- The D216/D94 full frozen old-key Backup reader.

The inspector requires **the same adapter, WAL/journal, initiating-device lock and exact D142 migration identity** for all three. It pins Settings/Secrets, local WAL and adapter methods, all three branch readers, GitHub data and methods, Backup plan, old/new passphrases and publication identities across asynchronous operations. Source is independently writable under D90/D218, but Backup must remain exactly pinned at the authenticated old-key commit/tree and Destination must remain the new orphan commit/tree.

Under **one single outer holder**, nested inspections exclusively *borrow* that holder:
1. Verify authenticated WAL and exact D173 Sync Fence. Read, bound, canonically parse the persisted **untrusted** `contract.json` and bind it to D142 identity.
2. Call D220 to authenticate that contract against the **actual** encrypted Receipt/Selector, old/new SecretStorage and original Source/Shadow/Prepared/Intent/WAL evidence. Require its nonauthorizing historical linkage.
3. Independently reread the manifest and invoke strict D217, passing the *saved authenticated historical contract* to D184. D217 checks local evidence around **two complete current encrypted Destination Git scans** and **two full original old-key frozen Backup Git scans** inside the already-held lease, checking Git refs, blob SHA, decrypted content SHA, fenced local state and physical repository.
4. Check the historical manifest again, repeat D220 local cryptographic authentication after all remote scans, and finally read and bind manifest/fence once more. Any changed ref, ciphertext, Settings, SecretStorage, WAL/Fence, manifest or API method returns a conservative unknown report. No partial positive witness is reported.

A coherent result has:
- `historicalTestPairCryptographicallyLinked: true`
- `fullDestinationContentReverifiedAfterRestart: true`
- `fullBackupContentReverifiedAfterRestart: true`
- `liveThreeBranchRefsReverifiedAfterRestart: true`
- `observation: manual-recovery-required`
- `reason: test-pair-and-full-remote-coherent-but-not-a-commit`

Critically, `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` remain hardcoded `false` on **both** success and failure reports. It cannot write files, mutate remote Git refs, install a Selector, change Settings/Passphrase/active Index, clear a Sync Fence or resume Sync.

## Behavioral regression evidence

Five D221 cases in `tests/v4/reencryption-destination-exact-commit.test.ts` use existing real AES-GCM D94 frozen Backup/Git Blob and new encrypted Destination fixtures plus adapter-backed D219 test pair persistence:

- Positive historical persisted contract + *current* fully decrypted old/new key branch contents verified under **one, nonreentrant initiating-device holder**; unchanged local files, WAL and SecretStorage.
- Fail-closed matrix: Backup ref moved, damaged Backup ciphertext on the second full pass, Destination ref moved, altered WAL generation, broken Sync Fence, tampered manifest, old key absent or new key changed. Reject all with **no Cutover/Resume/cleanup or writes**.
- Old-key Source independently advanced to a new valid Git SHA/tree; Backup and Destination remain pinned, so read-only composed proof still succeeds without falsely requiring Source frozen. This does **not** prove Source fast-forward ancestry.
- Saved manifest changed from a Git Blob callback **during actual old-key Backup verification**, discovered on later local recheck and rejected.
- GitHub Backup reader method replaced *after the inner held work*, or forged holder that never executes the callback: both reject claimed proof.

Focused test tier passed **80/80**, including all previous D217/D220/D184 tests. Full release checks are logged separately in the persistent handoff. No real GitHub credentials or user vault files were changed.

## Explicit limits and release blockers

All tests remain deterministic, offline fixtures. Local lease is only cooperative; it cannot stop another OS process, old Obsidian client or remote GitHub writer. Multiple successful readbacks are not physical filesystem crash/power-cut durability or proof against Git ref ABA after the last read. This diagnostic does **not** provide a current complete *old Source* plaintext scan or prove that Source HEAD is an ancestor of the pinned original commit; the frozen Backup and orphan Destination are the immutable migration witnesses.

D221 is still not an **authoritative committed Receipt/Selector protocol**. D219/D220 artifacts literally encode test-vector, uncommitted phases. They cannot be promoted to an authoritative commit by wrapping them in a stronger diagnostic. A future product release still needs a restart-safe best-effort **actual** commit point, Source→Destination Settings/Passphrase/Index switch, Manual Recovery, stale multi-device behavior, Wizard Run and installed Obsidian Desktop/Android/iOS acceptance. Do not activate Re-encryption or mark release gates passed on the strength of D221 alone. Keep old Source, frozen Backup, new orphan Destination, old passphrase and Git history. No GitHub Actions, Native Helper, branch deletion, force push, live Vault/Git mutation, merge or Release.
