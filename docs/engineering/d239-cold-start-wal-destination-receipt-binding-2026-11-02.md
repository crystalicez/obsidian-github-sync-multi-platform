# D239: Authenticate WAL receipts against complete Destination Git after restart

Date: 2026-11-02. Scope: isolated, read-only verification. Release stays blocked.

## Problem and contract

D237 authenticates the old-key, two-slot Re-encryption WAL against the saved D183 Cutover Snapshot Contract. D238 independently reads the current new-key Destination Git tree and matches all decrypted files to the saved local Shadow. The verifiers originally had no common comparison between the **ciphertext upload receipts recorded in the WAL** and the receipts used to prove every published Destination object. A valid WAL and a valid Destination scan could otherwise be observations of different object sets.

D239 adds an optional `expectedReceipts` input to `inspectV4ColdStartWalSnapshot`. When present, the D237 verifier requires the **complete** authenticated WAL receipt set to match by opaque path, Git blob SHA and byte length, with no duplicates, missing entries or extras. Receipt order is irrelevant. It checks the set during both authenticated encrypted WAL passes and rejects changes to the caller's expected receipt array during asynchronous reads. Existing D237 callers that do not supply receipts retain their prior behavior.

The new `inspectV4ColdStartWalDestination` combines this receipt binding with D238. Inputs are the caller-authenticated D183 contract, explicitly located original-key WAL reader, current new-key Destination Git/Shadow reader, and a caller-owned cooperative recovery lease and best-effort WAL checkpoint.

Within one caller-supplied lease, D239 checks the exact local Re-encryption Sync Fence, verifies a current D237 WAL with the **same receipt array as the D238 Git scan**, performs D238's two full Git/Shadow scans, and authenticates the WAL again. It brackets these with WAL checkpoints and Sync Fence checks. It also rechecks Git repository physical identity, current Destination ref, zero-parent commit/tree, default branch and SecretStorage after the second WAL scan. Any changed input, wrong receipt, corrupt WAL slot, moved Git ref, changed secret, missing fence, failed checkpoint or lost owner returns `manual-recovery-required`.

Success is only `authenticated-wal-and-destination-still-fenced`. The report has `walReceiptsBoundToDestination=true`, `completeDestinationContentsReverified=true`, **`completeOldBackupReverified=false`**, `powerLossDurabilityProven=false` and **all** Commit, Cutover, rollback, Sync, Git write and old-key cleanup permissions false. No code unlocks the Wizard or changes the active Runtime Index.

## Evidence and limits

Real-crypto tests construct a complete AES-GCM WAL with recorded Backup and Destination ref observations and ciphertext upload receipts, a multi-file new-key Git fixture including a chunked file, a true local Sync Fence and two local Index roots. Another regression copies the WAL and Index data to disposable **real Windows filesystem directories**, releases and reopens the Node WAL exclusive lock, uses the D164 best-effort checkpoint and verifies all original bytes remain untouched. Adversarial cases cover changed SHA, size, duplicate or extra object receipts, a different valid receipt order, WAL damage during Git read, fence/owner changes, receipt mutation, moved Git ref or changed SecretStorage after the last WAL read, missing checkpoint and reentrant lease.

The combined test does **not** make the simulated Git fixture a live GitHub E2E run. The complete old-key Frozen Backup proof of D236 is still separate and the D183 contract, original journal key, saved receipts, WAL filesystem root and physical repository identity must be supplied through an independently trusted owner-scoped startup path. The `withExclusiveRecoveryLease` callback is a **contract required of the caller**, not an OS lease automatically discovered or acquired by D239. No guarantee excludes uncooperative external disk writers or proves actual power-loss durability. The test on Windows does not establish mobile storage behavior or installed Obsidian acceptance.

## Next

D240 should establish actual, platform-aware storage and SecretStorage origins for a newly started Obsidian plugin instance, authenticate the old Backup and local routing HMAC/Settings evidence from D236, then pin that proof to the D239 contract under a real owner scope. Independently test manual recovery and stale-device behavior before considering the live Destination Runtime Index writer, Sync Fence removal or a first public release. Keep the owner-approved best-effort power-loss policy and Manual Recovery fallback.
