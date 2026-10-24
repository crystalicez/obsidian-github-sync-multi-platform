# D81 — Bind encrypted upload-intent WAL to complete V4 re-encryption staging

Date: 2026-10-24 (Asia/Bangkok). Base committed/pushed D80 `4ce9e990f692e63bb5ad1e7caeaf53454f525141`.

## Boundary: staging only

The owner approved option A (new orphan-root branch within the SAME physical GitHub repository; retain source for recovery; independently test a second device before cutover). The owner has NOT decided whether all remaining old-branch clients must freeze Sync during migration and later cutover. D81 does **not** select such a policy, does not write a migration ref, does not modify a user vault, and cannot authorize publishing or switching devices.

The new `src/lib/v4/reencryption-journaled-staging.ts` exports `stageV4ReencryptionVaultObjectsWithJournal`. It composes **D79 authenticated per-file re-encryption staging and whole-vault parity** with **D80 two-slot encrypted upload WAL**. Both Git immutable-object staging and local WAL storage are injected callback/adapter dependencies; **there is no live GitHub or native Obsidian integration in D81**.

## Exact call order and fail-closed behavior

1. Check that the read-only journal identity matches the approved **source pinned commit SHA and destination repoId**. D80 journal identity is now runtime-frozen to prevent accidental mutation of these coordinates.
2. Demand a trusted **exclusive stage lease** check; authenticate the complete source HEAD/index/shards before creating any journal, then observe the source HEAD again. A platform cross-process lock must later implement the lease; a no-op callback is **not** a production lock.
3. Reject every existing previous journal (even a valid empty run) rather than auto-resume or truncate it. Start a fresh D80 journal only when both slots are absent.
4. For each encrypted object emitted by D79, check cancellation and the lease, compute actual **Git blob SHA-1** and record its SHA, opaque object path and encrypted byte length as a D80 **upload intent** before executing the injected Git Blob upload callback.
5. After journal intent write, check cancellation **immediately before** the upload; after GitHub's returned SHA, check cancellation and lease again, and verify exact expected Git Blob SHA and an independent post-callback hash of the still-live ciphertext bytes. Only then append a confirmed WAL receipt with matching expected generation.
6. Any timeout, cancellation, changed ciphertext, wrong Git SHA, WAL write failure, lease loss or changed source aborts the entire staging attempt; a pending intent is never silently converted to success. An operation that left any WAL state will be rejected on retry until an explicit remote reconciliation/recovery flow exists.
7. Only after D79 completely finalizes every single/pack/multipart input and D78 finds full-vault parity, compare WAL reread receipt count/order/SHA/size/path with the finalized D79 receipt list. The final result retains D79 `permissionToPublish:false`, `destinationReadbackVerified:false`, and `cutoverAuthorized:false`. WAL snapshots retain `requiresRemoteRevalidation:true`.

A previous valid receipt does **not** authenticate GitHub server persistence; a staging callback may lie or the object may be unreachable. No ref publication, metadata head upload, backup proof, second-device restore or automatic resume has been implemented.

## Failure discovered during regression

A cancellation injected **after the exclusive lease check but before the actual upload** initially still allowed one upload callback to execute. Fixed by checking the AbortSignal immediately before invoking `stageImmutableObject` and after the following lease check. This protects the cancellation ordering in the current JS flow, **not** network-level cancellation of a GitHub write already in flight.

## Verification

- Real V4 encrypted D79 fixture, with a separate D80 journal in a local memory adapter.
- D79 + D81 focused tests **13/13 passed**, D80 journal tests **8/8 passed**.
- Includes: two-file Unicode/empty successful staging and no exposed file names in plaintext WAL, intent recorded before the upload callback, SHA-correct immutable receipt after upload, ambiguous timeout leaving an unresolved intent across retries, mismatched Git SHA, invalid source shards, wrong journal source binding, lost exclusive lease, user cancellation after intent and before upload causing **zero network writes**, and journal binding frozen against runtime mutation.
- Maximum strict TypeScript build, full fast/resource/recovery/feasibility suites, three GitHub E2E bundle compilation, metadata/package validators passed in the isolated worktree. No GitHub Actions and no live E2E mutation.

## Unresolved production blockers

- D80 is still a **pluggable WAL**; `V4LocalIndexAdapter.write()` alone does not prove fsync/atomic disk durability or a cross-process/device exclusive writer. Power loss, older slot fallback, ambiguous GitHub errors and mobile app suspension need platform-native acceptance.
- D80's 2 MiB bounded journal is not paginated for large vaults. Capacity exhaustion must fail closed.
- Staging SHA receipts do not establish remote blob reachability, tree completeness or a verified independent backup; exact-commit GitHub readback remains mandatory.
- No automatic resume/reconcile semantics or secure recovery UI exists; D81 deliberately blocks a retry if WAL data is present.
- Old-branch Sync freeze/cutover policy is still awaiting explicit owner approval. The 7-check Re-encryption Wizard release gate remains **blocked**, only owner-approved topology passed, other six pending.

## Next safe step

Design and test **read-only** remote immutable Git object receipt reconciliation, especially timeout/404/ambiguous eventual consistency and keeping unresolved intents in manual-review state; then platform-specific WAL durability and lock implementation, verified backup, exact orphan-root readback, and independent installed Obsidian second-device restore. No production migration writes or device cutover before these gates.
