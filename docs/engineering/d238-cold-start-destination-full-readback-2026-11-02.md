# D238 — Complete Destination Git and local Shadow readback after a cold start

Date: 2026-11-02. This component is read-only and does not change the first-release gate.

## What D238 proves

D236 can authenticate every live old-key Frozen Backup object. D237 can independently authenticate a two-slot encrypted WAL against the D183 Cutover Contract when its trusted storage root and original key are already supplied. Neither result alone verifies that the new-key Destination branch still contains the exact encrypted files reflected by the initiator's local Shadow.

`inspectV4ColdStartDestination` accepts an explicitly supplied, independently authenticated D183 Cutover Snapshot Contract, a fresh read-only local Index adapter, a current GitHub reader scoped to the Destination branch, the physical GitHub repository ID separately pinned from the verified old Backup, a trusted set of finalized D79 object receipts/source and expected destination configuration, a live SecretStorage reader and an owner assertion.

It requires the caller's pinned physical ID to match the finalized destination plan and current GitHub repository identity. It also checks the full repository name, branch, default-branch safety, exact ref SHA, zero-parent commit and exact **tree SHA from the D183 contract**. It loads the Source and Destination Shadow from separate local index roots and requires their full serialized hashes to match the D183 Source/Shadow hashes; it also checks the device ID and pinned Source/Destination commits. No active Index is changed.

It then invokes the existing D137/D83 `verifyV4ReencryptionShadowAgainstDestination` **twice** through a read-only local adapter whose write/mkdir operations throw. D83 verifies every committed encrypted Config/HEAD/shard, Git blob SHA, object receipt, complete decrypted plaintext SHA/size and orphan branch tree topology. D238 brackets both full scans with fresh Source/Shadow reads, Git ref/repository/default branch checks, and SecretStorage/reader identity checks. Both scans must agree on file count and total verified plaintext bytes. Exceptions, drift or damaged objects yield `manual-recovery-required`.

The success report is only `complete-destination-still-fenced`. It never authorizes publication, Commit, Cutover, rollback, Sync, remote mutation or old passphrase cleanup. `coldStartWalReverified` is **always false**: D238 does not open a trusted D237 WAL root or attest the provenance of the caller-supplied object receipts. The input D183 contract, old source configuration and finalized object receipts **must** be authenticated by a separate owner-scoped chain before any joint recovery conclusion. The current result is a useful independent Destination/Shadow observation, not that joint conclusion. The owner callback checks instance liveness but does not acquire an exclusive migration lease or protect against an uncooperative disk/editor writer; the final D239 composition must supply those controls separately.

## Evidence and limitations

Tests reuse the real AES-GCM D83 fixture with a large chunked file and Unicode path. D238 checks positive full double scan with no local writes; wrong SecretStorage, Source/Shadow hash, Git branch/default, physical repository or immutable tree; and Git ref movement, changed default-branch observation, swapped cancellation signal, changed SecretStorage or owner loss during full scan. A separate test serializes both Index roots into disposable real Windows files, opens a **new read-only filesystem reader**, and authenticates the same Git content without rewriting the files. This tests local disk readback, **not** installed Obsidian or physical power-loss durability.

The production Wizard remains Preview-only. No automatic startup network scan, live GitHub E2E mutation, native Settings change, Native Helper, GitHub Actions, forced Git ref change, branch removal, Sync Fence lift or release is included. Additional full reads cost GitHub API calls and KDF work, so they are reserved for an explicit Recovery check.

## Next

D239 must independently reconstruct the owner-scoped WAL root and source/new passphrase origin on each real supported platform, use D237 to authenticate current WAL receipts, join those receipts and the D236 old-key Backup proof to D238, and detect changes between the combined checks. Only after installed Obsidian qualification and verified transition semantics can an active mutable Destination Runtime Index or Sync Fence release be considered. Existing best-effort power-loss + Manual Recovery owner policy remains unchanged.
