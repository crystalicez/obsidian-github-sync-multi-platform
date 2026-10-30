# D181 — Pin one-shot Sync Fence inputs and enforce trustworthy crash-triage holders

Date: 2026-10-31. Status: **internal security hardening and non-authorizing crash contract**; Re-encryption Wizard Preview-only; release gate **blocked**.

## Why D181 targets the actual security boundary

D180 introduced a useful post-crash read-only triage under the caller's cooperative initiating-device lease. However its return path directly trusted the value returned by an injected `withExclusiveInitiatorLease` holder. A holder that **never called** the body could return a previously obtained positive `source-prepared-uncommitted` report; another holder could invoke the body twice but return the first result, or replace the actual result with a synthetic one. Although none of those statuses grants Cutover, a false-positive triage could mislead subsequent recovery guidance.

D174's installed Runtime `armReencryptionSyncFence` also read `input.runId`, `input.destinationRepoId` and `input.assertExclusiveInitiatorLease()` through the **caller's mutable input object** at successive awaits. Input mutation could change the scope and the function that attested the cooperating lease before the fence's one-shot publication. An armed marker must be traceable to one originally pinned Run/Destination and one genuinely held initiator.

No architectural choice about a future committed transaction was made in D181. First, the integrity of the prerequisite *uncommitted* guards needed to be proved.

## Changes

- `src/lib/v4/runtime.ts`: pin `runId`, `destinationRepoId` and `initiatorLease` **before the first await**, immediately before reserving synchronous Sync quiescence. `assertPinned` now checks all three input fields on every awaited lease boundary along with the existing Source Settings/credential generation, adapter and activity checks. The D173 fence receives only the pinned values and pinned callback. A caller mutation fails closed with Manual Recovery; if it occurs after the marker is written, the marker persists and Runtime remains fenced/Watch disabled. No automatic unarm.
- `src/lib/v4/reencryption-fenced-local-crash-triage.ts`: the D180 reader now requires its holder to call the inspection body **exactly once**, and for the holder to return that exact body's report object, not a forged or skipped one. It checks the invocation count, exact output identity and pinned storage/settings/secret/methods **after** the holder resolves, preventing a positive result if the holder changes local context in its epilogue. Any mismatch returns `manual-recovery-required` with `fence-wal-or-storage-uncertain`. It never requests writes and still does not authorize Cutover, rollback, Resume Sync, Git writes or old key deletion.

## Crash-boundary contract and regression

Five D181 test cases expand `tests/v4/reencryption-prepared-selector-stage.test.ts` and `tests/v4/settings-secrets.test.ts`:

1. A cooperating holder that skips the body and fabricates a prior positive report, or runs the body then substitutes a destination-looking result, cannot certify recovery.
2. A holder that calls the inspection callback **twice** and returns the first good result is rejected, as are post-body changes to saved Settings and SecretStorage.
3. Exhaustive **24-case** local cutover matrix: Settings selection `source/destination` × Active Index selection `source/destination` × unexpected Selector/Receipt residue `absent/selector/receipt` × Prepared evidence `healthy/torn`. Every case independently checks the reason code and **all denial flags**, with zero inspector writes and byte-preserved evidence. Cases that look Destination-complete remain `destination-observed-without-commit-proof` only, never authority; a forged or authenticated future Selector and a proposed receipt marker remain manual-only.
4. D174 Runtime caller mutations of Run ID, Destination ref and lease callback during an awaited lease reject publication **before** any fence write and keep every Sync type paused.
5. A Run ID mutation **after** D173 writes the fence retains that ambiguous marker, disables Watch and refuses subsequent Sync; no automatic cleanup or retry.

The earlier D180 Windows reopened WAL/read-only triage, D179 full Source/Destination and D176 prepared evidence regressions remain passing.

## Verification

**Full Fast 1184/1184 PASS** (+5); Maximum Strict TypeScript, Production Build, Recovery and Feasibility PASS; Resource **11/11 PASS**; GitHub E2E compile-only **3 bundles PASS**; Release Metadata and Package validation PASS; bounded **100,000,000-byte** SHA-256 cryptographic soak PASS (digest equal to reference).

These are local tests with mock GitHub clients. No credentialed live GitHub migration or installed Obsidian Desktop/Mobile migration in this stage. Windows Node directory fsync is still unsupported: a best-effort WAL readback is **not** physical power-loss durability.

## Next real blockers

There is still **no authoritative committed Selector/Receipt**, no transactional Settings/SecretStorage/active-Index writer, and no safe automatic recovery path. The existing D142 hypothetical receipt and D147 authenticated Selector are **test vectors marked uncommitted**, not an authorization mechanism. The next stage should define a separately authenticated, run-bound **committed** record contract and crash-boundary state transitions with explicit owner-approved best-effort limits, without quietly converting any current read-only positive result into permission to cut over. On the Option-A topology the immutable Source and its independent Shadow must not be destructively repurposed. A future real writer must also resolve ordering across physical local persistence and coordinate stale multi-device writers, release the fence only after independently verified safe completion, and provide Manual Recovery UX.

Keep `docs/release-gates/reencryption-wizard.json` `blocked`, Wizard Preview-only, Source/Backup/history and old passphrase intact. No Native Helper, GitHub Actions, merge, release or automatic cleanup.
