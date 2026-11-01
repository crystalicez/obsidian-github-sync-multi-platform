# D229 — Fresh live Git and persisted local preflight for a pending Cutover

Date: 2026-11-02. First-public-release Re-encryption Gate: **blocked**.

## Problem

D227 authenticates an encrypted *historical* Cutover Intent. D228 also rechecks persisted Obsidian Settings, active Source Index, orphan Destination Shadow, the WAL and prepared evidence against six signed snapshot digests. Neither verifies that the current remote frozen old-key Backup and new-key Destination still match that evidence **at the time a real Commit could begin**. Treating those historical local checks as current Git authorization would be a critical mistake.

## Bounded solution

`inspectV4FencedPendingCommitPreflightAfterRestart` composes three existing independent proof families under **one externally held initiating-device Owner Lease**, using borrowed (nonreacquired) inner leases:

- **D228**: validates the current persisted Source Settings and both Indexes against the authenticated D223 Candidate and D227 Intent after Restart.
- **D216**: re-reads and decrypts the full current frozen old-key Backup branch, including all Git Blob content, metadata and immutable tree/head identities.
- **D183**: re-derives the six-digest transaction contract from Source/Shadow/Prepared/WAL/Settings and checks the real new-key Destination Git commit/content (via D179).

D229 first rechecks D228, then reads the disk `contract.json` and rejects any transaction ID or migration identity mismatch. It runs D216 and D183 **twice** and requires both fresh derived D183 contracts to match the *exact stored D223 manifest*, while requiring consistent full-Backup file count and byte count. It finally reruns D228 and the manifest under the same owner lease, keeping Source/Shadow, old/new secrets, journal generation, Git reader methods and the exact physical Sync Fence pinned throughout.

A successful result is `full-live-commit-preflight-uncommitted`, and proves only that these observations agreed while the cooperative lease was held. Failure, interrupted reads, missing SecretStorage values, stale/foreign Manifest or Intent, moved Git ref, corrupted ciphertext, changed persisted Settings, unexpected active-selector residue, replaced reader methods, lost WAL or uncooperative holder yields `manual-recovery-required`.

**Every output has `localCutoverAuthorized=false`, `commitDecisionAuthorized=false`, `resumeSyncAuthorized=false`, `rollbackAuthorized=false`, `remoteWritesAuthorized=false`, and `oldPassphraseCleanupAuthorized=false`.** The module contains no adapter writes, Settings persistence, SecretStorage changes or Git mutation methods. No actual migration Run or live runtime selector uses this preflight yet.

## Remaining limits

The proof is best-effort and does not atomically lock noncooperating devices, protect against physical power loss or make a historical frozen Backup independent of the same GitHub repository. A Git branch could change immediately after the final read; the eventual commit writer must recheck its own preconditions.

D229 is **a prerequisite, not the authoritative Commit decision**. A future stage must introduce independently authenticated and restart-reconcilable committed Receipt/Selector, atomic-looking active Index+Settings+SecretStorage transition with explicit Manual Recovery on ambiguous writes, stale-client multi-device policy and installed Desktop/Android/iOS acceptance. Keep old Source independently writable, frozen Backup, orphan Destination, both passphrases and full Git history. No GitHub Actions, Native Helper, test-vault remote mutations, branch deletion, force push, merge or Release. Wizard Run stays Preview-only; the six pending release checks remain pending.
