# D166: Best-effort frozen Backup creation and pending-ref recovery

Date: 2026-10-30. Scope: internal Re-encryption Backup phase on Node desktop. No public Wizard execution, live GitHub E2E, local device cutover, or release.

## Problem

The D164/D165 best-effort WAL evidence had no path into the actual Re-encryption ref coordinator. Its existing frozen Backup writer required a strict directory-fsync durability callback, which fails on Windows Node with EPERM. The owner explicitly accepted best-effort power-loss behavior with prior risk warning and Manual Recovery. Replacing the existing callback with a no-op would permit remote mutations with an unauthenticated, missing or stale WAL intent.

## Implementation

`createV4BestEffortJournaledFrozenBackup()` is a separate, explicit-acknowledgement entrypoint in `reencryption-ref-journal-coordinator.ts`. It uses the existing create-only Backup ref writer and exact pinned immutable Source identity. Before and after the one-shot encrypted WAL ref intent, before the GitHub POST boundary, and again after full Backup ciphertext/AES-GCM readback, it verifies the held cooperative WAL lease and runs D165's alternating, generation-pinned WAL readback and AES-GCM authentication protocol. A stale generation, damaged sibling slot, residue, changed journal, lost lock or failed checkpoint refuses mutation and keeps recovery evidence.

The strict `createV4JournaledFrozenBackup()` is unchanged in default behavior. The low-level Backup verifier now has two explicitly named entrypoints which call the same create-and-readback implementation: existing strict `assertDurableBackupIntent`, or best-effort `assertBestEffortBackupIntent` with the literal risk-acknowledgement token. Neither claims physical durability. The old Source branch remains independent and writable. The verified Backup is frozen to the Source's immutable SHA and tree, not a later moving Source HEAD.

`reconcileV4PendingFrozenBackupWithJournalBestEffort()` uses the same authenticated WAL guard with the existing exact pending-intent recovery process. It **does not replay the Backup create GitHub POST**. It reads GitHub to authenticate the exact expected ref/commit/tree and full old-key encrypted data, and only after success records the verified observation in the local encrypted WAL. A mismatched, absent or uncertain ref retains the unresolved intent. Both the success and recovery reports still deny Destination publication and initiating-device cutover.

## Tests

Added D166 regressions in `tests/v4/reencryption-trusted-loader.test.ts` covering the complete mocked GitHub Backup create/readback with a real AES-GCM journal, missing risk acknowledgement before any I/O, failure immediately after WAL intent persistence (pending intent remains and no Git POST), unknown GitHub create outcome with no blind retry, separate recovery via read-only GitHub reconciliation without a second create, wrong remote ref retaining unresolved intent, and a real Windows Node WAL filesystem run that makes one safe mocked-remote Backup ref with best-effort readback. Existing strict fsync refusal and one-shot mutation tests still pass. All simulation uses disposable files, not a user Vault.

Verification: focused source/Backup suite exit 0, full Fast exit 0, Recovery exit 0, Feasibility exit 0, Resource 11/11, maximum strict TypeScript and production build exit 0, GitHub E2E compile-only three bundles, package/metadata validators exit 0, SHA-matched bounded 100,000,000-byte cryptographic soak exit 0.

## Remaining blockers

The internal best-effort Backup API is **not wired into the Wizard**, and its exact typed acknowledgement must eventually be bound to informed user confirmation. A successful Backup is not evidence of a complete Destination migration or installed-device restore. Best-effort Git blob staging, orphan candidate publication, full integrity/recovery, local Settings/SecretStorage/Source/Shadow Index cutover, installed multi-platform tests and real disposable GitHub qualification remain open. `docs/release-gates/reencryption-wizard.json` stays `blocked`; do not mark `safePreviewAndBackup` passed on unit/mock tests alone. There is still no power-loss guarantee, Native Helper, GitHub Actions, or old-key deletion.
