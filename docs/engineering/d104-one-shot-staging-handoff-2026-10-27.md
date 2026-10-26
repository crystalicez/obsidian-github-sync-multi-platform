# D104 — One-shot encrypted WAL phase barrier after verified Backup

Date: 2026-10-27. **Internal safety hardening, NOT production-qualified.**

The owner-approved D90/D91 topology remains unchanged: independently writable old Source branch, immutable same-repository old-key Backup ref, independent encrypted zero-parent Destination branch. There is no global pause of other old-branch clients and no forced cross-device cutover. This change does not enable the user-facing Re-encryption Wizard.

## Finding and fix

D102's `beginAfterVerifiedBackup` accepted a precisely matched Backup-only WAL if the journal had no staged ciphertext receipts. A crashed or repeated Staging call **before the first Blob upload** — including an empty vault — could enter the Staging operation a second time with the same proof. A generation/verified-Backup check alone is insufficient to prove the phase never started.

D104 extends the **existing encrypted two-slot journal** with an optional `stageHandoffStarted` boolean in the authenticated encrypted payload; legacy D80/D81 journals default to `false`.

- `recordStagingHandoff(backup, expectedGeneration)` uses generation CAS, both-slot health checks and exactly one matching, fully observed Backup-ref intent. It rejects pending Git refs, staged blobs, prior handoffs, mismatched backup SHA/tree, and stale generations.
- The D102 `stageV4ReencryptionVaultObjectsWithJournal` path now **persists that one-shot stage boundary before ANY Git Blob upload**, even for zero files. A subsequent invocation cannot reuse the Backup-only state if Staging was already entered.
- Both D102 journal-bound destination publisher and D103 read-only destination-after-restart reconciler require the same `stageHandoffStarted:true` evidence before accepting persisted Blob receipts and pending Destination ref. Staged object counts and full ciphertext readback still require exact agreement.
- Older D80 standalone blob-only staging and recovery tests remain compatible. The new marker does **not** prove all Staging files finished, give permission to publish, grant local cutover or confer filesystem power-loss durability.

## Actual checks

- Added a WAL unit test which starts a verified Backup, writes the stage handoff **with zero receipts**, reconstructs the journal as if after a process restart, and verifies no second handoff or substitution is possible. The test also establishes persistent `requiresRemoteRevalidation:true`, `permissionToPublish:false` and `cutoverAuthorized:false`.
- Updated the 3-branch simulation to explicitly record the one-shot handoff before journaled Git blob uploads. D102 staged-flow regression asserts the marker remains present after staging.
- Full local regression: **Fast 858/858 PASS**, **Recovery 79/79**, **Resource 11/11**, **Feasibility 136/136**; maximum-strict TypeScript, build, GitHub E2E compile-only (three bundles), package and metadata validation all PASS.
- These are offline tests and Windows local filesystem readback only; not credentialed live GitHub E2E, installed Obsidian Windows/macOS/Linux/mobile migration or a physical power-cut durability test.

## Remaining hard blockers

The first-public-release Re-encryption Wizard gate remains `blocked` with only migration topology approved. D86 Windows Node.js-only directory `fsync` still fails `EPERM`, so a successful `readFile` or no-op test WAL cannot establish durability. A trusted complete coordinator must bind the actual OS-held WAL, frozen Backup copy/provenance, fresh ciphertext staging, orphan Git commit/tree/ref publication, crash-safe initiating-device-only local branch/key/index cutover with rollback, and native installed two-device/mobile acceptance. Remote E2E requires a verified `GITHUB_E2E_EXPECTED_REPO_ID` in the ignored test settings. No bypass, native OS helper without owner architecture approval, or GitHub Actions.
